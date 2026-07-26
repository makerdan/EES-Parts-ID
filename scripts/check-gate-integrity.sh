#!/usr/bin/env bash
# check-gate-integrity.sh
#
# Guards against Project CI gate drift. The Project workflow must contain
# exactly one workflow.run task: "test-fast". If any other workflow.run args
# are found inside the [workflows.workflow] block named "Project", this script
# fails with a clear remediation message.
#
# Remediation: edit .replit so the Project workflow's [[workflows.workflow.tasks]]
# entries contain only:
#
#   [[workflows.workflow.tasks]]
#   task = "workflow.run"
#   args = "test-fast"
#
# All other tiers and individual checks remain registered as standalone
# validation commands for targeted manual runs — they just don't belong
# in the Project gate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPLIT_FILE="$SCRIPT_DIR/../.replit"

if [[ ! -f "$REPLIT_FILE" ]]; then
  echo "ERROR: .replit not found at $REPLIT_FILE"
  exit 1
fi

# Extract the section of .replit that belongs to the Project workflow.
# Strategy: find the line index of 'name = "Project"', then collect all lines
# until the next [[workflows.workflow]] block (or end of file).
in_project=0
offending=()

while IFS= read -r line; do
  # Detect start of any [[workflows.workflow]] block
  if [[ "$line" == "[[workflows.workflow]]" ]]; then
    in_project=0
  fi

  # Detect the Project block
  if [[ "$line" == 'name = "Project"' ]]; then
    in_project=1
  fi

  # Inside the Project block, look for workflow.run task args
  if [[ "$in_project" == "1" && "$line" =~ ^args\ =\ \"(.+)\"$ ]]; then
    arg="${BASH_REMATCH[1]}"
    if [[ "$arg" != "test-fast" ]]; then
      offending+=("$arg")
    fi
  fi
done < "$REPLIT_FILE"

if [[ "${#offending[@]}" -gt 0 ]]; then
  echo ""
  echo "ERROR: Project CI gate contains unexpected workflow.run entries:"
  echo "--------------------------------------------------------------"
  for entry in "${offending[@]}"; do
    echo "  args = \"$entry\""
  done
  echo "--------------------------------------------------------------"
  echo ""
  echo "The Project gate must contain ONLY 'test-fast'."
  echo ""
  echo "Fix: edit .replit so the Project [[workflows.workflow]] block has"
  echo "     exactly one [[workflows.workflow.tasks]] entry:"
  echo ""
  echo "       [[workflows.workflow.tasks]]"
  echo "       task = \"workflow.run\""
  echo "       args = \"test-fast\""
  echo ""
  echo "All other tiers (test-standard, test-standard-plus, test-heavy) and"
  echo "individual checks remain as standalone validation commands."
  echo ""
  exit 1
fi

echo "✓ Project CI gate is clean: only test-fast is wired in."
