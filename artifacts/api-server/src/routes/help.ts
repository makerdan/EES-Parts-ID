import { type Request, type Response, Router } from "express";

import {
  getHelpResponse,
  HELP_LIMITS,
  type HelpAudience,
} from "../lib/helpContent";
import { requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();
const WORKFLOW_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseWorkflow(req: Request): string | undefined {
  const raw = req.query["workflow"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > HELP_LIMITS.maxWorkflowLength || !WORKFLOW_PATTERN.test(raw)) {
    throw new Error("Invalid workflow");
  }
  return raw;
}

function rejectAudienceOverride(req: Request): void {
  if (req.query["audience"] !== undefined) throw new Error("Audience is selected by the endpoint");
}

function sendHelp(audience: HelpAudience, req: Request, res: Response): void {
  try {
    rejectAudienceOverride(req);
    const workflow = parseWorkflow(req);
    const payload = getHelpResponse(audience, workflow);
    if (payload.records.length === 0) {
      res.status(404).json({ error: "Help topic not found" });
      return;
    }

    res.set("Cache-Control", "private, no-store");
    res.set("Vary", "Authorization");
    res.json(payload);
  } catch (err) {
    if (err instanceof Error && (err.message === "Invalid workflow" || err.message === "Audience is selected by the endpoint")) {
      res.status(400).json({ error: "Invalid Help request" });
      return;
    }
    res.status(500).json({ error: "Help content unavailable" });
  }
}

// GET /help — authenticated general Help records.
router.get("/", (req, res) => sendHelp("general", req, res));

// GET /help/admin — current admin + MFA required; no client role flag is used.
router.get("/admin", requireAdminAuth, (req, res) => sendHelp("admin", req, res));

export default router;
