---
name: Stuck task in AWAITING_INPUT with no visible question
description: Why tasks get stuck in AWAITING_INPUT with no question in the thread, and how to jolt them back into action.
---

# Stuck task in AWAITING_INPUT with no visible question

## The problem
A task can land in **AWAITING_INPUT** state with no question visible in its thread. This happens when the agent crashes (or is interrupted) at the exact moment it was transitioning state — after it decided to ask a question but before it could write the message to the thread. The platform records the state transition but the message is lost, leaving the task frozen with no prompt for the user to respond to.

## The fix
On the task's preview screen in the Replit UI, click **"Update from main"**. This jolts the platform into re-evaluating the task's state and re-dispatches the agent, breaking the deadlock.

**Why:** "Update from main" triggers a fresh agent dispatch against the current task state, which causes the agent to re-enter its decision loop and either re-ask the question or continue past the stuck point.

## Cannot be automated
This is a Replit platform UI action. There is no API or CLI equivalent. It must be performed manually by a human in the browser.
