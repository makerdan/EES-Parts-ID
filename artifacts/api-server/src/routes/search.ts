/**
 * Search auxiliary routes — currently: click telemetry.
 *
 * POST /search/click
 *   Records a result interaction (view, add_to_list, etc.) against a
 *   previously recorded search_event row. Called fire-and-forget by the
 *   mobile client when a worker taps a result card.
 */
import { Router } from "express";
import { logSearchClick, type ClickAction } from "../search/telemetry";

const router = Router();

const VALID_ACTIONS = new Set<ClickAction>([
  "view",
  "add_to_list",
  "scan_confirm",
  "dismiss",
]);

router.post("/click", async (req, res) => {
  const { searchEventId, resultId, resultRank, action } = req.body as {
    searchEventId?: unknown;
    resultId?: unknown;
    resultRank?: unknown;
    action?: unknown;
  };

  if (
    typeof searchEventId !== "number" ||
    typeof resultId !== "number" ||
    typeof resultRank !== "number" ||
    typeof action !== "string" ||
    !VALID_ACTIONS.has(action as ClickAction)
  ) {
    res.status(400).json({ error: "Invalid click payload" });
    return;
  }

  await logSearchClick(BigInt(searchEventId), resultId, resultRank, action as ClickAction);
  res.json({ ok: true });
});

export default router;
