/**
 * Live regression test — Poe enrich bot (Gemini-3.1-Pro) reachability.
 *
 * Confirms that callPoeBot(POE_ENRICH_BOT, ...) returns a non-empty string,
 * proving the model name Poe accepts has not changed.
 *
 * This is opt-in because the external provider can be unavailable or quota
 * limited. Set POE_LIVE_PROVIDER=1 to run it explicitly. Dynamic imports are
 * used so that aiProvider.ts (which throws on load when POE_API_KEY2 is absent)
 * is never imported unless the test actually runs.
 */

const hasPoeKey = Boolean(process.env["POE_API_KEY2"]);
const liveProviderOptIn = process.env["POE_LIVE_PROVIDER"] === "1";

const testIf = (condition: boolean) => (condition ? test : test.skip);

if (liveProviderOptIn && !hasPoeKey) {
  test("requires POE_API_KEY2 for the opt-in live provider check", () => {
    throw new Error(
      "POE_LIVE_PROVIDER=1 requires POE_API_KEY2 to be configured",
    );
  });
} else {
  testIf(liveProviderOptIn && hasPoeKey)(
    'callPoeBot(POE_ENRICH_BOT) returns a non-empty string',
    async () => {
      const { callPoeBot } = await import("../src/lib/poeBot");
      const { POE_ENRICH_BOT } = await import("../src/lib/aiProvider");

      const result = await callPoeBot(
        POE_ENRICH_BOT,
        "Reply with the single word OK.",
        "ping",
      );
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    },
    30_000,
  );
}
