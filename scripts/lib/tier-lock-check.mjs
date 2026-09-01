#!/usr/bin/env node
/**
 * Fail-closed task validation tier resolution.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

export const TIER_NAMES = ["test-fast", "test-standard", "test-standard-plus", "test-heavy"];
export const TIER_ORDER = TIER_NAMES;
export const SHORT_TIERS = ["fast", "standard", "standard-plus", "heavy"];
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
  const validation = content.match(/^## Validation\b[^\n]*\n([\s\S]*?)(?=^## |^# |$)/m);
  if (!validation) return { ok: false, error: "plan is missing ## Validation" };
  const command = validation[1].match(/^\*\*Command:\*\*\s*`?([^\n`]+)`?/m);
  const normalized = normalizeTier(command?.[1]);
  if (!normalized) return { ok: false, error: "## Validation has no valid **Command:** tier" };
  const legacy = content.match(/^## Validation tier\s*\n\s*(fast|standard|standard-plus|heavy)\s*$/m);
  if (!legacy) return { ok: false, error: "plan is missing a valid ## Validation tier declaration" };
  if (legacy[1] !== normalized) {
    return { ok: false, error: `tier declarations conflict: ## Validation says test-${normalized}, ## Validation tier says ${legacy[1]}` };
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