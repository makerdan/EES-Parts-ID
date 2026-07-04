/**
 * Unit tests for GET /admin/me error handling.
 *
 * Mounts only the admin router on a minimal Express app so that res.locals
 * can be injected directly via a test middleware, bypassing the real
 * requireAppAuth database round-trip.
 *
 * Covers:
 * - Happy path: appUser set with role="admin" → { isAdmin: true }
 * - Happy path: appUser set with role="user"  → { isAdmin: false }
 * - Error path: appUser.role getter throws     → 500 JSON error response
 */

jest.mock("@workspace/db", () => ({
  db: {},
  adminPreferencesTable: {},
  usersTable: {},
}));

jest.mock("../lib/aiProvider", () => ({
  getProvider: jest.fn().mockReturnValue("openai"),
  setProvider: jest.fn(),
}));

jest.mock("../middlewares/requireAdminAuth", () => ({
  requireAdminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express, { type NextFunction, type Request, type Response } from "express";
import supertest from "supertest";
import adminRouter from "../routes/admin";

function buildApp(injectLocals: (res: Response) => void) {
  const app = express();
  app.use(express.json());

  app.use((_req: Request, res: Response, next: NextFunction) => {
    injectLocals(res);
    next();
  });

  app.use("/admin", adminRouter);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message || "Internal server error" });
  });

  return app;
}

describe("GET /admin/me — happy path via res.locals.appUser", () => {
  it("returns { isAdmin: true } when appUser.role is 'admin'", async () => {
    const app = buildApp((res) => {
      res.locals.appUser = { role: "admin" };
    });

    const response = await supertest(app).get("/admin/me").expect(200);

    expect(response.body).toEqual({ isAdmin: true });
  });

  it("returns { isAdmin: false } when appUser.role is 'user'", async () => {
    const app = buildApp((res) => {
      res.locals.appUser = { role: "user" };
    });

    const response = await supertest(app).get("/admin/me").expect(200);

    expect(response.body).toEqual({ isAdmin: false });
  });
});

describe("GET /admin/me — error path", () => {
  it("returns 500 JSON when res.locals.appUser has a role getter that throws", async () => {
    const app = buildApp((res) => {
      const malformed = {} as { role?: string };
      Object.defineProperty(malformed, "role", {
        get() {
          throw new Error("middleware corruption: role is unreadable");
        },
        enumerable: true,
      });
      res.locals.appUser = malformed;
    });

    const response = await supertest(app).get("/admin/me").expect(500);

    expect(response.body).toHaveProperty("error");
  });
});
