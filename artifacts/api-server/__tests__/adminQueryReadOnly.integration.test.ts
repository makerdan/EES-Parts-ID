jest.mock("openai", () => {
  const { createOpenAIMock } = jest.requireActual(
    "./helpers/openaiMock",
  ) as typeof import("./helpers/openaiMock");
  return createOpenAIMock(jest);
});

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: jest.fn() } },
    audio: { transcriptions: { create: jest.fn() } },
  },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

import supertest from "supertest";

import { pool } from "@workspace/db";

import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";

const adminToken = signAdminToken();

describe("admin query PostgreSQL read-only boundary", () => {
  it("does not advance a sequence when a SELECT calls nextval", async () => {
    const workerId = process.env.JEST_WORKER_ID ?? "single";
    const sequenceName = `admin_query_ro_${process.pid}_${workerId}`;
    const qualifiedSequence = `public."${sequenceName}"`;

    await pool.query(`CREATE SEQUENCE ${qualifiedSequence} START WITH 1`);
    try {
      const response = await supertest(app)
        .post("/api/admin/query")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          sql: `SELECT nextval('public.${sequenceName}'::regclass) AS sequence_value`,
        })
        .expect(500);

      expect(response.body).toMatchObject({
        error: "Query failed. Please retry or contact support with the request ID.",
        requestId: response.headers["x-request-id"],
      });
      expect(JSON.stringify(response.body)).not.toContain("read-only transaction");

      const state = await pool.query(
        `SELECT last_value, is_called FROM ${qualifiedSequence}`,
      );
      expect(state.rows[0]).toEqual({ last_value: "1", is_called: false });
    } finally {
      await pool.query(`DROP SEQUENCE IF EXISTS ${qualifiedSequence}`);
    }
  });

  it("filters protected source columns even when the selected label is an alias", async () => {
    const response = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        sql: "SELECT email AS public_contact FROM users LIMIT 1",
      })
      .expect(200);

    expect(response.body.columns).not.toContain("public_contact");
    expect(response.body.rows.every(
      (row: Record<string, unknown>) => !("public_contact" in row),
    )).toBe(true);
    expect(response.body.strippedColumns).toContain("public_contact");
  });

  it("continues to return ordinary permitted reads", async () => {
    const response = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sql: "SELECT 42 AS allowed_value" })
      .expect(200);

    expect(response.body).toMatchObject({
      columns: ["allowed_value"],
      rows: [{ allowed_value: 42 }],
      rowCount: 1,
      truncated: false,
    });
  });
});