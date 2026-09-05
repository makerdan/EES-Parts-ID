#!/usr/bin/env bash
set -euo pipefail

# Automatic direct pushes are intentionally disabled.
#
# The public GitHub repository is synchronized through the approved protected
# snapshot pull-request process documented in:
#   docs/superpowers/specs/2026-09-03-github-actions-protected-snapshot-sync-design.md
#
# Keeping this helper as an explicit no-op preserves the post-merge call site
# while preventing local Git history, command-line credentials, or an obsolete
# repository target from being published during routine merge recovery.
echo "[github-sync] Automatic direct push disabled; use the protected snapshot PR flow for makerdan/EES-Parts-ID."