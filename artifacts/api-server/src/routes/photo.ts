/**
 * Photo ID confirmation route.
 *   POST /photo/confirm — worker signals which result matched the photo.
 *
 * No auth required: workers are anonymous; the photoEventId acts as a
 * photoEventId is a sequential bigserial — not secret, treat as a non-private identifier.
 */
import { Router } from 'express';
import { db } from '@workspace/db';
import { photoIdEventTable } from '@workspace/db';
import { eq } from 'drizzle-orm';

const router = Router();

router.post('/confirm', async (req, res) => {
  try {
    const { photoEventId, resultId } = req.body as {
      photoEventId?: unknown;
      resultId?: unknown;
    };

    const eventId = typeof photoEventId === 'number' ? photoEventId : Number(photoEventId);
    const resId = typeof resultId === 'number' ? resultId : Number(resultId);

    if (!Number.isFinite(eventId) || eventId <= 0) {
      return void res.status(400).json({ error: 'photoEventId must be a positive integer' });
    }
    if (!Number.isFinite(resId) || resId <= 0) {
      return void res.status(400).json({ error: 'resultId must be a positive integer' });
    }

    const [updated] = await db
      .update(photoIdEventTable)
      .set({ confirmedResultId: resId })
      .where(eq(photoIdEventTable.id, eventId))
      .returning({ id: photoIdEventTable.id });

    if (!updated) {
      return void res.status(404).json({ error: 'Photo ID event not found' });
    }

    res.json({ ok: true, photoEventId: eventId, confirmedResultId: resId });
  } catch (err) {
    console.error('[photo/confirm]', err);
    res.status(500).json({ error: 'Failed to record confirmation' });
  }
});

export default router;
