/**
 * Browse / classify endpoints for the three-level taxonomy.
 *
 *   GET    /categories/tree                    — full taxonomy
 *   GET    /categories/:slug/items?page&limit  — items under a node (any level)
 *   GET    /categories/uncategorized           — items not yet placed
 *   GET    /categories/coverage                — counts: total / classified / by source
 *   POST   /categories/classify                — admin: rule-classify a batch (SSE)
 *   POST   /categories/:nodeId/assign          — admin: manually assign one item
 *
 * The classifier is rule-first (see taxonomyClassifier.ts). The endpoint
 * accepts an `useAi: true` flag that wires the AI fallback for unmatched
 * rows; this is opt-in to avoid surprise OpenAI charges from a stray call.
 */

import { Router } from "express";
import { eq, sql, inArray, and } from "drizzle-orm";
import {
  db,
  inventoryTable,
  categoryNodeTable,
  inventoryCategoryTable,
} from "@workspace/db";
import { verifyAdminToken } from "./admin";
import {
  classifyItem,
  buildNodeIndex,
  type ClassifierNode,
} from "../utils/taxonomyClassifier";

const router = Router();

// ── Admin auth (mirrors the pattern used in inventory.ts/adminUpload.ts) ─
function requireAdminAuth(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
): void {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    res.status(503).json({ error: "Admin access is not configured. Set ADMIN_PASSWORD." });
    return;
  }
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || !verifyAdminToken(token, adminPassword)) {
    res.status(401).json({ error: "Unauthorized: valid admin token required" });
    return;
  }
  next();
}

// ── Helpers ─────────────────────────────────────────────────────────────
async function loadAllNodes(): Promise<ClassifierNode[]> {
  const rows = await db.select().from(categoryNodeTable);
  return rows.map(r => ({
    id: r.id,
    parentId: r.parentId ?? null,
    level: r.level,
    name: r.name,
    slug: r.slug,
  }));
}

interface TreeNode {
  id: number;
  slug: string;
  name: string;
  level: string;
  sortOrder: number;
  itemCount: number;
  children: TreeNode[];
}

/** Build a nested tree (categories → subcategories → types) with item counts. */
async function buildTree(): Promise<TreeNode[]> {
  const [allNodes, counts] = await Promise.all([
    db.select().from(categoryNodeTable).orderBy(categoryNodeTable.sortOrder, categoryNodeTable.name),
    db
      .select({
        nodeId: inventoryCategoryTable.categoryNodeId,
        count: sql<number>`count(*)::int`,
      })
      .from(inventoryCategoryTable)
      .groupBy(inventoryCategoryTable.categoryNodeId),
  ]);

  const directCounts = new Map<number, number>();
  for (const c of counts) directCounts.set(c.nodeId, Number(c.count));

  const byId = new Map<number, TreeNode>();
  for (const n of allNodes) {
    byId.set(n.id, {
      id: n.id,
      slug: n.slug,
      name: n.name,
      level: n.level,
      sortOrder: n.sortOrder,
      itemCount: directCounts.get(n.id) ?? 0,
      children: [],
    });
  }

  // Wire children
  const roots: TreeNode[] = [];
  for (const n of allNodes) {
    const node = byId.get(n.id)!;
    if (n.parentId == null) {
      roots.push(node);
    } else {
      const parent = byId.get(n.parentId);
      if (parent) parent.children.push(node);
    }
  }

  // Roll up counts: a parent's itemCount = sum of its descendants' direct counts
  const rollUp = (n: TreeNode): number => {
    if (n.children.length === 0) return n.itemCount;
    const childTotal = n.children.reduce((acc, c) => acc + rollUp(c), 0);
    n.itemCount = n.itemCount + childTotal; // direct + descendants
    return n.itemCount;
  };
  for (const r of roots) rollUp(r);

  return roots;
}

// ── GET /categories/tree ────────────────────────────────────────────────
router.get("/tree", async (_req, res) => {
  try {
    const tree = await buildTree();
    res.json({ tree });
  } catch (err) {
    console.error("[categories/tree] failed:", err);
    res.status(500).json({ error: "Failed to build taxonomy tree" });
  }
});

// ── GET /categories/coverage ────────────────────────────────────────────
router.get("/coverage", async (_req, res) => {
  try {
    const [[totalRow], [classifiedRow], bySource] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(inventoryTable),
      db
        .select({
          classified: sql<number>`count(distinct ${inventoryCategoryTable.inventoryId})::int`,
        })
        .from(inventoryCategoryTable),
      db
        .select({
          source: inventoryCategoryTable.classifiedBy,
          count: sql<number>`count(distinct ${inventoryCategoryTable.inventoryId})::int`,
        })
        .from(inventoryCategoryTable)
        .groupBy(inventoryCategoryTable.classifiedBy),
    ]);

    const total = Number(totalRow?.total ?? 0);
    const classified = Number(classifiedRow?.classified ?? 0);
    res.json({
      total,
      classified,
      uncategorized: total - classified,
      bySource: bySource.reduce<Record<string, number>>((acc, r) => {
        acc[r.source] = Number(r.count);
        return acc;
      }, {}),
    });
  } catch (err) {
    console.error("[categories/coverage] failed:", err);
    res.status(500).json({ error: "Failed to compute coverage" });
  }
});

// ── GET /categories/uncategorized ───────────────────────────────────────
router.get("/uncategorized", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1")) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50")) || 50));
    const offset = (page - 1) * limit;

    const items = await db.execute(sql`
      SELECT i.* FROM inventory i
      WHERE NOT EXISTS (
        SELECT 1 FROM inventory_category ic WHERE ic.inventory_id = i.id
      )
      ORDER BY i.vendor, i.catalog
      LIMIT ${limit} OFFSET ${offset}
    `);

    const totalResult = await db.execute(sql`
      SELECT count(*)::int as total FROM inventory i
      WHERE NOT EXISTS (
        SELECT 1 FROM inventory_category ic WHERE ic.inventory_id = i.id
      )
    `);
    const totalRow = (totalResult as { rows: Record<string, unknown>[] }).rows[0];

    const rows = (items as { rows: Record<string, unknown>[] }).rows.map(rowToInventoryItem);
    res.json({
      items: rows,
      total: Number(totalRow?.["total"] ?? 0),
      page,
      limit,
    });
  } catch (err) {
    console.error("[categories/uncategorized] failed:", err);
    res.status(500).json({ error: "Failed to list uncategorized items" });
  }
});

// ── GET /categories/:slug/items ─────────────────────────────────────────
router.get("/:slug/items", async (req, res) => {
  try {
    const slug = String(req.params["slug"] ?? "").trim();
    if (!slug) return void res.status(400).json({ error: "slug is required" });

    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1")) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50")) || 50));
    const offset = (page - 1) * limit;

    // Resolve slug → node, then collect this node + all descendant ids.
    const [node] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.slug, slug))
      .limit(1);
    if (!node) return void res.status(404).json({ error: "Category not found" });

    const allNodes = await db.select().from(categoryNodeTable);
    const childrenByParent = new Map<number, number[]>();
    for (const n of allNodes) {
      if (n.parentId == null) continue;
      const arr = childrenByParent.get(n.parentId) ?? [];
      arr.push(n.id);
      childrenByParent.set(n.parentId, arr);
    }
    const collect = (rootId: number): number[] => {
      const out = [rootId];
      const stack = [rootId];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const child of childrenByParent.get(cur) ?? []) {
          out.push(child);
          stack.push(child);
        }
      }
      return out;
    };
    const nodeIds = collect(node.id);

    // Pull inventory matching any assignment to a descendant node id.
    const assignmentRows = await db
      .select({ inventoryId: inventoryCategoryTable.inventoryId })
      .from(inventoryCategoryTable)
      .where(inArray(inventoryCategoryTable.categoryNodeId, nodeIds));
    const itemIds = Array.from(new Set(assignmentRows.map(r => r.inventoryId)));
    const total = itemIds.length;

    if (total === 0) {
      return void res.json({ items: [], total: 0, page, limit, node: { slug: node.slug, name: node.name, level: node.level } });
    }

    const pageIds = itemIds.slice(offset, offset + limit);
    const items = await db
      .select()
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, pageIds))
      .orderBy(inventoryTable.vendor, inventoryTable.catalog);

    res.json({
      items: items.map(item => ({
        ...item,
        binLocations: item.binLocations ?? [],
        aiKeywords: item.aiKeywords ?? [],
      })),
      total,
      page,
      limit,
      node: { slug: node.slug, name: node.name, level: node.level },
    });
  } catch (err) {
    console.error("[categories/:slug/items] failed:", err);
    res.status(500).json({ error: "Failed to list items in category" });
  }
});

// ── POST /categories/:nodeId/assign ─────────────────────────────────────
router.post("/:nodeId/assign", requireAdminAuth, async (req, res) => {
  try {
    const nodeId = parseInt(String(req.params["nodeId"] ?? "0"));
    if (!Number.isFinite(nodeId) || nodeId <= 0) {
      return void res.status(400).json({ error: "nodeId must be a positive integer" });
    }
    const { inventoryId } = req.body as { inventoryId?: number };
    if (!Number.isFinite(inventoryId) || (inventoryId ?? 0) <= 0) {
      return void res.status(400).json({ error: "inventoryId is required" });
    }

    // Replace any prior assignment for this item.
    await db.delete(inventoryCategoryTable).where(eq(inventoryCategoryTable.inventoryId, inventoryId!));
    await db.insert(inventoryCategoryTable).values({
      inventoryId: inventoryId!,
      categoryNodeId: nodeId,
      confidence: "1.0000",
      classifiedBy: "manual",
    });
    res.json({ ok: true, inventoryId, nodeId });
  } catch (err) {
    console.error("[categories/assign] failed:", err);
    res.status(500).json({ error: "Failed to assign category" });
  }
});

// ── POST /categories/classify ───────────────────────────────────────────
router.post("/classify", requireAdminAuth, async (req, res) => {
  try {
    const { ids, onlyUnclassified = true, useAi = false } = req.body as {
      ids?: number[];
      onlyUnclassified?: boolean;
      useAi?: boolean;
    };

    const nodes = await loadAllNodes();
    if (nodes.length === 0) {
      return void res.status(503).json({ error: "Taxonomy not seeded — run seed first" });
    }
    const index = buildNodeIndex(nodes);

    let toClassify;
    if (ids?.length) {
      toClassify = await db
        .select()
        .from(inventoryTable)
        .where(inArray(inventoryTable.id, ids));
    } else if (onlyUnclassified) {
      const result = await db.execute(sql`
        SELECT i.* FROM inventory i
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_category ic WHERE ic.inventory_id = i.id
        )
        ORDER BY i.id
        LIMIT 5000
      `);
      toClassify = (result as { rows: Record<string, unknown>[] }).rows.map(rowToInventoryItem);
    } else {
      toClassify = await db.select().from(inventoryTable).limit(5000);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.write(`data: ${JSON.stringify({ progress: 0, total: toClassify.length })}\n\n`);

    let classified = 0;
    let unmatched = 0;
    let aiUsed = 0;

    for (let i = 0; i < toClassify.length; i++) {
      const item = toClassify[i]!;
      const result = classifyItem(
        {
          id: item.id,
          vendor: item.vendor,
          catalog: item.catalog,
          description: item.description,
          aiKeywords: item.aiKeywords ?? [],
        },
        index,
      );

      let nodeSlug: string | null = result?.typeSlug ?? null;
      let confidence = result?.confidence ?? 0;
      let classifiedBy: "rule" | "ai" = "rule";

      if (!nodeSlug && useAi) {
        // AI fallback hook — left as a no-op here so the seed run is fast and
        // costs nothing. Wire to your AI helper if cost/latency are acceptable.
        // const aiResult = await aiClassify(item, nodes);
        // if (aiResult) { nodeSlug = aiResult.slug; confidence = aiResult.confidence; classifiedBy = "ai"; aiUsed++; }
      }

      if (nodeSlug) {
        const node = index.bySlug.get(nodeSlug);
        if (node) {
          // Replace any existing assignment so re-runs are idempotent.
          await db.delete(inventoryCategoryTable).where(eq(inventoryCategoryTable.inventoryId, item.id));
          await db.insert(inventoryCategoryTable).values({
            inventoryId: item.id,
            categoryNodeId: node.id,
            confidence: confidence.toFixed(4),
            classifiedBy,
          });
          classified++;
        } else {
          unmatched++;
        }
      } else {
        unmatched++;
      }

      if ((i + 1) % 25 === 0 || i === toClassify.length - 1) {
        res.write(
          `data: ${JSON.stringify({
            progress: i + 1,
            total: toClassify.length,
            classified,
            unmatched,
            aiUsed,
          })}\n\n`,
        );
      }
    }

    res.write(
      `data: ${JSON.stringify({
        done: true,
        total: toClassify.length,
        classified,
        unmatched,
        aiUsed,
      })}\n\n`,
    );
    res.end();
  } catch (err) {
    console.error("[categories/classify] failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Classification failed" });
    } else {
      res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      res.end();
    }
  }
});

// ── helpers ──────────────────────────────────────────────────────────────
function rowToInventoryItem(row: Record<string, unknown>): typeof inventoryTable.$inferSelect {
  return {
    id: Number(row["id"]),
    vendor: String(row["vendor"] ?? ""),
    catalog: String(row["catalog"] ?? ""),
    description: String(row["description"] ?? ""),
    binLocations: Array.isArray(row["bin_locations"]) ? (row["bin_locations"] as string[]) : [],
    aiKeywords: Array.isArray(row["ai_keywords"]) ? (row["ai_keywords"] as string[]) : [],
    enrichedAt: row["enriched_at"] instanceof Date ? (row["enriched_at"] as Date) : null,
    createdAt: row["created_at"] instanceof Date ? (row["created_at"] as Date) : new Date(0),
    updatedAt: row["updated_at"] instanceof Date ? (row["updated_at"] as Date) : new Date(0),
  };
}

// suppress unused-import warning when AI hook stays disabled
void and;

export default router;
