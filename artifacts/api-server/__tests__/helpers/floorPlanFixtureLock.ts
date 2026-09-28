import { pool } from "@workspace/db";

const FLOOR_PLAN_FIXTURE_LOCK_KEY = 0x46504c4e;

export async function acquireFloorPlanFixtureLock(): Promise<
  () => Promise<void>
> {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1::integer)", [
      FLOOR_PLAN_FIXTURE_LOCK_KEY,
    ]);
  } catch (error) {
    client.release();
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;

    try {
      await client.query("SELECT pg_advisory_unlock($1::integer)", [
        FLOOR_PLAN_FIXTURE_LOCK_KEY,
      ]);
    } catch (error) {
      console.warn(
        `[floor-plan fixture cleanup] advisory unlock failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      try {
        client.release();
      } catch (error) {
        console.warn(
          `[floor-plan fixture cleanup] client release failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };
}