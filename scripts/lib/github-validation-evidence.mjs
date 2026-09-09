import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const HEX_FINGERPRINT = /^[0-9a-f]{32}$/i;
const MIRROR_ENTRIES = [".fingerprint", "SKILL.md"];

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

export function buildGitHubCapabilityReport(evidence = {}) {
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
  return {
    mode: "read-only",
    activationAttempted: false,
    status: statuses.includes("blocked") || statuses.includes("unavailable")
      ? "blocked"
      : statuses.includes("unknown")
        ? "unknown"
        : "ready",
    capabilities,
  };
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

export function buildGitHubSecurityControlReport(evidence = {}) {
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
  return {
    mode: "read-only",
    mutationAttempted: false,
    status: statuses.includes("blocked") || statuses.includes("unavailable")
      ? "blocked"
      : statuses.includes("unknown")
        ? "unknown"
        : "verified",
    controls,
  };
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