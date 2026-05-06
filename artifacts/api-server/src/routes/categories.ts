/**
 * Categories routes — browse + classify against the three-level
 * taxonomy (category → subcategory → type) backed by `category_node`
 * + `inventory_category`. Includes coverage stats so admins can
 * monitor how much of the inventory is still uncategorised.
 */
// Hybrid classifier: rule pass first (taxonomyClassifier), AI fallback for
// unmatched rows when useAi is on (defaults to true), Uncategorized leaf
// otherwise.

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
import { matchesChipFilters } from "../utils/searchHelpers";
import { aiClassifyBatch, type AiClassifyAllowed } from "../utils/aiClassify";
import { UNCATEGORIZED_TYPE_SLUG } from "../seed/taxonomy";

// 16 chip dimensions (mirrors CHIP_DIMS_SERVER in inventory.ts)
const BROWSE_CHIP_KEYS = [
  "category", "amperage", "colorChip", "manufacturer", "sizeChip", "rating",
  "wireType", "wireGauge", "conduitType", "conduitSize", "boxType",
  "boxGangCount", "mountingType", "environment", "voltage", "poleCount",
] as const;

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

// ── GET /categories/:slugOrId/items ─────────────────────────────────────
// Items belonging to the node (or any descendant). Supports the same 16
// chip-filter dimensions as POST /inventory/search and a confidenceThreshold.
// :slugOrId may be a slug ("breakers") or a numeric node id ("42").
async function listItemsForNode(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  try {
    const raw = String(req.params["slugOrId"] ?? req.params["nodeId"] ?? req.params["slug"] ?? "").trim();
    if (!raw) { res.status(400).json({ error: "node identifier is required" }); return; }

    const page = Math.max(1, parseInt(String(req.query["page"] ?? "1")) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50")) || 50));
    const offset = (page - 1) * limit;
    const confidenceThreshold = Math.max(0, Math.min(100, parseInt(String(req.query["confidenceThreshold"] ?? "0")) || 0));

    // Resolve identifier → node (numeric → id, otherwise → slug).
    const asNum = parseInt(raw, 10);
    const where = Number.isFinite(asNum) && String(asNum) === raw
      ? eq(categoryNodeTable.id, asNum)
      : eq(categoryNodeTable.slug, raw);
    const [node] = await db.select().from(categoryNodeTable).where(where).limit(1);
    if (!node) { res.status(404).json({ error: "Category not found" }); return; }

    // Collect this node + all descendants.
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
        for (const child of childrenByParent.get(cur) ?? []) { out.push(child); stack.push(child); }
      }
      return out;
    };
    const nodeIds = collect(node.id);

    // Build active chip filters from query string (same shape as /inventory/search).
    const activeChipFilters: Array<{ key: string; value: string }> = [];
    for (const k of BROWSE_CHIP_KEYS) {
      const v = String(req.query[k] ?? "").trim();
      if (v) activeChipFilters.push({ key: k, value: v });
    }

    // Items whose assignment lands inside our node-id set, with optional confidence floor.
    const assignmentRows = await db
      .select({
        inventoryId: inventoryCategoryTable.inventoryId,
        confidence: inventoryCategoryTable.confidence,
      })
      .from(inventoryCategoryTable)
      .where(inArray(inventoryCategoryTable.categoryNodeId, nodeIds));
    const minConf = confidenceThreshold / 100;
    const itemIds = Array.from(new Set(
      assignmentRows
        .filter(r => Number(r.confidence) >= minConf)
        .map(r => r.inventoryId)
    ));

    if (itemIds.length === 0) {
      res.json({ items: [], total: 0, page, limit, node: { id: node.id, slug: node.slug, name: node.name, level: node.level } });
      return;
    }

    // Pull all candidate items (we need the full row to apply chip filters).
    const candidates = await db
      .select()
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, itemIds))
      .orderBy(inventoryTable.vendor, inventoryTable.catalog);

    // Apply chip filters (re-uses Search semantics).
    const filtered = activeChipFilters.length > 0
      ? candidates.filter(it => matchesChipFilters({
          vendor: it.vendor,
          catalog: it.catalog,
          description: it.description,
          aiKeywords: it.aiKeywords ?? [],
        }, activeChipFilters))
      : candidates;

    const total = filtered.length;
    const pageItems = filtered.slice(offset, offset + limit);

    res.json({
      items: pageItems.map(item => ({
        ...item,
        binLocations: item.binLocations ?? [],
        aiKeywords: item.aiKeywords ?? [],
      })),
      total,
      page,
      limit,
      node: { id: node.id, slug: node.slug, name: node.name, level: node.level },
    });
  } catch (err) {
    console.error("[categories/:slugOrId/items] failed:", err);
    res.status(500).json({ error: "Failed to list items in category" });
  }
}

router.get("/:slug/items", listItemsForNode);
// Spec-compliant alias: GET /categories/{nodeId}/parts (id-keyed)
router.get("/:nodeId/parts", listItemsForNode);

// ── PATCH /categories/:nodeId ───────────────────────────────────────────
// Admin: rename, re-parent, or change sort order.
router.patch("/:nodeId", requireAdminAuth, async (req, res) => {
  try {
    const nodeId = parseInt(String(req.params["nodeId"] ?? "0"));
    if (!Number.isFinite(nodeId) || nodeId <= 0) {
      return void res.status(400).json({ error: "nodeId must be a positive integer" });
    }
    const { name, parentId, sortOrder } = req.body as {
      name?: string;
      parentId?: number | null;
      sortOrder?: number;
    };

    // Wrap validation + update in a single transaction so a failure between
    // the parent-existence check and the UPDATE can't leave inconsistent state.
    const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.id, nodeId))
      .limit(1);
    if (!existing) return { status: 404 as const, body: { error: "Node not found" } };

    // Guard 1: enforce the legal three-level shape. A category must be a
    // root, a subcategory must hang under a category, a type must hang
    // under a subcategory. Anything else would let the browse drill-down
    // see (e.g.) a type under a type.
    const requiredParentLevel = LEGAL_PARENT_LEVEL[existing.level as "category" | "subcategory" | "type"];
    if (parentId === undefined) {
      // no-op
    } else if (parentId === null) {
      if (requiredParentLevel !== null) {
        return { status: 400 as const, body: { error: `A ${existing.level} must have a ${requiredParentLevel} parent` } };
      }
    } else {
      if (requiredParentLevel === null) {
        return { status: 400 as const, body: { error: `A category must be a root node (parentId must be null)` } };
      }
      const [parentRow] = await tx
        .select()
        .from(categoryNodeTable)
        .where(eq(categoryNodeTable.id, parentId))
        .limit(1);
      if (!parentRow) return { status: 404 as const, body: { error: "parentId does not exist" } };
      if (parentRow.level !== requiredParentLevel) {
        return { status: 400 as const, body: { error: `A ${existing.level} must hang under a ${requiredParentLevel}, not a ${parentRow.level}` } };
      }
    }

    // Guard 2: don't let a node become its own ancestor.
    if (parentId != null) {
      if (parentId === nodeId) {
        return { status: 400 as const, body: { error: "A node cannot be its own parent" } };
      }
      const all = await tx.select().from(categoryNodeTable);
      const parentOf = new Map(all.map(n => [n.id, n.parentId]));
      let cur: number | null = parentId;
      const seen = new Set<number>();
      while (cur != null) {
        if (cur === nodeId) {
          return { status: 400 as const, body: { error: "Re-parent would create a cycle" } };
        }
        if (seen.has(cur)) break;
        seen.add(cur);
        cur = parentOf.get(cur) ?? null;
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date(), source: "manual" };
    if (typeof name === "string" && name.trim()) updates["name"] = name.trim();
    if (parentId !== undefined) updates["parentId"] = parentId;
    if (typeof sortOrder === "number" && Number.isFinite(sortOrder)) updates["sortOrder"] = sortOrder;

    await tx.update(categoryNodeTable).set(updates).where(eq(categoryNodeTable.id, nodeId));
    const [updated] = await tx.select().from(categoryNodeTable).where(eq(categoryNodeTable.id, nodeId)).limit(1);
    return { status: 200 as const, body: { node: updated } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[categories/PATCH] failed:", err);
    res.status(500).json({ error: "Failed to update node" });
  }
});

// ── POST /categories/merge ──────────────────────────────────────────────
// Admin: move all part assignments from `sourceId` to `targetId`, then
// delete the (now empty) source node. Both nodes must be at the same level.
router.post("/merge", requireAdminAuth, async (req, res) => {
  try {
    const { sourceId, targetId } = req.body as { sourceId?: number; targetId?: number };
    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || sourceId === targetId) {
      return void res.status(400).json({ error: "sourceId and targetId must be distinct positive integers" });
    }
    // Wrap the entire re-point + child re-parent + delete sequence in a
    // single transaction so a partial failure can never leave the source
    // node alive with some assignments missing or vice versa.
    const result = await db.transaction(async (tx) => {
      const [source] = await tx.select().from(categoryNodeTable).where(eq(categoryNodeTable.id, sourceId!)).limit(1);
      const [target] = await tx.select().from(categoryNodeTable).where(eq(categoryNodeTable.id, targetId!)).limit(1);
      if (!source || !target) return { status: 404 as const, body: { error: "Source or target node not found" } };
      if (source.level !== target.level) {
        return { status: 400 as const, body: { error: "Cannot merge nodes at different levels" } };
      }

      // Re-point assignments. Skip rows that would collide with an existing
      // (inventoryId, targetId) pair (composite PK) — those rows just get deleted.
      const targetExisting = await tx
        .select({ inventoryId: inventoryCategoryTable.inventoryId })
        .from(inventoryCategoryTable)
        .where(eq(inventoryCategoryTable.categoryNodeId, targetId!));
      const targetSet = new Set(targetExisting.map(r => r.inventoryId));

      const sourceRows = await tx
        .select()
        .from(inventoryCategoryTable)
        .where(eq(inventoryCategoryTable.categoryNodeId, sourceId!));

      let moved = 0, dropped = 0;
      for (const row of sourceRows) {
        if (targetSet.has(row.inventoryId)) {
          await tx
            .delete(inventoryCategoryTable)
            .where(and(
              eq(inventoryCategoryTable.inventoryId, row.inventoryId),
              eq(inventoryCategoryTable.categoryNodeId, sourceId!),
            ));
          dropped++;
        } else {
          await tx
            .update(inventoryCategoryTable)
            .set({ categoryNodeId: targetId! })
            .where(and(
              eq(inventoryCategoryTable.inventoryId, row.inventoryId),
              eq(inventoryCategoryTable.categoryNodeId, sourceId!),
            ));
          moved++;
        }
      }

      // Re-parent any children of the source node onto the target.
      await tx
        .update(categoryNodeTable)
        .set({ parentId: targetId!, updatedAt: new Date() })
        .where(eq(categoryNodeTable.parentId, sourceId!));

      // Delete the now-empty source node.
      await tx.delete(categoryNodeTable).where(eq(categoryNodeTable.id, sourceId!));

      return { status: 200 as const, body: { ok: true, sourceId, targetId, moved, dropped } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[categories/merge] failed:", err);
    res.status(500).json({ error: "Failed to merge nodes" });
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

    // Enforce: inventory may only be assigned to a leaf "type" node, so the
    // browse drill-down always lands on a Category → Subcategory → Type path.
    const [node] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.id, nodeId))
      .limit(1);
    if (!node) return void res.status(404).json({ error: "Category node not found" });
    if (node.level !== "type") {
      return void res.status(400).json({
        error: "Inventory can only be assigned to a leaf type node",
      });
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

// POST /categories/classify (and /inventory/classify alias).
// Body: { mode?: "all" | "unclassified" | "specific-ids", ids?: number[], useAi?: boolean }
// Streams SSE progress; AI fallback runs by default for rule-misses.
export async function classifyHandler(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  try {
    const { mode = "unclassified", ids, useAi = true } = req.body as {
      mode?: "all" | "unclassified" | "specific-ids";
      ids?: number[];
      useAi?: boolean;
    };

    const nodes = await loadAllNodes();
    if (nodes.length === 0) {
      res.status(503).json({ error: "Taxonomy not seeded — run seed first" });
      return;
    }
    const index = buildNodeIndex(nodes);

    // Set up SSE early so progress streams even on long runs.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Page through the candidate set in chunks of 1000 to keep memory bounded.
    const PAGE = 1000;
    let totalCandidates = 0;
    let processed = 0;
    let classified = 0;
    let unmatched = 0;
    let aiUsed = 0;

    // Compute total up front so the SSE consumer can show a progress bar.
    if (mode === "specific-ids") {
      totalCandidates = ids?.length ?? 0;
    } else if (mode === "all") {
      const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(inventoryTable);
      totalCandidates = Number(row?.c ?? 0);
    } else {
      // unclassified — preserves manual overrides
      const result = await db.execute(sql`
        SELECT count(*)::int as c FROM inventory i
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_category ic WHERE ic.inventory_id = i.id
        )
      `);
      totalCandidates = Number((result as unknown as { rows: { c: number }[] }).rows[0]?.c ?? 0);
    }

    res.write(`data: ${JSON.stringify({ progress: 0, total: totalCandidates })}\n\n`);

    // Batch fetcher: returns the next page of items to classify.
    const fetchPage = async (offset: number) => {
      if (mode === "specific-ids") {
        if (!ids?.length) return [];
        const slice = ids.slice(offset, offset + PAGE);
        if (slice.length === 0) return [];
        return db.select().from(inventoryTable).where(inArray(inventoryTable.id, slice));
      }
      if (mode === "all") {
        return db
          .select()
          .from(inventoryTable)
          .orderBy(inventoryTable.id)
          .limit(PAGE)
          .offset(offset);
      }
      // unclassified
      const result = await db.execute(sql`
        SELECT i.* FROM inventory i
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_category ic WHERE ic.inventory_id = i.id
        )
        ORDER BY i.id
        LIMIT ${PAGE} OFFSET ${offset}
      `);
      return (result as { rows: Record<string, unknown>[] }).rows.map(rowToInventoryItem);
    };

    // Resolve the Uncategorized fallback node up front so unmatched rows
    // always have somewhere to land. Every part must end with exactly one
    // assignment so Browse never silently hides items.
    const uncategorizedNode = index.bySlug.get(UNCATEGORIZED_TYPE_SLUG);
    if (!uncategorizedNode) {
      res.status(503).json({ error: "Uncategorized fallback node missing — re-run seed" });
      return;
    }

    // Pre-compute the AI allow-list once (leaf "type" nodes minus Uncategorized
    // so the model is forced to make a real choice or skip the row).
    const aiAllowed: AiClassifyAllowed[] = nodes
      .filter(n => n.level === "type" && n.slug !== UNCATEGORIZED_TYPE_SLUG)
      .map(n => {
        const parent = n.parentId != null ? index.byId.get(n.parentId) : null;
        const grandparent = parent?.parentId != null ? index.byId.get(parent.parentId) : null;
        return {
          slug: n.slug,
          name: n.name,
          parentName: parent?.name ?? "",
          grandparentName: grandparent?.name ?? "",
        };
      });

    // Flush a single assignment row. Uses an upsert so re-classifying an
    // already-queued item updates the existing row atomically instead of
    // deleting + re-inserting (which could create a race-condition window and
    // would lose the prior row identity). reviewed_at is reset to NULL so the
    // item re-enters the review queue if a new low-confidence AI result arrives.
    const writeAssignment = async (
      inventoryId: number,
      categoryNodeId: number,
      confidence: number,
      classifiedBy: "rule" | "ai" | "manual",
    ) => {
      await db
        .insert(inventoryCategoryTable)
        .values({
          inventoryId,
          categoryNodeId,
          confidence: confidence.toFixed(4),
          classifiedBy,
        })
        .onConflictDoUpdate({
          target: inventoryCategoryTable.inventoryId,
          set: {
            categoryNodeId,
            confidence: confidence.toFixed(4),
            classifiedBy,
            classifiedAt: sql`now()`,
            reviewedAt: null,
            reviewedBy: null,
          },
        });
    };

    let offset = 0;
    while (true) {
      const batch = await fetchPage(offset);
      if (batch.length === 0) break;

      // Phase 1 — rule classify everything in the batch, also identifying which
      // rows are pinned manual (skip) and which need AI/Uncategorized fallback.
      const needsFallback: typeof batch = [];
      for (const item of batch) {
        if (mode !== "all") {
          const [existing] = await db
            .select({ classifiedBy: inventoryCategoryTable.classifiedBy })
            .from(inventoryCategoryTable)
            .where(eq(inventoryCategoryTable.inventoryId, item.id))
            .limit(1);
          if (existing?.classifiedBy === "manual") {
            processed++;
            continue;
          }
        }

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

        const ruleSlug = result?.typeSlug ?? null;
        const ruleNode = ruleSlug ? index.bySlug.get(ruleSlug) : undefined;
        if (ruleNode) {
          await writeAssignment(item.id, ruleNode.id, result?.confidence ?? 0, "rule");
          classified++;
        } else {
          needsFallback.push(item);
        }
        processed++;
        if (processed % 50 === 0) {
          res.write(
            `data: ${JSON.stringify({ progress: processed, total: totalCandidates, classified, unmatched, aiUsed })}\n\n`,
          );
        }
      }

      // Phase 2 — AI fallback in micro-batches of 25 (keeps tokens/latency
      // bounded and lets us stream progress between calls).
      const aiAssigned = new Set<number>();
      if (useAi && needsFallback.length > 0 && aiAllowed.length > 0) {
        const AI_BATCH = 25;
        for (let i = 0; i < needsFallback.length; i += AI_BATCH) {
          const slice = needsFallback.slice(i, i + AI_BATCH).map(it => ({
            id: it.id,
            vendor: it.vendor,
            catalog: it.catalog,
            description: it.description,
            aiKeywords: it.aiKeywords ?? [],
          }));
          const assignments = await aiClassifyBatch(slice, aiAllowed);
          for (const a of assignments) {
            const node = index.bySlug.get(a.slug);
            if (!node) continue;
            await writeAssignment(a.id, node.id, a.confidence, "ai");
            aiAssigned.add(a.id);
            aiUsed++;
            classified++;
          }
        }
      }

      // Phase 3 — anything still unmatched goes to Uncategorized so every
      // inventory row has exactly one assignment row.
      for (const item of needsFallback) {
        if (aiAssigned.has(item.id)) continue;
        await writeAssignment(item.id, uncategorizedNode.id, 0, "rule");
        unmatched++;
      }

      // For "unclassified", every processed row is now assigned, so it falls
      // out of the NOT EXISTS set — leaving offset at 0 lets the next page
      // return the next unprocessed slice. Incrementing offset would skip
      // rows because the underlying result set is shrinking each iteration.
      // For "all" and "specific-ids" the candidate set is stable, so paging
      // by offset is correct.
      if (mode !== "unclassified") {
        offset += batch.length;
      }
      if (mode === "specific-ids" && offset >= (ids?.length ?? 0)) break;
    }

    // Cleanup: drop any assignment rows whose inventory_id no longer exists.
    const cleanup = await db.execute(sql`
      DELETE FROM inventory_category
      WHERE inventory_id NOT IN (SELECT id FROM inventory)
      RETURNING inventory_id
    `);
    const cleaned = (cleanup as { rows: unknown[] }).rows.length;

    res.write(
      `data: ${JSON.stringify({
        done: true,
        mode,
        total: totalCandidates,
        processed,
        classified,
        unmatched,
        aiUsed,
        cleanedStale: cleaned,
      })}\n\n`,
    );
    res.end();
  } catch (err) {
    console.error("[classify] failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Classification failed" });
    } else {
      res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      res.end();
    }
  }
}

router.post("/classify", requireAdminAuth, classifyHandler);

// ── POST /admin/reclassify ───────────────────────────────────────────────
// Runs a full re-classification pass over every inventory item whose current
// assignment is NOT manual (or that has no assignment at all). Manual overrides
// are always preserved. Safe to re-run: two consecutive runs produce the same
// result.
//
// Body: { useAi?: boolean }  (defaults to true)
//
// Streams SSE progress events, then a final summary:
//   { done, total, processed, ruleHits, aiHits, uncategorized, skippedManual }
router.post("/reclassify", requireAdminAuth, async (req, res) => {
  try {
    const { useAi = true } = (req.body ?? {}) as { useAi?: boolean };

    const nodes = await loadAllNodes();
    if (nodes.length === 0) {
      res.status(503).json({ error: "Taxonomy not seeded — run seed first" });
      return;
    }
    const nodeIndex = buildNodeIndex(nodes);

    const uncategorizedNode = nodeIndex.bySlug.get(UNCATEGORIZED_TYPE_SLUG);
    if (!uncategorizedNode) {
      res.status(503).json({ error: "Uncategorized fallback node missing — re-run seed" });
      return;
    }

    // Set up SSE early so progress streams even on long runs.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Count all non-manual candidates up front for progress reporting.
    // "Non-manual" = no row in inventory_category yet, OR classifiedBy != 'manual'.
    const totalResult = await db.execute(sql`
      SELECT count(*)::int AS c FROM inventory i
      WHERE NOT EXISTS (
        SELECT 1 FROM inventory_category ic
        WHERE ic.inventory_id = i.id AND ic.classified_by = 'manual'
      )
    `);
    const totalCandidates = Number(
      (totalResult as unknown as { rows: { c: number }[] }).rows[0]?.c ?? 0,
    );

    res.write(
      `data: ${JSON.stringify({ progress: 0, total: totalCandidates })}\n\n`,
    );

    // Pre-compute AI allow-list once (leaf "type" nodes minus Uncategorized).
    const aiAllowed: AiClassifyAllowed[] = nodes
      .filter(n => n.level === "type" && n.slug !== UNCATEGORIZED_TYPE_SLUG)
      .map(n => {
        const parent = n.parentId != null ? nodeIndex.byId.get(n.parentId) : null;
        const grandparent =
          parent?.parentId != null ? nodeIndex.byId.get(parent.parentId) : null;
        return {
          slug: n.slug,
          name: n.name,
          parentName: parent?.name ?? "",
          grandparentName: grandparent?.name ?? "",
        };
      });

    const writeAssignment = async (
      inventoryId: number,
      categoryNodeId: number,
      confidence: number,
      classifiedBy: "rule" | "ai",
    ) => {
      await db
        .insert(inventoryCategoryTable)
        .values({
          inventoryId,
          categoryNodeId,
          confidence: confidence.toFixed(4),
          classifiedBy,
        })
        .onConflictDoUpdate({
          target: inventoryCategoryTable.inventoryId,
          set: {
            categoryNodeId,
            confidence: confidence.toFixed(4),
            classifiedBy,
            classifiedAt: sql`now()`,
            reviewedAt: null,
            reviewedBy: null,
          },
        });
    };

    let processed = 0;
    let skippedManual = 0;
    let ruleHits = 0;
    let aiHits = 0;
    let uncategorized = 0;
    const PAGE = 1000;
    let offset = 0;

    while (true) {
      // Fetch a page of non-manual candidates. Using a stable ORDER BY id and
      // fixed OFFSET is correct here because we re-assign rows in place (we
      // don't delete them from the candidate set between pages).
      const pageResult = await db.execute(sql`
        SELECT i.* FROM inventory i
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_category ic
          WHERE ic.inventory_id = i.id AND ic.classified_by = 'manual'
        )
        ORDER BY i.id
        LIMIT ${PAGE} OFFSET ${offset}
      `);
      const batch = (pageResult as { rows: Record<string, unknown>[] }).rows.map(
        rowToInventoryItem,
      );
      if (batch.length === 0) break;

      // Phase 1 — rule classifier.
      const needsFallback: typeof batch = [];
      for (const item of batch) {
        const result = classifyItem(
          {
            id: item.id,
            vendor: item.vendor,
            catalog: item.catalog,
            description: item.description,
            aiKeywords: item.aiKeywords ?? [],
          },
          nodeIndex,
        );
        const ruleSlug = result?.typeSlug ?? null;
        const ruleNode = ruleSlug ? nodeIndex.bySlug.get(ruleSlug) : undefined;
        if (ruleNode) {
          await writeAssignment(item.id, ruleNode.id, result?.confidence ?? 0, "rule");
          ruleHits++;
        } else {
          needsFallback.push(item);
        }
        processed++;
        if (processed % 50 === 0) {
          res.write(
            `data: ${JSON.stringify({
              progress: processed,
              total: totalCandidates,
              ruleHits,
              aiHits,
              uncategorized,
              skippedManual,
            })}\n\n`,
          );
        }
      }

      // Phase 2 — AI fallback in micro-batches of 25.
      const aiAssigned = new Set<number>();
      if (useAi && needsFallback.length > 0 && aiAllowed.length > 0) {
        const AI_BATCH = 25;
        for (let i = 0; i < needsFallback.length; i += AI_BATCH) {
          const slice = needsFallback.slice(i, i + AI_BATCH).map(it => ({
            id: it.id,
            vendor: it.vendor,
            catalog: it.catalog,
            description: it.description,
            aiKeywords: it.aiKeywords ?? [],
          }));
          const assignments = await aiClassifyBatch(slice, aiAllowed);
          for (const a of assignments) {
            const node = nodeIndex.bySlug.get(a.slug);
            if (!node) continue;
            await writeAssignment(a.id, node.id, a.confidence, "ai");
            aiAssigned.add(a.id);
            aiHits++;
          }
        }
      }

      // Phase 3 — send remaining unmatched items to Uncategorized.
      for (const item of needsFallback) {
        if (aiAssigned.has(item.id)) continue;
        await writeAssignment(item.id, uncategorizedNode.id, 0, "rule");
        uncategorized++;
      }

      offset += batch.length;
    }

    // Count manual assignments that were intentionally skipped.
    const manualResult = await db.execute(sql`
      SELECT count(*)::int AS c FROM inventory_category
      WHERE classified_by = 'manual'
    `);
    skippedManual = Number(
      (manualResult as unknown as { rows: { c: number }[] }).rows[0]?.c ?? 0,
    );

    res.write(
      `data: ${JSON.stringify({
        done: true,
        total: totalCandidates,
        processed,
        ruleHits,
        aiHits,
        uncategorized,
        skippedManual,
      })}\n\n`,
    );
    res.end();
  } catch (err) {
    console.error("[admin/reclassify] failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Reclassification failed" });
    } else {
      res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      res.end();
    }
  }
});

// ── GET /categories/assignments ──────────────────────────────────────────
// Flat list of every part's current taxonomy node, used by the mobile app
// to power Browse offline. Returns slugs + node ids so the client can
// resolve nodes after a tree refresh.
//
// Shape:
//   { assignments: Array<{ inventoryId, categoryNodeId, typeSlug, confidence, classifiedBy }>,
//     updatedAt: ISO-8601 string }
//
// Cheap (single indexed join) so the mobile sync can pull it on every poll
// alongside the inventory cache.
router.get("/assignments", async (_req, res) => {
  try {
    const rows = await db
      .select({
        inventoryId: inventoryCategoryTable.inventoryId,
        categoryNodeId: inventoryCategoryTable.categoryNodeId,
        typeSlug: categoryNodeTable.slug,
        confidence: inventoryCategoryTable.confidence,
        classifiedBy: inventoryCategoryTable.classifiedBy,
      })
      .from(inventoryCategoryTable)
      .innerJoin(
        categoryNodeTable,
        eq(categoryNodeTable.id, inventoryCategoryTable.categoryNodeId),
      );
    res.json({ assignments: rows, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[categories/assignments] failed:", err);
    res.status(500).json({ error: "Failed to load assignments" });
  }
});

// ── helpers ──────────────────────────────────────────────────────────────
/** Legal Category → Subcategory → Type tree shape. Used by PATCH /:nodeId
 * and the assign endpoints so the browse drill-down never sees a node
 * parented at the wrong level. */
const LEGAL_PARENT_LEVEL: Record<"category" | "subcategory" | "type", "category" | "subcategory" | null> = {
  category: null,
  subcategory: "category",
  type: "subcategory",
};

function rowToInventoryItem(row: Record<string, unknown>): typeof inventoryTable.$inferSelect {
  return {
    id: Number(row["id"]),
    vendor: String(row["vendor"] ?? ""),
    catalog: String(row["catalog"] ?? ""),
    description: String(row["description"] ?? ""),
    binLocations: Array.isArray(row["bin_locations"]) ? (row["bin_locations"] as string[]) : [],
    aiKeywords: Array.isArray(row["ai_keywords"]) ? (row["ai_keywords"] as string[]) : [],
    tradeSize: typeof row["trade_size"] === "string" ? row["trade_size"] : null,
    enrichedAt: row["enriched_at"] instanceof Date ? (row["enriched_at"] as Date) : null,
    createdAt: row["created_at"] instanceof Date ? (row["created_at"] as Date) : new Date(0),
    updatedAt: row["updated_at"] instanceof Date ? (row["updated_at"] as Date) : new Date(0),
    catalogParse: null,
    amperage: null,
    poleCount: null,
    voltage: null,
    tradeSizeIn: null,
    mountType: null,
    attrsParsedAt: null,
    promptVersion: null,
    searchTokens: null,
  };
}

export default router;
