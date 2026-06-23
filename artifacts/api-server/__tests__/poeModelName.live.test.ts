/**
 * Live regression test — Poe enrich bot (Gemini-3.1-Pro) reachability.
 *
 * Confirms that callPoeBot(POE_ENRICH_BOT, ...) returns a non-empty string,
 * proving the model name Poe accepts has not changed.
 *
 * Skipped automatically when POE_API_KEY2 is not set so the normal test suite
 * (CI, unit runs) is unaffected. Dynamic imports are used so that aiProvider.ts
 * (which throws on load when POE_API_KEY2 is absent) is never imported unless
 * the test actually runs.
 */

const hasPoeKey = Boolean(process.env["POE_API_KEY2"]);

const testIf = (condition: boolean) => (condition ? test : test.skip);

testIf(hasPoeKey)(
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
