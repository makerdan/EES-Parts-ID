/**
 * Integration tests for graceful shutdown of catalog-pdf background loops.
 *
 * Covers:
 * 1. shutdownCatalogPdfLoops flips the shutdown flag so page loops stop at the
 *    next page boundary.
 * 2. Loops that drain within the timeout: jobs they left in a terminal state
 *    are not touched.
 * 3. Loops that outlive the bounded wait: their jobs are force-marked "failed"
 *    with the resumable shutdown message — no job stays stuck in "processing".
 * 4. No active loops: resolves immediately without touching unrelated jobs.
 */

// ── Env vars — must be set before any module is imported ──────────────────────
process.env.ADMIN_PASSWORD = "jest-shutdown-secret";

// ── Mock heavy AI modules pulled in by catalogPdf.ts at import time ───────────
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

// ── Imports ───────────────────────────────────────────────────────────────────
import { eq, inArray } from "drizzle-orm";
import { db, catalogPdfJobTable } from "@workspace/db";
import {
  SHUTDOWN_ERROR_MESSAGE,
  isShuttingDown,
  registerJobLoopForTests,
  resetShutdownStateForTests,
  shutdownCatalogPdfLoops,
} from "../routes/catalogPdf";

const seededJobIds: number[] = [];

async function seedJob(status: string): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: "EATON",
      filename: "jest-shutdown-test.pdf",
      status,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed catalogPdfJob row");
  seededJobIds.push(row.id);
  return row.id;
}

async function getJob(jobId: number): Promise<{ status: string; errorMessage: string | null } | undefined> {
  const [row] = await db
    .select({ status: catalogPdfJobTable.status, errorMessage: catalogPdfJobTable.errorMessage })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);
  return row;
}

afterEach(() => {
  resetShutdownStateForTests();
});

afterAll(async () => {
  if (seededJobIds.length > 0) {
    await db.delete(catalogPdfJobTable).where(inArray(catalogPdfJobTable.id, seededJobIds));
  }
}, 15_000);

describe("shutdownCatalogPdfLoops", () => {
  it("flips the shutdown flag so page loops stop at the next boundary", async () => {
    expect(isShuttingDown()).toBe(false);
    await shutdownCatalogPdfLoops(50);
    expect(isShuttingDown()).toBe(true);
  });

  it("resolves immediately with no active loops and leaves unrelated jobs alone", async () => {
    const jobId = await seedJob("processing");
    await shutdownCatalogPdfLoops(50);
    // Untracked jobs are covered by the startup orphan-recovery path instead.
    const row = await getJob(jobId);
    expect(row?.status).toBe("processing");
  });

  it("does not touch a job whose loop drains to a terminal state in time", async () => {
    const jobId = await seedJob("processing");
    // Simulated loop: reacts to the shutdown flag by finishing its job cleanly.
    const loop = (async () => {
      await new Promise((r) => setTimeout(r, 20));
      await db
        .update(catalogPdfJobTable)
        .set({ status: "done", finishedAt: new Date() })
        .where(eq(catalogPdfJobTable.id, jobId));
    })();
    registerJobLoopForTests(jobId, loop);

    await shutdownCatalogPdfLoops(5_000);

    const row = await getJob(jobId);
    expect(row?.status).toBe("done");
    expect(row?.errorMessage).toBeNull();
  });

  it("force-marks a job resumable-failed when its loop outlives the bounded wait", async () => {
    const jobId = await seedJob("processing");
    // Simulated hung loop (e.g. slow AI call) that never settles in time.
    let release: () => void = () => {};
    const hungLoop = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerJobLoopForTests(jobId, hungLoop);

    await shutdownCatalogPdfLoops(100);

    const row = await getJob(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe(SHUTDOWN_ERROR_MESSAGE);

    // Let the fake loop settle so it does not leak past the test.
    release();
    await hungLoop;
  });

  it("also sweeps pending jobs tracked in the registry", async () => {
    const jobId = await seedJob("pending");
    let release: () => void = () => {};
    const hungLoop = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerJobLoopForTests(jobId, hungLoop);

    await shutdownCatalogPdfLoops(100);

    const row = await getJob(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe(SHUTDOWN_ERROR_MESSAGE);

    release();
    await hungLoop;
  });
});
