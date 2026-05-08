/**
 * Search auxiliary routes — currently: click telemetry.
 *
 * POST /search/click
 *   Records a result interaction (view, add_to_list, etc.) against a
 *   previously recorded search_event row. Called fire-and-forget by the
 *   mobile client when a worker taps a result card.
 */
import { Router } from 'express';
import { logSearchClick, type ClickAction } from '../search/telemetry';

const router = Router();

const VALID_ACTIONS = new Set<ClickAction>(['view', 'add_to_list', 'scan_confirm', 'dismiss']);

router.post('/click', async (req, res) => {
  const { searchEventId, resultId, resultRank, action } = req.body as {
    searchEventId?: unknown;
    resultId?: unknown;
    resultRank?: unknown;
    action?: unknown;
  };

  // Require safe integers for all numeric fields so BigInt() and DB inserts
  // never receive floats or out-of-range values from malformed requests.
  if (
    typeof searchEventId !== 'number' ||
    !Number.isInteger(searchEventId) ||
    searchEventId <= 0 ||
    typeof resultId !== 'number' ||
    !Number.isInteger(resultId) ||
    resultId <= 0 ||
    // resultRank is 0-based (0 = first result shown) — matches mobile index
    typeof resultRank !== 'number' ||
    !Number.isInteger(resultRank) ||
    resultRank < 0 ||
    typeof action !== 'string' ||
    !VALID_ACTIONS.has(action as ClickAction)
  ) {
    res.status(400).json({ error: 'Invalid click payload' });
    return;
  }

  await logSearchClick(BigInt(searchEventId), resultId, resultRank, action as ClickAction);
  res.json({ ok: true });
});

export default router;
