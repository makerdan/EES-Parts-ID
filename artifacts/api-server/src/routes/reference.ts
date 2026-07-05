import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { aiRequestLogTable,inventoryTable, quickLookupCacheTable, referenceLogTable } from "@workspace/db";
import { desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { Router } from "express";

import {
  getCachedAnswer,
  hashQuestion,
  normalizeQuestion,
  setCachedAnswer,
} from "../lib/answerCache";
import { logger } from "../lib/logger";
import { referenceAskLimiter } from "../lib/rateLimiter";
import { callGemini, callGeminiWithHistory } from "../lib/webSearch";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();

const GENERIC_ERROR_MESSAGE =
  "Sorry, the reference assistant ran into a problem. Please try again.";

/**
 * Concise description of the Parts ID app injected into the system prompt so
 * the AI can answer "how does this app work?" questions without a web search.
 */
const APP_KNOWLEDGE = `
## About the Parts ID App

Parts ID is a mobile warehouse app for identifying, locating, and managing electrical supply inventory. It has three main tabs everyone sees — **Search**, **Photo ID**, and **Map** — plus an **Admin** tab and a hidden **Measure** tab for admins.

**Accounts & signing in:**
- **Getting an account:** Tap Sign Up on the login screen and register with email/password or with Google/Apple sign-in. New accounts are **not active immediately** — they land on a "Pending approval" screen until an admin approves them. There's a "Refresh status" button to re-check without restarting the app.
- **Logging in:** Returning users tap Log In. Approved users go straight to the tabs; pending users see the waiting screen; blocked users see a "banned" screen and can't use the app.
- **Getting admin access:** Admin is a role an existing admin grants to your account. Once you're promoted, admin features (the Admin tab, the Measure tab, zone editing) unlock automatically — usually within a minute or when you reopen the app — without logging out and back in. If access is revoked, the admin tools lock again automatically.

**Search tab (everyone):**
- **Search bar:** Type a plain-language query (e.g. "20 amp GFCI breaker" or "blue wire nut") and the app finds matching inventory across vendor, catalog number, description, and AI keywords. Works offline against a local cache, and falls back to the cache automatically on a slow connection.
- **Advanced filters:** A collapsible filter panel narrows results by catalog number, vendor, color, size/rating, material, markings/UPC text, and by a **size range** (min/max length, width, height, diameter in mm). Quick attribute chips (amperage, voltage, wire gauge, conduit size, pole count, etc.) show live result counts.
- **Recent searches:** Focusing the empty search bar shows your recent queries and recently viewed parts so you can jump back to them.
- **Browse by aisle:** Drill down Aisle → Section → Shelf to see a visual layout of what's stored in each bin, and tap "Map it" to jump to that spot on the map.
- **Browse by category:** Browse parts by functional group (Category → Subcategory → Item Type) without typing.
- **Part details:** Tap a result to see full details — expanded description, specs, dimensions, photos (with full-screen zoom), other sizes/variants, and bin locations. Tap a bin location to see it on the Map tab.
- **Barcode scan:** Tap the barcode button in the search bar to scan a part's UPC/barcode and look it up instantly.

**Photo ID tab (everyone):**
- Take or pick up to 4 photos of a part and the AI identifies it by comparing against inventory. You can add optional hints (keywords, vendor, color, size, markings) to improve accuracy. Results show as cards you can open for details or "Show on Map." Your last few scans are kept for quick access.

**Map tab (everyone):**
- **Interactive floor plan:** Pan and zoom an SVG warehouse map that stays crisp at high zoom. It unlocks landscape orientation for a wider view.
- **Zones:** Tap a zone/section to see the items stored there.
- **Pins:** When you identify a part in Search or Photo ID and tap "Show on Map," its bin location is pinned (the main match in amber, related sizes in purple).
- **Cycle counting:** Toggle a counting layer to mark zones as counted as you walk the floor; progress is saved on the device.
- **Zone editor (admin):** Admins get a button to open a dedicated zone editor for drawing, numbering, and fixing warehouse zones on the floor plan.

**Measure tab (admin only, LiDAR devices only):**
- On an iPhone/iPad with LiDAR, admins can scan a part's real bounding-box dimensions in a few seconds. Values can be reviewed and edited before confirming.
- Launched from an item's edit form, the captured dimensions are written back to pre-fill that item's length/width/height. Launched on its own, the dimensions are applied as a **size-range filter on the Search tab** so you can find similarly sized parts.

**Admin tab & admin tools (admin only):**
- **Dashboard:** AI usage analytics (Photo ID vs. Reference assistant), screen-view and daily-visitor trends, and totals for inventory items, catalog jobs, and contact messages.
- **CSV / spreadsheet import:** Bulk-upload inventory from a CSV/XLSX (vendor, catalog, description). Includes options to skip or replace existing bin locations. The server parses, deduplicates, and stores the rows.
- **Catalog PDF upload & review:** Upload a manufacturer's catalog PDF; the app splits large files into chunks, extracts parts with AI, and flags low-confidence results for review. In the review screen admins see before/after descriptions and can fix, revert, or discard AI changes. Failed uploads can be resumed from where they stopped.
- **AI enrichment:** Trigger bulk AI generation of searchable keywords and expanded descriptions for items that haven't been processed yet.
- **Admin inbox:** Read messages workers send via the Contact button in this assistant, and mark them resolved.
- **AI log:** Review recent questions asked to this assistant, the answers, and how many inventory items were matched.
- **SQL console:** Run read-only queries against the database (e.g. "parts missing a bin").
- **Photo upload:** Attach product images to inventory items from the app.

**This assistant (the Ref chat):**
- Open it with the **"Ref" button (⚡)** in the Search tab header. It's a chat where anyone can ask about electrical codes and terminology, look up inventory, ask how the app works, or ask a general question — and it can search the web when needed. Quick-lookup and breaker-attribute chips give instant answers, and the Contact button sends a message to the admin inbox.

**Settings:** Set the server URL (API base), toggle dark mode, choose the dimension unit (in/cm/mm), and view app version info. Recently viewed parts and chip answers are cached for offline use.
`;

const BASE_SYSTEM_PROMPT = `You are a concise warehouse parts and general reference assistant for warehouse workers using the Parts ID app. You help with:
- Electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology
- Any general question a warehouse worker might have
- Questions about how the Parts ID app works (features, how-tos, capabilities)

Always check the inventory context below first. If relevant inventory items are listed, reference them.
Use **bold** for key terms and - bullets for lists. Keep answers under 250 words. Be precise and practical.

When you use your web search capability to answer a question, prefix your final answer with "*(web)*" on its own line so the worker knows the answer came from a live web search.
${APP_KNOWLEDGE}`;

/**
 * Search the inventory for items relevant to the question.
 * Returns the formatted context string AND the matched row count.
 */
async function buildInventoryContext(question: string): Promise<{ context: string; count: number }> {
  try {
    const tokens = question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (tokens.length === 0) return { context: "", count: 0 };

    const conditions = tokens.flatMap((token) => [
      ilike(inventoryTable.description, `%${token}%`),
      ilike(sql`array_to_string(${inventoryTable.aiKeywords}, ' ')`, `%${token}%`),
    ]);

    const rows = await db
      .select({
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
      })
      .from(inventoryTable)
      .where(or(...conditions))
      .limit(15);

    if (rows.length === 0) return { context: "", count: 0 };

    const lines = rows.map(
      (r) =>
        `${r.vendor} | ${r.catalog} | ${r.description.slice(0, 80)}${r.description.length > 80 ? "…" : ""}`,
    );

    return {
      context: `\n\nRelevant items currently in this warehouse's inventory:\n${lines.join("\n")}`,
      count: rows.length,
    };
  } catch (err) {
    logger.warn({ err }, "inventory context lookup failed — skipping enrichment");
    return { context: "", count: 0 };
  }
}

/** Fire-and-forget: log an AI request and prune entries older than 90 days. */
function writeAiRequestLog(feature: "reference"): void {
  setImmediate(async () => {
    try {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await db.insert(aiRequestLogTable).values({ feature });
      await db.delete(aiRequestLogTable).where(lt(aiRequestLogTable.createdAt, ninetyDaysAgo));
    } catch (err) {
      logger.warn({ err }, "ai_request_log write failed");
    }
  });
}

/** Fire-and-forget: write a Q&A log row and prune entries older than 30 days. */
function writeReferenceLog(question: string, answer: string, matchedItemCount: number): void {
  setImmediate(async () => {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await db.insert(referenceLogTable).values({ question, answer, matchedItemCount });
      await db.delete(referenceLogTable).where(lt(referenceLogTable.createdAt, thirtyDaysAgo));
    } catch (err) {
      logger.warn({ err }, "reference log write failed");
    }
  });
}

/**
 * Call Gemini-2.5-Flash via Replit AI Integrations for a reference answer.
 * Returns the answer text and whether the answer appears to be web-sourced.
 */
async function callGeminiReference(
  systemContent: string,
  question: string,
): Promise<{ answer: string; usedWebSearch: boolean }> {
  const answer = await callGemini(systemContent, question);
  const usedWebSearch = answer.trimStart().startsWith("*(web)*");
  return { answer, usedWebSearch };
}

/**
 * Collect the full answer via Gemini-2.5-Flash (single-turn, cacheable).
 * Returns the text, matched inventory count, and whether web search was used.
 */
async function collectAnswer(
  question: string,
): Promise<{ answer: string; matchedItemCount: number; usedWebSearch: boolean }> {
  const { context: inventoryContext, count: matchedItemCount } = await buildInventoryContext(question);
  const systemContent = BASE_SYSTEM_PROMPT + inventoryContext;
  const { answer, usedWebSearch } = await callGeminiReference(systemContent, question);
  return { answer, matchedItemCount, usedWebSearch };
}

/**
 * Collect a multi-turn answer via Gemini-2.5-Flash (history-aware, not cached).
 * Returns the text, matched inventory count, and whether web search was used.
 */
async function collectAnswerWithHistory(
  question: string,
  history: Array<{ q: string; a: string }>,
): Promise<{ answer: string; matchedItemCount: number; usedWebSearch: boolean }> {
  const { context: inventoryContext, count: matchedItemCount } = await buildInventoryContext(question);
  const systemContent = BASE_SYSTEM_PROMPT + inventoryContext;
  const answer = await callGeminiWithHistory(systemContent, history, question);
  const usedWebSearch = answer.trimStart().startsWith("*(web)*");
  return { answer, matchedItemCount, usedWebSearch };
}

// POST /reference/ask — SSE streaming or JSON reference Q&A
const REFERENCE_ASK_MAX_QUESTION_LENGTH = 2000;
const REFERENCE_ASK_MAX_HISTORY_ITEMS = 20;
const REFERENCE_ASK_MAX_HISTORY_ITEM_LENGTH = 2000;

router.post("/ask", async (req, res) => {
  try {
    const rateLimitKey = getAuth(req)?.userId ?? String(req.ip ?? "unknown");
    const rateCheck = await referenceAskLimiter.check(rateLimitKey);
    if (!rateCheck.allowed) {
      res.set("Retry-After", String(Math.ceil(rateCheck.retryAfterMs / 1000)));
      return void res.status(429).json({ error: "Too many requests. Please slow down." });
    }

    const { question, history } = req.body as {
      question: string;
      history?: Array<{ q: string; a: string }>;
    };
    if (!question?.trim()) {
      return void res.status(400).json({ error: "question is required" });
    }
    if (question.length > REFERENCE_ASK_MAX_QUESTION_LENGTH) {
      return void res.status(400).json({ error: `question must be ${REFERENCE_ASK_MAX_QUESTION_LENGTH} characters or fewer` });
    }
    if (Array.isArray(history)) {
      if (history.length > REFERENCE_ASK_MAX_HISTORY_ITEMS) {
        return void res.status(400).json({ error: `history must not exceed ${REFERENCE_ASK_MAX_HISTORY_ITEMS} items` });
      }
      for (const item of history) {
        if (
          typeof item.q !== "string" ||
          typeof item.a !== "string" ||
          item.q.length > REFERENCE_ASK_MAX_HISTORY_ITEM_LENGTH ||
          item.a.length > REFERENCE_ASK_MAX_HISTORY_ITEM_LENGTH
        ) {
          return void res.status(400).json({ error: `each history item must have string q and a fields of ${REFERENCE_ASK_MAX_HISTORY_ITEM_LENGTH} characters or fewer` });
        }
      }
    }

    const hasHistory = Array.isArray(history) && history.length > 0;
    const normalized = normalizeQuestion(question);
    // Pass history into hashQuestion so that a follow-up answer (which is
    // context-dependent) always gets a different hash from the cold-start
    // answer for the same question text. This is the structural safety layer:
    // history-path hashes and cold-start hashes occupy disjoint key spaces,
    // so a history-path answer can never poison the single-turn cache even if
    // the !hasHistory write guard below is accidentally removed in the future.
    const questionHash = hashQuestion(normalized, hasHistory ? history : undefined);

    const wantsJson =
      req.query["stream"] === "false" ||
      (req.headers["accept"] ?? "").includes("application/json");

    if (wantsJson) {
      if (!hasHistory) {
        const cached = await getCachedAnswer(questionHash);
        if (cached !== null) {
          logger.debug({ questionHash }, "reference.ask cache hit (json)");
          writeAiRequestLog("reference");
          return void res.json({ answer: cached });
        }
      }

      const { answer, matchedItemCount, usedWebSearch } = hasHistory
        ? await collectAnswerWithHistory(question.trim(), history!)
        : await collectAnswer(question.trim());
      writeReferenceLog(question.trim(), answer, matchedItemCount);
      // Secondary guard: skip the DB write entirely for history-path answers
      // (they are context-dependent and not worth storing). The primary safety
      // layer is the hash itself — history hashes and cold-start hashes are
      // disjoint (see hashQuestion), so even if this guard were removed,
      // a history answer could never be served as a cold-start answer.
      if (!hasHistory) {
        setCachedAnswer(questionHash, normalized, answer, usedWebSearch).catch((err) => logger.warn({ err }, "cache write failed"));
      }
      writeAiRequestLog("reference");
      return void res.json({ answer });
    }

    // SSE path: check cache first (only when no history), then call Gemini-2.5-Flash on miss.
    const cached = hasHistory ? null : await getCachedAnswer(questionHash);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (cached !== null) {
      logger.debug({ questionHash }, "reference.ask cache hit (sse)");
      writeAiRequestLog("reference");
      res.write(`data: ${JSON.stringify({ content: cached })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }

    // Gemini-2.5-Flash call (non-streaming internally; pseudo-stream to client).
    const { answer: fullAnswer, matchedItemCount, usedWebSearch } = hasHistory
      ? await collectAnswerWithHistory(question.trim(), history!)
      : await collectAnswer(question.trim());

    // Emit the answer word-by-word for a live-typing effect.
    const words = fullAnswer.split(" ");
    for (let i = 0; i < words.length; i++) {
      const chunk = (i === 0 ? "" : " ") + words[i];
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

    writeReferenceLog(question.trim(), fullAnswer, matchedItemCount);
    writeAiRequestLog("reference");
    // Secondary guard: same reasoning as the JSON path above — skip the DB
    // write for history-path answers. The primary safety layer is the hash
    // itself (history hashes and cold-start hashes are disjoint via hashQuestion).
    if (fullAnswer && !hasHistory) {
      setCachedAnswer(questionHash, normalized, fullAnswer, usedWebSearch).catch((err) => logger.warn({ err }, "cache write failed"));
    }
  } catch (err) {
    logger.error({ err }, "reference.ask failed");
    if (res.headersSent) {
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: GENERIC_ERROR_MESSAGE })}\n\n`,
        );
      } catch (writeErr) {
        console.warn("[reference/ask] Failed to write SSE error event (connection may already be torn down):", writeErr);
      }
      res.end();
    } else {
      res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
    }
  }
});

// GET /reference/ask-log — admin-only list of recent Q&A log rows
router.get("/ask-log", requireAdminAuth, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(referenceLogTable)
      .orderBy(desc(referenceLogTable.createdAt))
      .limit(100);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, "reference.ask-log list failed");
    res.status(500).json({ error: "Failed to load AI log" });
  }
});

// GET /reference/quick-lookups — return all cached rows (includes updatedAt for client-side TTL)
router.get("/quick-lookups", async (_req, res) => {
  try {
    const rows = await db
      .select({
        label: quickLookupCacheTable.label,
        answer: quickLookupCacheTable.answer,
        updatedAt: quickLookupCacheTable.updatedAt,
      })
      .from(quickLookupCacheTable);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, "reference.quick-lookups list failed");
    res.status(500).json({ error: "Failed to load quick lookups" });
  }
});

// GET /reference/quick-lookups/:label — single row or 404
router.get("/quick-lookups/:label", async (req, res) => {
  try {
    const { label } = req.params;
    const rows = await db
      .select({ answer: quickLookupCacheTable.answer })
      .from(quickLookupCacheTable)
      .where(eq(quickLookupCacheTable.label, label))
      .limit(1);

    if (rows.length === 0) {
      return void res.status(404).json({ error: "Not found" });
    }
    res.json({ answer: rows[0]!.answer });
  } catch (err) {
    logger.error({ err }, "reference.quick-lookups get failed");
    res.status(500).json({ error: "Failed to load quick lookup" });
  }
});

// POST /reference/quick-lookups/:label — AI fallback + DB write-back
// Called internally by the mobile client when cache misses at all layers.
router.post("/quick-lookups/:label", requireAdminAuth, async (req, res) => {
  try {
    const label = req.params["label"] as string;
    const { question } = req.body as { question: string };
    if (!question?.trim()) {
      return void res.status(400).json({ error: "question is required" });
    }

    const { answer } = await collectAnswer(question.trim());

    await db
      .insert(quickLookupCacheTable)
      .values({ label, answer, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: quickLookupCacheTable.label,
        set: { answer, updatedAt: new Date() },
      });

    res.json({ answer });
  } catch (err) {
    logger.error({ err }, "reference.quick-lookups post failed");
    res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
  }
});

export default router;
