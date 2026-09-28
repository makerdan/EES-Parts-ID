import { pool } from "@workspace/db";
import { runHealthSchemaProbe } from "../src/routes/health";

describe("request-time health schema probe", () => {
  it("destroys a timed-out real client and lets the pool serve a later query", async () => {
    const startedAt = Date.now();

    await expect(
      runHealthSchemaProbe(pool, {
        timeoutMs: 50,
        probe: async (client) => {
          await client.query("SELECT pg_sleep(1)");
          return true;
        },
      }),
    ).rejects.toThrow("Health schema probe timed out");

    expect(Date.now() - startedAt).toBeLessThan(750);
    await expect(pool.query("SELECT 1 AS recovered")).resolves.toMatchObject({
      rows: [{ recovered: 1 }],
    });
  });
});