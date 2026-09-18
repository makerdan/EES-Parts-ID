import { Router } from "express";

const router = Router();

// ── GET /auth/status ──────────────────────────────────────────────────────────
// Protected route — passes through requireAppAuth middleware.
// Returns 200 if the caller's Clerk session is valid and the account is approved.
// Returns 403 { code: "pending" } or { code: "banned" } otherwise (from middleware).
// Used by the mobile app immediately after sign-in to check approval status.
router.get("/status", (_req, res) => {
  res.json({ status: "approved" });
});

export default router;
