import { getAuth } from "@clerk/express";
import { HELP_ANSWER_CODE, HELP_ERROR_CODE, type HelpErrorCode } from "@workspace/api-zod";
import { type Request, type Response, Router } from "express";

import {
  getCachedAnswer,
  hashQuestion,
  normalizeQuestion,
  setCachedAnswer,
} from "../lib/answerCache";
import {
  answerHelpQuestion,
  HELP_ASSISTANT_LIMITS,
  HelpAssistantError,
  helpCacheInput,
} from "../lib/helpAssistant";
import {
  getHelpResponse,
  HELP_LIMITS,
  type HelpAudience,
} from "../lib/helpContent";
import { getLogger } from "../lib/logger";
import { helpAskLimiter } from "../lib/rateLimiter";
import { hasCurrentAdminAccess, requireAdminAuth } from "../middlewares/requireAdminAuth";

const router = Router();
const WORKFLOW_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sendHelpError(
  res: Response,
  status: number,
  body: {
    error: string;
    code: HelpErrorCode;
    retryable?: boolean;
    contactFallback?: boolean;
  },
): void {
  res.status(status).json(body);
}

function parseWorkflow(req: Request): string | undefined {
  const raw = req.query["workflow"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > HELP_LIMITS.maxWorkflowLength || !WORKFLOW_PATTERN.test(raw)) {
    throw new Error("Invalid workflow");
  }
  return raw;
}

function rejectAudienceOverride(req: Request): void {
  if (req.query["audience"] !== undefined) throw new Error("Audience is selected by the endpoint");
}

function sendHelp(audience: HelpAudience, req: Request, res: Response): void {
  try {
    rejectAudienceOverride(req);
    const workflow = parseWorkflow(req);
    const payload = getHelpResponse(audience, workflow);
    if (payload.records.length === 0) {
      res.status(404).json({ error: "Help topic not found" });
      return;
    }

    res.set("Cache-Control", "private, no-store");
    res.set("Vary", "Authorization");
    res.json(payload);
  } catch (err) {
    if (err instanceof Error && (err.message === "Invalid workflow" || err.message === "Audience is selected by the endpoint")) {
      res.status(400).json({ error: "Invalid Help request" });
      return;
    }
    res.status(500).json({ error: "Help content unavailable" });
  }
}

// GET /help — authenticated general Help records.
router.get("/", (req, res) => sendHelp("general", req, res));

// GET /help/admin — current admin + MFA required; no client role flag is used.
router.get("/admin", requireAdminAuth, (req, res) => sendHelp("admin", req, res));

// POST /help/ask — app-only, corpus-grounded Help Q&A.
router.post("/ask", async (req, res) => {
  const reqLogger = getLogger(res);
  try {
    const rateLimitKey = getAuth(req)?.userId ?? String(req.ip ?? "unknown");
    const rateCheck = await helpAskLimiter.check(rateLimitKey, res.locals.requestId as string | undefined);
    if (!rateCheck.allowed) {
      res.set("Retry-After", String(Math.ceil(rateCheck.retryAfterMs / 1000)));
      return void res.status(429).json({
        error: "Too many Help requests. Please retry shortly or contact support.",
        code: HELP_ERROR_CODE.RATE_LIMITED,
        retryable: true,
      });
    }

    const body = req.body as {
      question?: unknown;
      history?: unknown;
    };
    if (typeof body?.question !== "string" || !body.question.trim()) {
      return void sendHelpError(res, 400, { error: "question is required", code: HELP_ERROR_CODE.INVALID_REQUEST });
    }
    if (body.question.length > HELP_ASSISTANT_LIMITS.maxQuestionLength) {
      return void sendHelpError(res, 400, {
        error: `question must be ${HELP_ASSISTANT_LIMITS.maxQuestionLength} characters or fewer`,
        code: HELP_ERROR_CODE.INVALID_REQUEST,
      });
    }

    const history = body.history === undefined ? [] : body.history;
    if (!Array.isArray(history) || history.length > HELP_ASSISTANT_LIMITS.maxHistoryItems) {
      return void sendHelpError(res, 400, {
        error: `history must contain at most ${HELP_ASSISTANT_LIMITS.maxHistoryItems} items`,
        code: HELP_ERROR_CODE.INVALID_REQUEST,
      });
    }
    for (const item of history) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as { q?: unknown }).q !== "string" ||
        typeof (item as { a?: unknown }).a !== "string" ||
        (item as { q: string }).q.length > HELP_ASSISTANT_LIMITS.maxHistoryItemLength ||
        (item as { a: string }).a.length > HELP_ASSISTANT_LIMITS.maxHistoryItemLength
      ) {
        return void sendHelpError(res, 400, {
          error: `each history item must have q and a strings of ${HELP_ASSISTANT_LIMITS.maxHistoryItemLength} characters or fewer`,
          code: HELP_ERROR_CODE.INVALID_REQUEST,
        });
      }
    }

    // Admin context is never selected from a request field. This second
    // authorization read is deliberately independent of requireAppAuth.locals.
    let includeAdmin = false;
    try {
      includeAdmin = await hasCurrentAdminAccess(req);
    } catch {
      throw new HelpAssistantError(
        HELP_ERROR_CODE.AUTHORIZATION_UNAVAILABLE,
        "Help authorization is temporarily unavailable. Please retry or contact support.",
        503,
        true,
      );
    }
    const normalizedQuestion = normalizeQuestion(body.question);
    const typedHistory = history as Array<{ q: string; a: string }>;
    const cacheInput = helpCacheInput(body.question, includeAdmin, typedHistory);
    const cacheHash = hashQuestion(cacheInput.normalized, cacheInput.history);
    const hasHistory = (cacheInput.history?.length ?? 0) > 0;

    if (!hasHistory) {
      const cached = await getCachedAnswer(cacheHash);
      if (cached !== null) {
        reqLogger.debug({ audience: includeAdmin ? "admin" : "general" }, "help.ask cache hit");
        return void res.json({
          answer: cached,
          code: HELP_ANSWER_CODE,
          cached: true,
        });
      }
    }

    const result = await answerHelpQuestion({
      question: body.question.trim(),
      history: typedHistory,
      includeAdmin,
    });

    if (!hasHistory) {
      // The cache key contains Help schema/content versions and audience, so a
      // privileged answer can never be reused for a worker request.
      setCachedAnswer(cacheHash, normalizedQuestion, result.answer, false).catch((err) => {
        reqLogger.warn({ err }, "help.ask cache write failed");
      });
    }
    return void res.json({
      answer: result.answer,
      code: HELP_ANSWER_CODE,
      cached: false,
    });
  } catch (err) {
    if (err instanceof HelpAssistantError) {
      reqLogger.warn({ code: err.code }, "help.ask handled failure");
      return void sendHelpError(res, err.status, {
        error: err.message,
        code: err.code,
        retryable: err.retryable,
        contactFallback: err.code !== HELP_ERROR_CODE.UNSUPPORTED,
      });
    }
    reqLogger.error({ err }, "help.ask authorization or request failure");
    return void sendHelpError(res, 503, {
      error: "The Help assistant is temporarily unavailable. Please retry or contact support.",
      code: HELP_ERROR_CODE.PROVIDER_UNAVAILABLE,
      retryable: true,
      contactFallback: true,
    });
  }
});

export default router;
