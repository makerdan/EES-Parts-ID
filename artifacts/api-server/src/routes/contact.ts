import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { contactMessagesTable } from "@workspace/db";
import { verifyAdminToken } from "./admin";
import { logger } from "../lib/logger";

const router = Router();

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

// POST /contact — submit a message (no auth required)
router.post("/", async (req, res) => {
  try {
    const { subject, body, senderToken } = req.body as {
      subject?: string;
      body?: string;
      senderToken?: string;
    };

    if (!subject?.trim()) {
      return void res.status(400).json({ error: "subject is required" });
    }
    if (!body?.trim()) {
      return void res.status(400).json({ error: "body is required" });
    }
    const token = (senderToken ?? "").trim() || "anonymous";

    const [row] = await db
      .insert(contactMessagesTable)
      .values({ senderToken: token, subject: subject.trim(), body: body.trim() })
      .returning({ id: contactMessagesTable.id });

    return void res.status(201).json({ id: row!.id });
  } catch (err) {
    logger.error({ err }, "contact.post failed");
    return void res.status(500).json({ error: "Failed to submit message" });
  }
});

// GET /contact — list all messages, newest first (admin only)
router.get("/", requireAdminAuth, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(contactMessagesTable)
      .orderBy(desc(contactMessagesTable.createdAt));
    return void res.json(rows);
  } catch (err) {
    logger.error({ err }, "contact.list failed");
    return void res.status(500).json({ error: "Failed to load messages" });
  }
});

// PATCH /contact/:id/read — mark a message read (admin only)
router.patch("/:id/read", requireAdminAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? ""), 10);
    if (isNaN(id)) {
      return void res.status(400).json({ error: "Invalid message ID" });
    }
    const [row] = await db
      .update(contactMessagesTable)
      .set({ readAt: new Date() })
      .where(eq(contactMessagesTable.id, id))
      .returning({ id: contactMessagesTable.id });

    if (!row) {
      return void res.status(404).json({ error: "Message not found" });
    }
    return void res.json({ id: row.id });
  } catch (err) {
    logger.error({ err }, "contact.markRead failed");
    return void res.status(500).json({ error: "Failed to mark message read" });
  }
});

export default router;
