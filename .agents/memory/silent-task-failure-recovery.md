---
name: Silent task failure recovery
description: Why tasks can reach FAILED/ERROR state with no visible error message, how to distinguish from AWAITING_INPUT, and how to recover.
---

# Silent task failure recovery

## The problem
A task can enter a **FAILED** or **ERROR** terminal state with no error message visible in its thread. This happens when the agent crashes (hardware preempt, OOM, uncaught exception in the platform runtime, etc.) after the platform records the state transition but before the agent writes any message to the thread. The user sees a task marked as failed with a completely empty thread — or a thread that ends on a normal working message with no explanation of what went wrong.

## How it looks vs. AWAITING_INPUT

| Symptom | AWAITING_INPUT (stuck) | FAILED/ERROR (silent) |
|---|---|---|
| Task status badge | AWAITING_INPUT | FAILED or ERROR |
| Thread ends with | Nothing (question was lost) | Last normal work message, or nothing at all |
| Task is still actionable? | Yes — it is waiting | No — it has terminated |
| Agent is running? | No — frozen waiting for input | No — has exited |

The key tell is the **status badge**: AWAITING_INPUT means the platform is still holding the task open; FAILED/ERROR means it has closed.

## The fix
On the task's card or detail screen in the Replit UI, use the **"Re-run"** or **"Retry"** action (the exact label depends on the UI version). This creates a fresh agent dispatch against the same task, clearing the failed state and letting the agent re-attempt from the last checkpoint.

If no Retry button is visible, **"Update from main"** (the same action used for AWAITING_INPUT) can also jolt the task back into an active state — the platform re-evaluates task state on that trigger.

**Why:** The platform records the terminal state but the agent never had a chance to persist its progress or write an error. Re-running starts the agent fresh; it will re-read its task file and working memory and re-attempt the work (or produce a real error message this time).

## Cannot be automated
This is a Replit platform UI action. There is no API or CLI equivalent. It must be performed manually in the browser.

## Distinction from AWAITING_INPUT
- AWAITING_INPUT is a **live but frozen** state — the task is open, the agent is waiting. Fix: "Update from main".
- FAILED/ERROR is a **terminated** state — the task is closed, no agent is running. Fix: Retry / re-run.

Both cases may present with no visible error or question in the thread, but the recovery path differs because the platform state is different.
