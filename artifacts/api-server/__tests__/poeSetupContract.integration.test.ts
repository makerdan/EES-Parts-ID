/**
 * Deterministic Poe setup-contract regression guard.
 *
 * These checks intentionally exercise the application-owned contract and
 * transport utilities only; no Poe credential or network request is needed.
 */

import {
  classifyPoeError,
  redactPoeTelemetry,
  withPoeRequestTimeout,
  withPoeRetry,
} from "@workspace/integrations-poe-server";

import {
  getPoeRouteContracts,
  getVerifiedPoeRouteSnapshot,
} from "../src/lib/aiProvider";

describe("Poe setup contract", () => {
  it("declares bounded contracts for every Poe-backed feature", () => {
    const contracts = getPoeRouteContracts();
    expect(contracts.map(({ feature }) => feature)).toEqual([
      "enrich",
      "identify",
      "dimensions",
      "catalog",
    ]);
    for (const contract of contracts) {
      expect(contract.input.length).toBeGreaterThan(0);
      expect(contract.output.length).toBeGreaterThan(0);
      expect(contract.privacy).toBe("prompt_not_persisted");
      expect(contract.latencyTargetMs).toBeGreaterThan(0);
      expect(contract.authorization).toMatch(/authenticated|admin|internal/);
      expect(contract.fallback).toMatch(/replit_ai|next_verified_model|none/);
    }
  });

  it("authorizes routes from the configured registry without live catalogue state", () => {
    const snapshot = getVerifiedPoeRouteSnapshot("enrich");
    expect(snapshot.models.map((model) => model.id)).toEqual(snapshot.effective);
    expect(snapshot.models.every((model) => model.verification.source === "configured_registry")).toBe(true);
  });

  it.each([
    [401, "authentication"],
    [403, "permission"],
    [402, "quota_exhaustion"],
    [429, "rate_limited"],
    [404, "unavailable_model"],
    [422, "invalid_request"],
  ] as const)("normalizes HTTP %s as %s with the correct retry policy", async (status, kind) => {
    let attempts = 0;
    await expect(
      withPoeRetry(
        async () => {
          attempts += 1;
          throw { status };
        },
        { maxAttempts: 3, baseDelayMs: 0 },
      ),
    ).rejects.toMatchObject({ kind });
    expect(attempts).toBe(status === 429 ? 3 : 1);
  });

  it("bounds transient retries and reports cancellation", async () => {
    let attempts = 0;
    await expect(
      withPoeRetry(
        async () => {
          attempts += 1;
          throw { status: 503 };
        },
        { maxAttempts: 3, baseDelayMs: 0 },
      ),
    ).rejects.toMatchObject({ kind: "upstream" });
    expect(attempts).toBe(3);

    const controller = new AbortController();
    const pending = withPoeRequestTimeout(
      () => new Promise<never>(() => {}),
      10_000,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancellation" });
  });

  it("keeps telemetry bounded to operational metadata", () => {
    const telemetry = redactPoeTelemetry({
      route: "enrich",
      model: "live-model",
      endpoint: "https://evil.example/collect?prompt=secret",
      outcome: "failure",
      latencyMs: 99_999_999,
      retries: 99,
      fallback: false,
      cache: "not_used",
      requestId: "request-id",
    });
    expect(telemetry).toMatchObject({
      route: "enrich",
      model: "live-model",
      endpoint: "https://api.poe.com/v1/chat/completions",
      retries: 3,
    });
    expect(JSON.stringify(telemetry)).not.toMatch(/secret|prompt|image|api.?key/i);
  });

  it("keeps the shared error vocabulary stable", () => {
    const kinds: Array<ReturnType<typeof classifyPoeError>> = [
      "authentication",
      "permission",
      "quota_exhaustion",
      "rate_limited",
      "unavailable_model",
      "timeout",
      "cancellation",
      "invalid_request",
      "upstream",
    ];
    expect(kinds).toHaveLength(9);
  });
});