import express from "express";
import supertest from "supertest";

const mockExecute = jest.fn();
const mockGetProbeSummary = jest.fn();
const mockGetStartupReadiness = jest.fn();
const mockCheckRequiredSchema = jest.fn();

jest.mock("@workspace/db", () => ({
  db: { execute: mockExecute },
  pool: { idleCount: 2, totalCount: 3 },
}));
jest.mock("../src/lib/aiProvider", () => ({
  getProbeSummary: mockGetProbeSummary,
}));
jest.mock("../src/lib/readiness", () => ({
  appReadiness: { get: mockGetStartupReadiness },
  checkRequiredSchema: mockCheckRequiredSchema,
}));

import healthRouter from "../src/routes/health";

const app = express().use("/api", healthRouter);

describe("application liveness and readiness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStartupReadiness.mockReturnValue({ status: "ready" });
    mockGetProbeSummary.mockReturnValue({});
    mockCheckRequiredSchema.mockImplementation(async (executor) => {
      const result = await executor.execute({});
      return Boolean(result?.rows?.[0]?.usable);
    });
    mockExecute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ usable: true }] });
  });

  it("reports process liveness without querying dependencies", async () => {
    await supertest(app).get("/api/livez").expect(200, { status: "ok" });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockGetProbeSummary).not.toHaveBeenCalled();
  });

  it.each(["pending", "timed_out", "failed"] as const)(
    "returns a bounded 503 while required startup is %s",
    async (startupStatus) => {
      mockGetStartupReadiness.mockReturnValue({ status: startupStatus });
      const response = await supertest(app).get("/api/healthz").expect(503);
      expect(response.body).toEqual({
        status: "error",
        detail: "startup_not_ready",
        startup_status: startupStatus,
      });
      expect(mockExecute).not.toHaveBeenCalled();
    },
  );

  it("returns a safe 503 when the database is unreachable", async () => {
    mockExecute.mockReset().mockRejectedValue(new Error("secret database detail"));
    await supertest(app)
      .get("/api/healthz")
      .expect(503, { status: "error", detail: "database_unreachable" });
  });

  it("returns a safe 503 when required schema is unavailable", async () => {
    mockExecute
      .mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ usable: false }] });
    const response = await supertest(app)
      .get("/api/healthz")
      .expect(503, { status: "error", detail: "schema_unavailable" });
    expect(response.body).not.toEqual(
      expect.objectContaining({
        table: expect.anything(),
        tables: expect.anything(),
        sql: expect.anything(),
        query: expect.anything(),
      }),
    );
    expect(response.text).not.toMatch(
      /inventory|users|admin_preferences|warehouse_zone|select|to_regclass/i,
    );
  });

  it("recovers when the required schema becomes available", async () => {
    mockExecute
      .mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ usable: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ usable: true }] });

    const unavailable = await supertest(app).get("/api/healthz").expect(503);
    expect(unavailable.body).toEqual({
      status: "error",
      detail: "schema_unavailable",
    });

    const recovered = await supertest(app).get("/api/healthz").expect(200);
    expect(recovered.body).toMatchObject({
      status: "ok",
      pool_idle: 2,
      pool_total: 3,
    });

    const internalDetails = /inventory|users|admin_preferences|warehouse_zone|migration/i;
    expect(unavailable.text).not.toMatch(internalDetails);
    expect(recovered.text).not.toMatch(internalDetails);
  });

  it("recovers after required startup becomes ready", async () => {
    mockGetStartupReadiness.mockReturnValueOnce({ status: "failed" });
    await supertest(app).get("/api/healthz").expect(503);
    await supertest(app).get("/api/healthz").expect(200);
  });

  it("keeps optional AI degradation non-blocking", async () => {
    mockGetProbeSummary.mockReturnValue({ optionalBot: "error" });
    const response = await supertest(app).get("/api/healthz").expect(200);
    expect(response.body).toMatchObject({
      status: "ok",
      bots: { optionalBot: "error" },
    });
  });
});