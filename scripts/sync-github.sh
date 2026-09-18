#!/usr/bin/env bash
set -euo pipefail

readonly POLICY_REFUSAL_STATUS=2
readonly VERIFICATION_FAILURE_STATUS=3
readonly USAGE_STATUS=64

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
  scripts/sync-github.sh --verify --expected-tree TREE --approved-ref REF [--repo PATH]

Direct synchronization is unsupported. Verification is read-only and accepts
only refs under refs/heads/review/, refs/heads/snapshot/, matching remote
tracking refs, or refs/pull/<number>/head.
USAGE
}

if [[ "${1:-}" != "--verify" ]]; then
  if [[ $# -eq 0 || "${1:-}" == "--sync" ]]; then
    policy_refusal
  fi
  if [[ "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit "$USAGE_STATUS"
fi

shift
repo="."
expected_tree=""
approved_ref=""

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
    --expected-tree)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit "$USAGE_STATUS"
      }
      expected_tree="$2"
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
    *)
      usage >&2
      exit "$USAGE_STATUS"
      ;;
  esac
done

[[ -n "$expected_tree" ]] || {
  usage >&2
  exit "$USAGE_STATUS"
}
[[ -n "$approved_ref" ]] || {
  usage >&2
  exit "$USAGE_STATUS"
}

if [[ ! "$expected_tree" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
  verification_failure "expected tree must be a Git tree object ID"
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

if ! expected_type="$(git -C "$repo" cat-file -t "$expected_tree" 2>/dev/null)"; then
  verification_failure "expected tree does not exist in the repository"
fi
[[ "$expected_type" == "tree" ]] || {
  verification_failure "expected object is not a tree"
}

if ! approved_commit="$(git -C "$repo" rev-parse --verify "${approved_ref}^{commit}" 2>/dev/null)"; then
  verification_failure "approved ref does not resolve to a commit: $approved_ref"
fi
if ! approved_tree="$(git -C "$repo" rev-parse --verify "${approved_commit}^{tree}" 2>/dev/null)"; then
  verification_failure "approved ref has no readable tree: $approved_ref"
fi

if [[ "$expected_tree" != "$approved_tree" && "${expected_tree,,}" != "$approved_tree" ]]; then
  verification_failure "expected tree $expected_tree does not match $approved_ref tree $approved_tree"
fi

printf '[github-sync] VERIFIED_SYNCHRONIZATION: %s matches approved tree %s (read-only; no push performed).\n' \
  "$approved_ref" "$approved_tree"