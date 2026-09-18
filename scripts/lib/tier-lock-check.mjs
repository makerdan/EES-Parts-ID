#!/usr/bin/env node
/**
 * Fail-closed task validation tier resolution.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

export const TIER_NAMES = ["test-fast", "test-standard", "test-standard-plus", "test-heavy"];
export const TIER_ORDER = TIER_NAMES;
export const SHORT_TIERS = ["fast", "standard", "standard-plus", "heavy"];
export const TERMINAL_VALIDATION_STATUSES = ["PASSED", "FAILED", "STOPPED", "ERROR", "TIMED_OUT"];
const TASKS_ROOT = resolve(".local/tasks");

export function normalizeTier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^test-/, "");
  return SHORT_TIERS.includes(normalized) ? normalized : null;
}

export function tierCommand(shortTier) {
  const normalized = normalizeTier(shortTier);
  return normalized ? `test-${normalized}` : null;
}

export function validatePlanPath(planFile) {
  if (typeof planFile !== "string" || planFile.trim() === "") {
    return { ok: false, error: "task plan path is missing" };
  }
  const path = resolve(planFile);
  const rel = relative(TASKS_ROOT, path);
  if (rel.startsWith("..") || rel.includes(`${"/"}${".."}`) || rel === "") {
    return { ok: false, error: `task plan must be inside ${TASKS_ROOT}` };
  }
  if (!path.endsWith(".md")) return { ok: false, error: "task plan must be a markdown file" };
  if (!existsSync(path)) return { ok: false, error: `task plan not found: ${path}` };
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return { ok: false, error: `task plan cannot be a symbolic link: ${path}` };
    if (!stats.isFile()) return { ok: false, error: `task plan is not a file: ${path}` };
    const real = realpathSync(path);
    const realRel = relative(realpathSync(TASKS_ROOT), real);
    if (!realRel || realRel.startsWith("..")) return { ok: false, error: `task plan resolves outside ${TASKS_ROOT}` };
  } catch {
    return { ok: false, error: `task plan cannot be read: ${path}` };
  }
  return { ok: true, path };
}

export function parsePlanTier(content) {
  const validations = [...content.matchAll(/^## Validation\s*$\n([\s\S]*?)(?=^## |^# |$)/gm)];
  if (validations.length === 0) return { ok: false, error: "plan is missing ## Validation" };
  if (validations.length !== 1) return { ok: false, error: "plan has conflicting ## Validation sections" };
  const commands = [...validations[0][1].matchAll(/^\*\*Command:\*\*\s*`?([^\n`]+)`?\s*$/gm)];
  if (commands.length !== 1) return { ok: false, error: "## Validation must contain exactly one **Command:** tier" };
  const normalized = normalizeTier(commands[0][1]);
  if (!normalized) return { ok: false, error: "## Validation has no valid **Command:** tier" };
  const legacyDeclarations = [...content.matchAll(/^## Validation tier\s*$\n\s*([^\n]+)\s*$/gm)];
  if (legacyDeclarations.length !== 1 || !SHORT_TIERS.includes(legacyDeclarations[0][1].trim())) {
    return { ok: false, error: "plan must contain exactly one valid ## Validation tier declaration" };
  }
  const legacy = legacyDeclarations[0][1].trim();
  if (legacy !== normalized) {
    return { ok: false, error: `tier declarations conflict: ## Validation says test-${normalized}, ## Validation tier says ${legacy}` };
  }
  return { ok: true, tier: normalized, command: `test-${normalized}` };
}

export function resolvePlanTier(planFile) {
  const checked = validatePlanPath(planFile);
  if (!checked.ok) return checked;
  let content;
  try {
    content = readFileSync(checked.path, "utf8");
  } catch {
    return { ok: false, error: `task plan cannot be read: ${checked.path}` };
  }
  const parsed = parsePlanTier(content);
  return parsed.ok ? { ...parsed, path: checked.path, content } : parsed;
}

export function resolveTaskCompletionSelection(planFile = process.env.TASK_PLAN_FILE) {
  const plan = resolvePlanTier(planFile);
  if (!plan.ok) return { ok: false, error: `COMPLETION-LOCK VIOLATION: ${plan.error}` };
  return {
    ok: true,
    source: "task-plan",
    completionEligible: true,
    path: plan.path,
    tier: plan.tier,
    command: plan.command,
    commandIds: [plan.command],
  };
}

export function selectExplicitValidation(command) {
  const tier = normalizeTier(command);
  if (!tier) return { ok: false, error: `invalid registered validation command "${command ?? ""}"` };
  return {
    ok: true,
    source: "explicit",
    completionEligible: false,
    tier,
    command: tierCommand(tier),
    commandIds: [tierCommand(tier)],
  };
}

export function validateTaskCompletionEvidence(selection, run) {
  if (!selection?.ok || selection.source !== "task-plan" || selection.completionEligible !== true) {
    return { ok: false, error: "completion evidence requires a task-plan-locked selection" };
  }
  const runId = run?.runId ?? run?.id;
  if (typeof runId !== "string" || runId.trim() === "") {
    return { ok: false, error: "completion evidence is missing a validation run ID" };
  }
  if (!TERMINAL_VALIDATION_STATUSES.includes(run?.status)) {
    return { ok: false, error: `validation run ${runId} is not terminal` };
  }
  if (run.status !== "PASSED") {
    return { ok: false, error: `validation run ${runId} did not pass (status ${run.status})` };
  }
  if (!Array.isArray(run.commands) || run.commands.length !== 1) {
    return { ok: false, error: `validation run ${runId} must contain exactly one command` };
  }
  const command = run.commands[0];
  if (command?.commandId !== selection.command || command?.status !== "PASSED") {
    return { ok: false, error: `validation run ${runId} does not prove ${selection.command} passed` };
  }
  return { ok: true, runId, command: selection.command, status: "PASSED" };
}

export function assertTierLock({ planFile = process.env.TASK_PLAN_FILE, requestedTier, allowNoPlan = false } = {}) {
  const requested = normalizeTier(requestedTier);
  if (!requested) {
    return { ok: false, error: `invalid requested tier "${requestedTier ?? ""}"` };
  }
  if (!planFile) {
    if (allowNoPlan) {
      return { ok: true, tier: requested, command: `test-${requested}`, bypassed: true };
    }
    return {
      ok: false,
      error: "TIER-LOCK VIOLATION: TASK_PLAN_FILE is required; use --allow-no-plan only for explicit ad-hoc validation",
    };
  }
  const plan = resolvePlanTier(planFile);
  if (!plan.ok) return { ok: false, error: `TIER-LOCK VIOLATION: ${plan.error}` };
  if (plan.tier !== requested) {
    return {
      ok: false,
      error: `TIER-LOCK VIOLATION: plan declares test-${plan.tier}, requested test-${requested}; requested tier must match the plan`,
    };
  }
  return { ...plan, bypassed: false };
}