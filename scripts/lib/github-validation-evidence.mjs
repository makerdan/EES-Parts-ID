import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const HEX_FINGERPRINT = /^[0-9a-f]{32}$/i;
const EXACT_SHA = /^[0-9a-f]{40}$/i;
const MIRROR_ENTRIES = [".fingerprint", "SKILL.md"];
export const MAX_FAILURE_DETAIL_CHARS = 2000;

const CAPABILITY_DEFINITIONS = [
  ["actions", "Actions availability", "Confirm Actions is enabled before activation."],
  ["branchProtection", "Branch-protection support", "Confirm the branch-protection endpoint is readable for the target repository."],
  ["rulesets", "Ruleset support", "Confirm the ruleset endpoint is readable for the target repository."],
  ["selectedActions", "Selected-action policy support", "Confirm the selected-action policy endpoint and policy value are readable."],
  ["shaPinning", "SHA-pinning support", "Confirm the SHA-pinning policy endpoint and value are readable."],
];

const SECURITY_CONTROL_DEFINITIONS = [
  ["secretScanning", "Secret scanning", "Ask a repository administrator to enable secret scanning, then re-check it read-only."],
  ["pushProtection", "Push protection", "Ask a repository administrator to enable push protection, then re-check it read-only."],
  ["dependencyGraph", "Dependency graph", "Ask a repository administrator to enable the dependency graph, then re-check it read-only."],
  ["dependabot", "Dependabot alerts", "Ask a repository administrator to enable Dependabot alerts, then re-check it read-only."],
];

function isStatus(value) {
  return value === "available" || value === "unavailable" || value === "blocked" || value === "unknown";
}

function statusFromEvidence(evidence, { booleanKeys = [], valueKeys = [], expectedValues = [] } = {}) {
  if (!evidence || typeof evidence !== "object") return "unknown";
  if (isStatus(evidence.status)) return evidence.status;
  if (evidence.status === "enabled") return "available";
  if (evidence.status === "disabled") return "unavailable";
  if ([401, 403].includes(evidence.statusCode)) return "blocked";
  if (typeof evidence.statusCode === "number" && evidence.statusCode >= 400) return "unavailable";
  if (booleanKeys.some((key) => evidence[key] === false)) return "unavailable";
  if (booleanKeys.some((key) => evidence[key] === true)) return "available";
  if (valueKeys.some((key) => expectedValues.includes(evidence[key]))) return "available";
  if (evidence.statusCode >= 200 && evidence.statusCode < 300) return "available";
  return "unknown";
}

function boundedReason(status, unavailableMessage) {
  if (status === "available") return "Read-only evidence confirms this capability.";
  if (status === "blocked") return "Read-only evidence was blocked by repository or provider permissions.";
  if (status === "unavailable") return unavailableMessage;
  return "No sufficient read-only evidence was provided; availability is unknown.";
}

function requireExactSha(value, label = "revision SHA") {
  if (typeof value !== "string" || !EXACT_SHA.test(value)) {
    throw new TypeError(`${label} must be one exact 40-character hexadecimal SHA`);
  }
  return value.toLowerCase();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableString(value) {
  return JSON.stringify(stableValue(value));
}

function repositoryIdentity(repository) {
  if (typeof repository === "string" && repository.trim()) return repository.trim();
  if (!repository || typeof repository !== "object") return undefined;
  if (typeof repository.fullName === "string") return repository.fullName;
  if (typeof repository.full_name === "string") return repository.full_name;
  const owner = typeof repository.owner === "string"
    ? repository.owner
    : repository.owner?.login;
  const name = repository.name;
  return owner && typeof name === "string" ? `${owner}/${name}` : undefined;
}

function timestamp(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function providerLogAccess(job) {
  const access = job?.logAccess ?? job?.log_access ?? job?.logs;
  const failureDetail = job?.failureDetail ?? job?.failure_detail;
  const statusCode = job?.logStatusCode ?? job?.log_status_code ?? job?.statusCode;
  const denied = access === "denied"
    || access === "withheld"
    || access?.status === "denied"
    || access?.status === "withheld"
    || failureDetail?.status === "denied"
    || failureDetail?.status === "withheld"
    || [401, 403].includes(statusCode)
    || [401, 403].includes(access?.statusCode);
  if (denied) {
    const code = statusCode ?? access?.statusCode ?? failureDetail?.statusCode;
    return {
      status: "withheld",
      reason: code ? `GitHub withheld job-log details (HTTP ${code}).` : "GitHub withheld job-log details.",
    };
  }
  if (access === "unavailable" || access?.status === "unavailable" || failureDetail?.status === "unavailable") {
    return { status: "unavailable", reason: "GitHub did not provide job-log details." };
  }
  return undefined;
}

function sanitizeFailureDetail(value, maxChars) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const sanitized = value
    .replace(/\b(password|passwd|secret|token|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .trim();
  if (!sanitized) return undefined;
  return {
    status: "available",
    detail: sanitized.slice(0, maxChars),
    truncated: sanitized.length > maxChars,
    maxChars,
  };
}

function failureEvidence(job, maxChars) {
  const withheld = providerLogAccess(job);
  if (withheld) return { ...withheld, detail: undefined, maxChars };
  const detail = job?.failureDetail ?? job?.failure_detail ?? job?.failureMessage ?? job?.failure_message;
  if (detail && typeof detail === "object" && typeof detail.detail === "string") {
    return sanitizeFailureDetail(detail.detail, maxChars) ?? {
      status: "unavailable",
      reason: "No bounded failure detail was provided; the conclusion is still failed.",
      detail: undefined,
      maxChars,
    };
  }
  const bounded = sanitizeFailureDetail(detail, maxChars);
  if (bounded) return bounded;
  if (job?.conclusion === "failure") {
    return {
      status: "unavailable",
      reason: "No bounded failure detail was provided; the conclusion is still failed.",
      detail: undefined,
      maxChars,
    };
  }
  return undefined;
}

function normalizeJob(job, run, maxChars) {
  const conclusion = job?.conclusion ?? job?.status;
  return {
    id: job?.id ?? undefined,
    name: job?.name ?? undefined,
    workflow: {
      id: run?.workflow_id ?? run?.workflow?.id ?? undefined,
      name: run?.workflow_name ?? run?.workflow?.name ?? run?.name ?? undefined,
      path: run?.path ?? run?.workflow?.path ?? undefined,
    },
    run: {
      id: run?.id ?? undefined,
      attempt: run?.run_attempt ?? run?.attempt ?? 1,
    },
    status: job?.status ?? undefined,
    conclusion: conclusion ?? undefined,
    startedAt: timestamp(job?.started_at ?? job?.startedAt),
    completedAt: timestamp(job?.completed_at ?? job?.completedAt),
    failureEvidence: failureEvidence({ ...job, conclusion }, maxChars),
  };
}

function normalizeRun(run, revisionSha, maxChars) {
  const headSha = run?.head_sha ?? run?.headSha;
  if (headSha?.toLowerCase() !== revisionSha) return null;
  const jobs = Array.isArray(run?.jobs) ? run.jobs : [];
  return {
    workflow: {
      id: run?.workflow_id ?? run?.workflow?.id ?? undefined,
      name: run?.workflow_name ?? run?.workflow?.name ?? run?.name ?? undefined,
      path: run?.path ?? run?.workflow?.path ?? undefined,
    },
    run: {
      id: run?.id ?? undefined,
      attempt: run?.run_attempt ?? run?.attempt ?? 1,
    },
    revisionSha,
    event: run?.event ?? undefined,
    status: run?.status ?? undefined,
    conclusion: run?.conclusion ?? undefined,
    createdAt: timestamp(run?.created_at ?? run?.createdAt),
    startedAt: timestamp(run?.run_started_at ?? run?.started_at ?? run?.startedAt),
    updatedAt: timestamp(run?.updated_at ?? run?.updatedAt),
    completedAt: timestamp(run?.completed_at ?? run?.completedAt),
    jobs: jobs.map((job) => normalizeJob(job, run, maxChars)),
  };
}

function evidenceContext({ repository, revisionSha, policy, permissions } = {}) {
  const repositoryId = repositoryIdentity(repository);
  const normalizedRevision = revisionSha ? requireExactSha(revisionSha) : undefined;
  return {
    repository: repositoryId,
    revisionSha: normalizedRevision,
    policy: policy === undefined ? undefined : stableValue(policy),
    permissions: permissions === undefined ? undefined : stableValue(permissions),
  };
}

function contextDifference(snapshotContext, currentContext) {
  const reasons = [];
  if (!snapshotContext || !currentContext) {
    return ["evidence context is missing"];
  }
  for (const key of ["repository", "revisionSha", "policy", "permissions"]) {
    if (snapshotContext[key] === undefined || currentContext[key] === undefined) {
      reasons.push(`${key} evidence is incomplete`);
    } else if (stableString(snapshotContext[key]) !== stableString(currentContext[key])) {
      reasons.push(`${key} evidence changed`);
    }
  }
  return reasons;
}

/**
 * Normalize read-only Actions responses into a compact, exact-revision bundle.
 * Mismatched runs are deliberately excluded so a nearby revision cannot be
 * mistaken for evidence about the requested SHA.
 */
export function buildGitHubValidationEvidenceBundle({
  repository,
  revisionSha,
  runs = [],
  collectedAt,
  policy,
  permissions,
  maxFailureDetailChars = MAX_FAILURE_DETAIL_CHARS,
} = {}) {
  const exactRevision = requireExactSha(revisionSha);
  if (!Number.isInteger(maxFailureDetailChars) || maxFailureDetailChars < 1) {
    throw new TypeError("maxFailureDetailChars must be a positive integer");
  }
  const repositoryId = repositoryIdentity(repository);
  if (!repositoryId) throw new TypeError("repository must identify an owner and repository");
  const normalizedRuns = runs
    .map((run) => normalizeRun(run, exactRevision, maxFailureDetailChars))
    .filter(Boolean);
  return {
    kind: "github-validation-evidence",
    mode: "read-only",
    repository: repositoryId,
    revisionSha: exactRevision,
    exactRevision: true,
    collectedAt: timestamp(collectedAt),
    evidenceContext: evidenceContext({ repository: repositoryId, revisionSha: exactRevision, policy, permissions }),
    runCount: normalizedRuns.length,
    excludedRevisionCount: runs.length - normalizedRuns.length,
    runs: normalizedRuns,
  };
}

/**
 * Collect through caller-supplied GET-only functions. No dispatch, retry,
 * mutation, or unbounded log download is performed here.
 */
export async function collectGitHubValidationEvidence({
  repository,
  revisionSha: requestedRevisionSha,
  sha,
  listWorkflowRuns,
  listJobs,
  getFailureDetail,
  collectedAt,
  policy,
  permissions,
  maxFailureDetailChars = MAX_FAILURE_DETAIL_CHARS,
} = {}) {
  if (typeof listWorkflowRuns !== "function") throw new TypeError("listWorkflowRuns is required");
  const revisionSha = requestedRevisionSha ?? sha;
  const exactRevision = requireExactSha(revisionSha);
  const rawRunsResponse = await listWorkflowRuns({ repository, headSha: exactRevision, perPage: 100 });
  const rawRuns = Array.isArray(rawRunsResponse)
    ? rawRunsResponse
    : rawRunsResponse?.workflow_runs;
  const runs = [];
  for (const run of Array.isArray(rawRuns) ? rawRuns : []) {
    if ((run?.head_sha ?? run?.headSha)?.toLowerCase() !== exactRevision) continue;
    const jobsResponse = typeof listJobs === "function"
      ? await listJobs({ repository, runId: run.id, runAttempt: run.run_attempt ?? run.attempt ?? 1, perPage: 100 })
      : run.jobs;
    const jobs = Array.isArray(jobsResponse) ? jobsResponse : jobsResponse?.jobs;
    const normalizedJobs = Array.isArray(jobs) ? [...jobs] : [];
    if (typeof getFailureDetail === "function") {
      for (const job of normalizedJobs) {
        if ((job.conclusion ?? job.status) !== "failure") continue;
        const detail = await getFailureDetail({
          repository,
          runId: run.id,
          jobId: job.id,
          maxChars: maxFailureDetailChars,
        });
        if (detail !== undefined) job.failureDetail = detail;
      }
    }
    runs.push({ ...run, jobs: normalizedJobs });
  }
  return buildGitHubValidationEvidenceBundle({
    repository,
    revisionSha: exactRevision,
    runs,
    collectedAt,
    policy,
    permissions,
    maxFailureDetailChars,
  });
}

export function buildGitHubProtectionSnapshot({
  repository,
  revisionSha,
  policy,
  permissions,
  capabilities,
  controls,
  capturedAt,
} = {}) {
  const context = evidenceContext({ repository, revisionSha, policy, permissions });
  if (!context.repository || !context.revisionSha || context.policy === undefined || context.permissions === undefined) {
    throw new TypeError("protection snapshots require repository, revision, policy, and permission evidence");
  }
  return {
    kind: "github-protection-snapshot",
    mode: "read-only",
    status: "captured",
    capturedAt: timestamp(capturedAt),
    evidenceContext: context,
    capabilities,
    controls,
  };
}

export function evaluateGitHubProtectionFreshness(snapshot, currentContext = {}) {
  const snapshotContext = snapshot?.evidenceContext;
  const current = evidenceContext(currentContext);
  const reasons = contextDifference(snapshotContext, current);
  return {
    status: reasons.length ? "stale" : "current",
    current: reasons.length === 0,
    reasons,
    repository: current.repository,
    revisionSha: current.revisionSha,
  };
}

function staleProtectionReport(report, freshness, itemKey) {
  if (freshness.current) {
    return {
      ...report,
      current: true,
      freshness,
    };
  }
  const items = Object.fromEntries(
    Object.entries(report[itemKey]).map(([key, item]) => [
      key,
      {
        ...item,
        status: "stale",
        summary: "Historical read-only evidence is stale and cannot support a current claim.",
        nextAction: "Re-collect read-only evidence with the current repository, revision, policy, and permission context.",
      },
    ]),
  );
  return {
    ...report,
    current: false,
    status: "stale",
    freshness,
    [itemKey]: items,
  };
}

/**
 * Build a capability report only after checking the snapshot against the
 * current read-only context. Omitting either argument deliberately produces a
 * stale report rather than allowing historical evidence to look current.
 */
export function buildGitHubCapabilityReport(evidence = {}, { snapshot, currentContext } = {}) {
  const capabilityEvidence = {
    actions: statusFromEvidence(evidence.actions, { booleanKeys: ["enabled", "available"] }),
    branchProtection: statusFromEvidence(evidence.branchProtection, { booleanKeys: ["supported", "available"] }),
    rulesets: statusFromEvidence(evidence.rulesets, { booleanKeys: ["supported", "available"] }),
    selectedActions: statusFromEvidence(evidence.selectedActions, {
      booleanKeys: ["supported", "available"],
      valueKeys: ["allowedActions", "policy"],
      expectedValues: ["selected"],
    }),
    shaPinning: statusFromEvidence(evidence.shaPinning, {
      booleanKeys: ["required", "shaPinningRequired", "supported", "available"],
    }),
  };

  const capabilities = Object.fromEntries(
    CAPABILITY_DEFINITIONS.map(([key, label, nextAction]) => {
      const status = capabilityEvidence[key];
      return [
        key,
        {
          label,
          status,
          summary: boundedReason(status, `${label} is unavailable from the read-only provider evidence.`),
          nextAction: status === "available" ? undefined : nextAction,
        },
      ];
    }),
  );

  const statuses = Object.values(capabilities).map(({ status }) => status);
  const report = {
    mode: "read-only",
    activationAttempted: false,
    status: statuses.includes("blocked") || statuses.includes("unavailable")
      ? "blocked"
      : statuses.includes("unknown")
        ? "unknown"
        : "ready",
    capabilities,
  };
  return staleProtectionReport(
    report,
    evaluateGitHubProtectionFreshness(snapshot, currentContext),
    "capabilities",
  );
}

function controlStatus(control, evidence) {
  if (!evidence || typeof evidence !== "object") return "unknown";
  if (evidence.status === "enabled" || evidence.status === "verified") return "verified";
  if (evidence.status === "disabled") return "unavailable";
  if (isStatus(evidence.status)) return evidence.status === "available" ? "verified" : evidence.status;
  if (evidence.enabled === false || evidence.available === false) return "unavailable";
  if (evidence.enabled === true || evidence.available === true) return "verified";
  const endpointStatusCode =
    evidence.statusCode ?? evidence.vulnerabilityAlertsStatusCode ?? evidence.alertsStatusCode;
  if ([401, 403].includes(endpointStatusCode)) return "blocked";
  if (typeof endpointStatusCode === "number" && endpointStatusCode >= 400) return "unavailable";
  if (control === "dependencyGraph" && evidence.vulnerabilityAlertsStatusCode === 204) return "verified";
  if (control === "dependabot" && evidence.alertsStatusCode === 200) return "verified";
  return "unknown";
}

/**
 * Build a security-control report only after checking the snapshot against the
 * current read-only context. Omitting either argument deliberately produces a
 * stale report rather than allowing historical evidence to look verified.
 */
export function buildGitHubSecurityControlReport(evidence = {}, { snapshot, currentContext } = {}) {
  const controls = Object.fromEntries(
    SECURITY_CONTROL_DEFINITIONS.map(([key, label, nextAction]) => {
      const status = controlStatus(key, evidence[key]);
      return [
        key,
        {
          label,
          status,
          summary: status === "verified"
            ? "Read-only evidence confirms this control."
            : status === "blocked"
              ? "Read-only evidence was blocked by repository or provider permissions."
              : status === "unavailable"
                ? `${label} is disabled or unavailable in the read-only evidence.`
                : "No sufficient read-only evidence was provided; control status is unknown.",
          nextAction: status === "verified" ? undefined : nextAction,
        },
      ];
    }),
  );
  const statuses = Object.values(controls).map(({ status }) => status);
  const report = {
    mode: "read-only",
    mutationAttempted: false,
    status: statuses.includes("blocked") || statuses.includes("unavailable")
      ? "blocked"
      : statuses.includes("unknown")
        ? "unknown"
        : "verified",
    controls,
  };
  return staleProtectionReport(
    report,
    evaluateGitHubProtectionFreshness(snapshot, currentContext),
    "controls",
  );
}

export function inspectOptionalRuntimeSkillMirror(mirrorRoot) {
  let mirrorStat;
  try {
    mirrorStat = statSync(mirrorRoot);
  } catch (error) {
    if (error.code === "ENOENT") return { outcome: "absent" };
    return { outcome: "invalid", reason: "unreadable-mirror" };
  }
  if (!mirrorStat.isDirectory()) return { outcome: "invalid", reason: "mirror-is-not-directory" };

  let entries;
  try {
    entries = readdirSync(mirrorRoot).sort();
  } catch {
    return { outcome: "invalid", reason: "unreadable-mirror" };
  }
  if (JSON.stringify(entries) !== JSON.stringify(MIRROR_ENTRIES)) {
    return { outcome: "invalid", reason: "missing-or-extra-entry" };
  }

  for (const entry of MIRROR_ENTRIES) {
    try {
      if (!statSync(join(mirrorRoot, entry)).isFile()) {
        return { outcome: "invalid", reason: `non-file-${entry}` };
      }
    } catch {
      return { outcome: "invalid", reason: `missing-${entry}` };
    }
  }

  let fingerprint;
  try {
    fingerprint = readFileSync(join(mirrorRoot, ".fingerprint"), "utf8").trim();
  } catch {
    return { outcome: "invalid", reason: "missing-fingerprint" };
  }
  if (!HEX_FINGERPRINT.test(fingerprint)) {
    return { outcome: "invalid", reason: "malformed-fingerprint" };
  }
  return { outcome: "valid" };
}