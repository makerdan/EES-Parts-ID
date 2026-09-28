# Post-merge setup when the API is paused

## Problem

Post-merge setup runs before workflow reconciliation. When validation has deliberately
paused the API workflow, setup completes code generation but then probes an API that
is not running, attempts port cleanup, and fails. Reconciliation can start the
workflow afterward, but it cannot turn that failed setup result into success.

## Decision

Keep the current strict live health and SVG viewBox checks when the API was running
at setup entry. Defer those checks when the API was already paused. This preserves
the validation pause instead of starting a server from post-merge setup.

At entry, use the registered local API port and the API development process to
classify the state. An explicit `PORT` means the caller expects a live server and
always takes the strict path. Without `PORT`, a listener on the registered API port
or the API development process also takes the strict path, even if its health
endpoint is failing. Only the absence of both at entry takes the paused path.
This classification is fixed for the run so a codegen reload cannot turn a live
failure into a skipped check.

On the paused path, still perform dependency, schema, generated-file, package,
and protected-sync work as before. Log that live API and viewBox checks are
deferred to workflow reconciliation. Do not poll the proxy, sweep the API port,
restart a process, or claim that live health was verified. On the strict path,
retain the existing bounded health retries, cleanup/recovery, and failure behavior.

## Alternatives considered

- Starting the API inside setup would break the intentional validation pause
  and duplicate workflow supervisor ownership.
- Switching the fallback URL from the proxy to localhost would make a running
  API easier to reach but cannot make a paused API healthy.

## Regression proof

Add a fixture that runs setup with neither `PORT`, an API process, nor an API
listener: it must complete setup without calling live health, viewBox, or port
cleanup, and must disclose the deferred checks. Retain or extend a fixture where
an API is considered running but returns unhealthy responses: setup must still
fail rather than silently taking the paused path. Verify the normal post-merge
script behavior with the existing post-merge test suite and a post-merge setup
retry. Do not change validation tier membership or baseline exceptions.