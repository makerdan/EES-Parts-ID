#!/usr/bin/env bash
set -euo pipefail

readonly POLICY_REFUSAL_STATUS=2
readonly VERIFICATION_FAILURE_STATUS=3
readonly USAGE_STATUS=64
readonly LOCKED_VERIFY_RESOURCE="public-release"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"

policy_refusal() {
  printf '%s\n' \
    "[github-sync] POLICY_REFUSAL: direct synchronization is disabled; use the protected snapshot PR flow for makerdan/EES-Parts-ID." >&2
  exit "$POLICY_REFUSAL_STATUS"
}

verification_failure() {
  printf '[github-sync] VERIFICATION_FAILURE: %s\n' "$1" >&2
  exit "$VERIFICATION_FAILURE_STATUS"
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/sync-github.sh
  scripts/sync-github.sh --sync
  scripts/sync-github.sh --locked-verify \
    --approved-ref REF --approved-commit COMMIT --release-id ID
    --release-record PATH [--repo PATH]
  scripts/sync-github.sh --verify --expected-revision REVISION
    --approved-ref REF --approved-commit COMMIT --release-id ID
    --release-record PATH [--repo PATH]

Direct synchronization is unsupported. Verification is read-only and accepts
only refs under refs/heads/review/, refs/heads/snapshot/, matching remote
tracking refs, or refs/pull/<number>/head. Successful verification writes one
immutable JSON release record and refuses to replace an existing record.
--locked-verify is the release-facing command: it acquires the repository
coordination lock before capturing HEAD, and keeps verification and evidence
publication under that lock.
USAGE
}

if [[ "${1:-}" == "--locked-verify" ]]; then
  shift
  for argument in "$@"; do
    if [[ "$argument" == "--expected-revision" ]]; then
      usage >&2
      exit "$USAGE_STATUS"
    fi
  done
  exec node "$SCRIPT_DIR/serial-lock.mjs" \
    --resource "$LOCKED_VERIFY_RESOURCE" \
    --priority 1 \
    -- \
    bash "$SCRIPT_PATH" --locked-verify-inner "$@"
fi

locked_verify_inner=0
if [[ "${1:-}" == "--locked-verify-inner" ]]; then
  locked_verify_inner=1
  shift
elif [[ "${1:-}" != "--verify" ]]; then
  if [[ $# -eq 0 || "${1:-}" == "--sync" ]]; then
    policy_refusal
  fi
  if [[ "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit "$USAGE_STATUS"
else
  shift
fi

if (( locked_verify_inner )) && [[ ",${SERIAL_LOCK_HELD_RESOURCES:-}," != *",$LOCKED_VERIFY_RESOURCE,"* ]]; then
  verification_failure "internal locked verification entry point requires the $LOCKED_VERIFY_RESOURCE coordination lock"
fi

repo="."
expected_revision=""
approved_ref=""
approved_commit_id=""
release_id=""
release_record=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit "$USAGE_STATUS"
      }
      repo="$2"
      shift 2
      ;;
    --expected-revision)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit "$USAGE_STATUS"
      }
      expected_revision="$2"
      shift 2
      ;;
    --approved-ref)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit "$USAGE_STATUS"
      }
      approved_ref="$2"
      shift 2
      ;;
    --approved-commit)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit "$USAGE_STATUS"
      }
      approved_commit_id="$2"
      shift 2
      ;;
    --release-id)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit "$USAGE_STATUS"
      }
      release_id="$2"
      shift 2
      ;;
    --release-record)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit "$USAGE_STATUS"
      }
      release_record="$2"
      shift 2
      ;;
    *)
      usage >&2
      exit "$USAGE_STATUS"
      ;;
  esac
done

if (( ! locked_verify_inner )) && [[ -z "$expected_revision" ]]; then
  usage >&2
  exit "$USAGE_STATUS"
fi
[[ -n "$approved_ref" ]] || {
  usage >&2
  exit "$USAGE_STATUS"
}
[[ -n "$approved_commit_id" ]] || {
  usage >&2
  exit "$USAGE_STATUS"
}
[[ -n "$release_id" ]] || {
  usage >&2
  exit "$USAGE_STATUS"
}
[[ -n "$release_record" ]] || {
  usage >&2
  exit "$USAGE_STATUS"
}

if (( ! locked_verify_inner )) && [[ ! "$expected_revision" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
  verification_failure "expected revision must be a full Git commit object ID"
fi
if [[ ! "$approved_commit_id" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
  verification_failure "approved commit must be a full Git commit object ID"
fi
if [[ ! "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  verification_failure "release ID must contain only letters, numbers, dot, underscore, or hyphen"
fi

case "$approved_ref" in
  refs/heads/review/*|refs/heads/snapshot/*|\
  refs/remotes/*/review/*|refs/remotes/*/snapshot/*|\
  refs/pull/[0-9]*/head)
    ;;
  *)
    verification_failure "approved ref must use the review or snapshot flow: $approved_ref"
    ;;
esac

if (( locked_verify_inner )); then
  if ! expected_revision="$(git -C "$repo" rev-parse --verify HEAD^{commit} 2>/dev/null)"; then
    verification_failure "selected repository has no readable current workspace revision under the coordination lock"
  fi
  record_directory="$(dirname -- "$release_record")"
  if ! mkdir -p -- "$record_directory"; then
    verification_failure "could not create the release record directory under the coordination lock: $record_directory"
  fi
fi

if ! expected_revision_resolved="$(git -C "$repo" rev-parse --verify "${expected_revision}^{commit}" 2>/dev/null)"; then
  verification_failure "expected revision does not resolve to a commit in the repository"
fi
if ! expected_tree="$(git -C "$repo" rev-parse --verify "${expected_revision_resolved}^{tree}" 2>/dev/null)"; then
  verification_failure "expected revision has no readable tree"
fi

if ! initial_revision="$(git -C "$repo" rev-parse --verify "HEAD^{commit}" 2>/dev/null)"; then
  verification_failure "selected repository has no readable current workspace revision"
fi
if [[ "${expected_revision_resolved,,}" != "${initial_revision,,}" ]]; then
  verification_failure "expected revision is stale for the selected repository workspace; re-read HEAD before verifying"
fi

if ! approved_commit="$(git -C "$repo" rev-parse --verify "${approved_ref}^{commit}" 2>/dev/null)"; then
  verification_failure "approved ref does not resolve to a commit: $approved_ref"
fi
if ! approved_commit_id_resolved="$(git -C "$repo" rev-parse --verify "${approved_commit_id}^{commit}" 2>/dev/null)"; then
  verification_failure "approved commit does not resolve to a commit in the repository"
fi
if [[ "${approved_commit,,}" != "${approved_commit_id_resolved,,}" ]]; then
  verification_failure "approved ref commit $approved_commit does not match supplied approved commit $approved_commit_id"
fi
if ! approved_tree="$(git -C "$repo" rev-parse --verify "${approved_commit}^{tree}" 2>/dev/null)"; then
  verification_failure "approved ref has no readable tree: $approved_ref"
fi

if [[ "$expected_tree" != "$approved_tree" && "${expected_tree,,}" != "$approved_tree" ]]; then
  verification_failure "expected tree $expected_tree does not match $approved_ref tree $approved_tree"
fi

if ! final_revision="$(git -C "$repo" rev-parse --verify "HEAD^{commit}" 2>/dev/null)"; then
  verification_failure "selected repository lost its current workspace revision during verification"
fi
if [[ "${expected_revision_resolved,,}" != "${final_revision,,}" ]]; then
  verification_failure "selected repository revision changed during verification; repeat with a coordinated immutable revision"
fi

if ! final_approved_commit="$(git -C "$repo" rev-parse --verify "${approved_ref}^{commit}" 2>/dev/null)"; then
  verification_failure "approved ref became unreadable during verification: $approved_ref"
fi
if [[ "${approved_commit,,}" != "${final_approved_commit,,}" ]]; then
  verification_failure "approved ref changed during verification; repeat with a coordinated immutable ref"
fi

record_directory="$(dirname -- "$release_record")"
if [[ ! -d "$record_directory" ]]; then
  verification_failure "release record directory does not exist: $record_directory"
fi
if ! record_temporary="$(mktemp "$record_directory/.release-record.XXXXXX")"; then
  verification_failure "could not create a temporary release record"
fi
if ! printf '{\n  "release_id": "%s",\n  "approved_ref": "%s",\n  "approved_commit_id": "%s",\n  "workspace_revision": "%s",\n  "verification_status": "VERIFIED_SYNCHRONIZATION"\n}\n' \
  "$release_id" "$approved_ref" "$approved_commit" "$expected_revision_resolved" >"$record_temporary"; then
  rm -f -- "$record_temporary"
  verification_failure "could not write the temporary release record"
fi
if ! ln -- "$record_temporary" "$release_record" 2>/dev/null; then
  rm -f -- "$record_temporary"
  verification_failure "release record already exists and cannot be overwritten: $release_record"
fi
rm -f -- "$record_temporary"
if ! chmod 0444 -- "$release_record"; then
  verification_failure "could not make the release record immutable: $release_record"
fi

printf '[github-sync] VERIFIED_SYNCHRONIZATION: revision %s matches %s at approved commit %s with tree %s (read-only; no push performed).\n' \
  "$expected_revision_resolved" "$approved_ref" "$approved_commit" "$approved_tree"