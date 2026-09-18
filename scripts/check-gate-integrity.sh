#!/usr/bin/env bash
# check-gate-integrity.sh
#
# Guards against Project CI gate drift. The Project workflow must contain
# exactly one workflow.run task: "test-fast". The TOML structure is parsed
# before the workflow is inspected so missing, renamed, duplicate, or
# malformed tasks fail closed.
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
REPLIT_FILE="${REPLIT_FILE:-$SCRIPT_DIR/../.replit}"

if [[ ! -f "$REPLIT_FILE" ]]; then
  echo "ERROR: .replit not found at $REPLIT_FILE"
  exit 1
fi

python3 - "$REPLIT_FILE" <<'PY'
import sys
import tomllib

path = sys.argv[1]
remediation = """Fix: edit .replit so the Project [[workflows.workflow]] block has
exactly one [[workflows.workflow.tasks]] entry:

  [[workflows.workflow.tasks]]
  task = "workflow.run"
  args = "test-fast"

All other tiers (test-standard, test-standard-plus, test-heavy) and individual
checks remain standalone validation commands."""


def fail(message):
    print(f"ERROR: {message}")
    print(remediation)
    raise SystemExit(1)


try:
    with open(path, "rb") as file:
        config = tomllib.load(file)
except (OSError, tomllib.TOMLDecodeError) as error:
    fail(f"could not parse {path}: {error}")

workflows = config.get("workflows")
if not isinstance(workflows, dict):
    fail('missing [workflows] table')

workflow_entries = workflows.get("workflow")
if not isinstance(workflow_entries, list):
    fail("missing [[workflows.workflow]] entries")

projects = [
    workflow
    for workflow in workflow_entries
    if isinstance(workflow, dict) and workflow.get("name") == "Project"
]
if not projects:
    fail('missing workflow named "Project"')
if len(projects) != 1:
    fail(f'found {len(projects)} workflows named "Project"; expected exactly one')

project = projects[0]
tasks = project.get("tasks")
if not isinstance(tasks, list):
    fail('Project workflow is missing [[workflows.workflow.tasks]] entries')
if len(tasks) != 1:
    fail(
        "Project workflow must contain exactly one task; "
        f"found {len(tasks)}"
    )

task = tasks[0]
if not isinstance(task, dict):
    fail("Project workflow task is malformed; expected a task table")

task_type = task.get("task")
args = task.get("args")
if task_type != "workflow.run":
    fail(
        'Project workflow task must use task = "workflow.run"; '
        f"found {task_type!r}"
    )
if args != "test-fast":
    fail(
        'Project workflow task must use args = "test-fast"; '
        f"found {args!r}"
    )

print("✓ Project CI gate is clean: only test-fast is wired in.")
PY
