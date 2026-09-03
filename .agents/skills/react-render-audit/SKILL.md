---
name: React Render & Memory Audit
description: Systematically inspect React and React Native component trees for render-health defects, lifecycle leaks, stale closures, unstable references, and unbounded memory growth.
---

# React Render & Memory Audit

This skill audits React code from inside the component tree. It uses static inspection to find problems that can cause memory leaks, infinite render loops, stale behavior, unnecessary work, and remount churn before they become user-visible failures.

## Invocation Trigger

Use this skill when:

- A component is suspected of leaking memory across mounts or navigation transitions.
- Renders are visibly sluggish, battery usage is unexpectedly high, or the cause of repeated work is unknown.
- A screen shows stale state, request storms, duplicate subscriptions, or behavior that changes after a remount.
- A performance-sensitive React Native list, animation, or context provider needs a pre-release health audit.

This is distinct from:

- **UX E2E:** UX E2E follows user journeys from the outside and verifies journey correctness. This skill inspects component lifecycles, hooks, references, closures, and render work from the inside.
- **Bug Audit:** Bug Audit is broad static analysis across application defects. This skill is deliberately narrower: it focuses on React render correctness, async lifecycle safety, and memory behavior.

## Invocation Modes

1. **Report-only (default):** inspect the codebase, produce the complete sorted findings report, and stop before changing application code.
2. **Audit-and-fix:** only use when the user explicitly asks to fix the findings. Apply the ordered fix loop and regression hardening in Phase 8.

Do not infer permission to modify application code from a request to audit or report. A report-only audit may recommend concrete changes, but it does not apply them.

## Severity Rubric

Assign the highest severity supported by the evidence:

| Severity | Concrete criteria |
| --- | --- |
| **Critical** | A defect can retain resources or remount a subtree repeatedly without a bounded stop condition, or can affect many consumers at once. Examples include an uncleaned WebSocket, observer, or event-emitter subscription; an inline virtualized-list renderer that remounts all children on every parent render; or a hook-order violation that can break rendering. |
| **High** | A defect can reliably cause user-visible incorrectness, repeated requests, state updates after unmount, or substantial resource growth during normal use. Examples include an uncleaned timer, unguarded async state update, stale callback used for a save/action, or an unstable context value invalidating all consumers. |
| **Medium** | A defect causes avoidable repeated computation, moderate memory growth, missed cancellation on dependency changes, or degraded behavior only under particular interaction, data-size, or navigation conditions. |
| **Low** | A localized inefficiency, defensive-hardening opportunity, or maintainability risk with no demonstrated correctness failure or unbounded growth. |

When multiple criteria apply, report one finding at the highest applicable severity and explain the concrete trigger in `Failure`.

## Phase 0 — Discovery & Stack Detection (ALWAYS)

This phase is **ALWAYS** required before any other phase. Do not skip it, even when the repository appears small.

Detect and record:

1. Whether React is present and whether React Native is present.
   - React Native presence gates the React Native checks in Phase 3 and Phase 5.
   - React Native presence also gates the `Animated.start()` lifecycle check in Phase 2.
2. The installed React version.
   - React 18 or newer gates checks for concurrent rendering APIs and `useTransition`.
   - For React versions below 18, record those checks as not applicable rather than reporting them.
3. Whether an animation library is present, including an animation API with worklets or an `Animated` API.
   - An animation library gates the worklet and animated-lifecycle checks.
   - A worklet-capable library gates the `useAnimatedStyle` and worklet checks in Phase 6.
4. Whether a global error boundary exists.
   - Record whether a top-level `ErrorBoundary`, `componentDidCatch`, or `getDerivedStateFromError` is present.
5. Whether the project has a test suite.
   - A test suite gates the automated-test regression guard in Phase 8.

Use repository manifests, lockfiles, imports, and source inspection to make the determination. Record evidence, not assumptions. Before Phase 1, output this inventory:

| Flag | Detected value | Evidence | Gates |
| --- | --- | --- | --- |
| React present | yes/no | package/import evidence | React phases |
| React Native present | yes/no | package/import evidence | RN checks in Phases 2, 3, 5 |
| React version | version or unknown | manifest/lockfile evidence | React 18+ checks |
| Animation library present | yes/no; name if generic | import/manifest evidence | animated checks |
| Worklet-capable animation present | yes/no | import/manifest evidence | Phase 6 worklet check |
| Global error boundary | yes/no | boundary evidence | resilience context |
| Test suite | yes/no | test scripts/files evidence | Phase 8 automated-test guard |

If a value is unknown, state that it is unknown and gate only the checks that require it. Do not silently treat an unknown stack flag as absent.

## Phase 1 — Effect Cleanup Audit (ALWAYS)

This phase is **ALWAYS** required. Cover every `useEffect` and `useLayoutEffect` in the codebase, including effects in custom hooks and components that return `null`.

For each effect, inspect the full callback and its return function. Verify:

1. Every browser listener, timer, observer, socket, or event-emitter subscription created in the effect has a matching cleanup in the effect's return function.
2. A polling loop created with recursive `setTimeout` or a self-calling `setInterval` stops on unmount.
3. An `AbortController` constructed inside the effect has `.abort()` called from cleanup.
4. Cleanup is idempotent and does not assume the resource was fully initialized.
5. Dependencies cause the old resource to be cleaned up before a new resource is created.

Use concrete searches, then inspect surrounding code rather than treating a match as proof:

```sh
grep -RInE 'useEffect[[:space:]]*\(|useLayoutEffect[[:space:]]*\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'addEventListener[[:space:]]*\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'setInterval[[:space:]]*\(|setTimeout[[:space:]]*\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'ResizeObserver[[:space:]]*\(|IntersectionObserver[[:space:]]*\(|MutationObserver[[:space:]]*\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'new[[:space:]]+WebSocket[[:space:]]*\(|WebSocket[[:space:]]*\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'subscribe[[:space:]]*\(|\\.on[[:space:]]*\\(|addListener[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'new[[:space:]]+AbortController[[:space:]]*\\(|\\.abort[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

Expected cleanup shapes include `removeEventListener(...)`, `clearInterval(...)`, `clearTimeout(...)`, `observer.disconnect()`, `socket.close()`, `unsubscribe()`, `off(...)`, `removeListener(...)`, and `controller.abort()`. Match the cleanup to the exact resource and handler created by that effect.

Severity guidance:

- Missing cleanup for a timer is **High**.
- Missing cleanup for a WebSocket, observer, or event emitter is **Critical**.
- A cleanup that runs only on a success path, or a dependency change that leaves the previous resource active, is at least **High**.

## Phase 2 — Async Lifecycle Audit (ALWAYS)

This phase is **ALWAYS** required. Identify async work that can resolve after a component unmounts or after its dependencies have changed.

Check:

1. A `fetch` or other async data-fetching call inside an effect has either an `AbortController` or an `isMounted`/`cancelled` guard. An unguarded operation is **High**.
2. `setState`, `dispatch`, or a store setter in a `.then()` or `await` path is protected from running after unmount. An unguarded update is **High**.
3. A recursive polling timeout is cancelled when dependencies change. A missing dependency-change cancellation is **Medium**, or **High** when it can multiply requests.
4. Rejected async work is handled without turning an expected cancellation into an unhandled error.

Use these quoted patterns as starting points:

```sh
grep -RInE 'fetch[[:space:]]*\\(|\\.then[[:space:]]*\\(|await[[:space:]]+' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'setState[[:space:]]*\\(|set[A-Z][A-Za-z0-9]*[[:space:]]*\\(|dispatch[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'isMounted|cancelled|canceled|AbortController|signal[[:space:]]*:' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'setTimeout[[:space:]]*\\([^;]*=>|setInterval[[:space:]]*\\([^;]*=>' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

### React Native animation gate

This check is **GATED — run only when React Native is present and an `Animated` API is detected**. For every `Animated.start()` call, verify that unmount cleanup calls the matching `Animated.stop()` or removes its listeners with `removeAllListeners()`, as appropriate for the API. Use:

```sh
grep -RInE 'Animated\\.[A-Za-z]+\\.start[[:space:]]*\\(|\\.start[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'Animated\\.[A-Za-z]+\\.stop[[:space:]]*\\(|removeAllListeners[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

## Phase 3 — Reference Stability Audit (ALWAYS; RN and Context checks gated)

This phase is **ALWAYS** required for React code. The React Native list check is **GATED — run only when React Native is present**. The Context provider check is **GATED — run only when a Context provider is present**.

### Dependency-array references (ALWAYS)

Inspect hook dependency arrays for object literals, array literals, and arrow functions. These are new references on every render and can retrigger effects or invalidate memoization:

```sh
grep -RInE 'use(Effect|LayoutEffect|Callback|Memo)[[:space:]]*\\([^\\n]*\\[[^\\]]*\\{[^\\]]*\\}' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'use(Effect|LayoutEffect|Callback|Memo)[[:space:]]*\\([^\\n]*\\[[^\\]]*\\[[^\\]]*\\]' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'use(Effect|LayoutEffect|Callback|Memo)[[:space:]]*\\([^\\n]*\\[[^\\]]*=>[^\\]]*\\]' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

Also inspect empty dependency arrays. A `useCallback` or `useMemo` with `[]` that reads props or state creates a stable reference over a stale value:

```sh
grep -RInE 'useCallback[[:space:]]*\\([^;]*,?[[:space:]]*\\[\\][[:space:]]*\\)' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'useMemo[[:space:]]*\\([^;]*,?[[:space:]]*\\[\\][[:space:]]*\\)' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

For each match, inspect the callback body for identifiers received as props, state variables, or derived values. A stable value is valid only when the body intentionally reads immutable values or uses an explicit ref-indirection pattern.

### React Native virtualized-list gate

This check is **GATED — run only when React Native is present**. Inline arrow functions supplied to virtualized-list renderer props can remount child trees on parent renders. Treat a confirmed inline `ListHeaderComponent` or equivalent child-renderer remount as **Critical**.

Search each supported component and prop explicitly:

```sh
grep -RInE '<(FlatList|SectionList|VirtualizedList|FlashList)[^>]*(renderItem|ListHeaderComponent|ListFooterComponent|ItemSeparatorComponent)[[:space:]]*={[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE '(renderItem|ListHeaderComponent|ListFooterComponent|ItemSeparatorComponent)[[:space:]]*={[[:space:]]*\\([^}]*=>|[[:space:]]*={[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=>' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

Prefer a stable component reference or a memoized renderer. Confirm the actual prop behavior before assigning severity.

### Context provider gate

This check is **GATED — run only when a Context provider is present**. A `value={{ ... }}` or `value={[...]}` expression directly on a provider recreates the value every render and invalidates all consumers:

```sh
grep -RInE '<[A-Za-z_$][A-Za-z0-9_$]*\\.Provider[^>]*value[[:space:]]*={[[:space:]]*\\{' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE '<[A-Za-z_$][A-Za-z0-9_$]*\\.Provider[^>]*value[[:space:]]*={[[:space:]]*\\[' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

The confirmed unstable provider value is **High** unless the provider has no consumers or the value is otherwise proven irrelevant.

## Phase 4 — Stale Closure Audit (ALWAYS)

This phase is **ALWAYS** required.

1. For every `useCallback` and ref-forwarded event handler, verify that all captured state and prop values are in the dependency array, or that a ref-indirection pattern reads the latest value.
2. Treat a handler with `[]` dependencies that reads mutable state as a stale-closure finding unless the state is deliberately immutable.
3. Inspect `useEffect` dependency arrays for return values from hooks known to produce a new reference on token refresh or session change, including auth hooks and SDK client hooks. An unstable function/client dependency can cause an effect to loop or repeatedly recreate resources.
4. Inspect every `setInterval` callback. It captures values at registration time; state reads require a ref-indirection pattern or an intentional functional update.
5. For React 18+ projects, inspect concurrent rendering and `useTransition` paths for assumptions that a render or callback runs exactly once. This check is **GATED — run only when React version is 18 or newer**.

Use concrete searches:

```sh
grep -RInE 'useCallback[[:space:]]*\\(|forwardRef[[:space:]]*\\(|useImperativeHandle[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'use(Effect|LayoutEffect)[[:space:]]*\\([^\\n]*\\[[^\\]]*(getToken|useAuth|useSession|useClient|client|session)[^\\]]*\\]' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'setInterval[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'useTransition[[:space:]]*\\(|startTransition[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

The auth and client names in the pattern are generic examples, not a requirement to use a particular authentication or API library. Replace the pattern with equivalent hook names found during Phase 0.

## Phase 5 — Memory Accumulation Audit (ALWAYS; singleton check gated)

This phase is **ALWAYS** required. The service-layer singleton check is **GATED — run only when a service layer or singleton pattern is detected**. The React Native `require()` check is **GATED — run only when React Native is present**.

Check:

1. Module-level `let` or `const` values holding mutable collections (`Map`, `Set`, arrays, or plain objects) that are written from component code or effects. These can grow across remounts without bound.
2. If a service layer or singleton pattern exists, verify that every client instantiated at module level either has process-exit cleanup or is a genuine singleton with a stable, bounded lifecycle.
3. In-memory image, asset, or data caches have an eviction policy, maximum size, or bounded key space. A cache that grows with user actions and has no limit is **Medium**.
4. A cache entry does not retain component instances, DOM nodes, native views, or closures longer than the resource's lifecycle.

Use these quoted patterns:

```sh
grep -RInE '^[[:space:]]*(export[[:space:]]+)?(let|const)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=[[:space:]]*(new[[:space:]]+(Map|Set)|\\[|\\{)' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE '\\.(set|add|push)[[:space:]]*\\(|Object\\.assign[[:space:]]*\\(|[A-Za-z_$][A-Za-z0-9_$]*\\[[^]]+\\][[:space:]]*=' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE '(cache|Cache|memo|Memo|assets?|images?|data)[A-Za-z_$0-9]*[[:space:]]*=[[:space:]]*(new[[:space:]]+(Map|Set)|\\[|\\{)' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'process\\.on[[:space:]]*\\([[:space:]]*['\"'](exit|SIGTERM|SIGINT)['\"']|beforeunload[[:space:]]*|module\\.hot' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

### React Native module-evaluation gate

This check is **GATED — run only when React Native is present**. Inspect `require()` calls in render functions and effect bodies:

```sh
grep -RInE 'require[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

A confirmed `require()` in a render or effect path that repeatedly evaluates or allocates a resource is a finding. Do not report static top-level asset imports as this issue.

## Phase 6 — Render Correctness Audit (ALWAYS; animation worklet check gated)

This phase is **ALWAYS** required. The animation worklet check is **GATED — run only when a worklet-capable animation library is detected**.

Check:

1. Expensive pure computations such as sorting, filtering, reducing large arrays, parsing JSON, complex regular expressions, or deep cloning in component bodies without `useMemo`. Confirm the input can be large or the computation runs on a frequently changing render path before reporting.
2. A child wrapped in `React.memo` or `PureComponent` receiving a new object or function reference on every parent render. This silently defeats memoization.
3. Conditional hook calls. Hooks inside `if`, `for`, or ternary expressions violate the Rules of Hooks and can break rendering when the branch changes.
4. A render path that performs side effects, starts async work, mutates external collections, or creates subscriptions instead of doing that work in an effect or event handler.

Search for concrete patterns:

```sh
grep -RInE '\\.(sort|filter|reduce)[[:space:]]*\\(|JSON\\.parse[[:space:]]*\\(|structuredClone[[:space:]]*\\(|cloneDeep[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'new[[:space:]]+RegExp[[:space:]]*\\(|/[A-Za-z0-9\\[\\]\\\\{}()|+*?.]{20,}/[gimsuy]*' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE '<[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]+(memo|PureComponent)|React\\.memo[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE 'if[[:space:]]*\\([^)]*\\)[[:space:]]*\\{[^}]*use[A-Z][A-Za-z0-9]*[[:space:]]*\\(|for[[:space:]]*\\([^)]*\\)[[:space:]]*\\{[^}]*use[A-Z][A-Za-z0-9]*[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE '\\?[[:space:]]*\\([^:)]*\\)[[:space:]]*:[^;]*use[A-Z][A-Za-z0-9]*[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

### Animation worklet gate

This check is **GATED — run only when a worklet-capable animation library is present**. Inspect worklet functions and `useAnimatedStyle` callbacks defined inside component bodies. A callback recreated or re-serialized on every render can cause avoidable animation work and degraded frame rate:

```sh
grep -RInE 'useAnimatedStyle[[:space:]]*\\(|useDerivedValue[[:space:]]*\\(|[[:space:]]*function[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*\\([^)]*\\)[[:space:]]*\\{[^}]*' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
grep -RInE '["'"'"']worklet["'"'"']|useAnimatedGestureHandler[[:space:]]*\\(' --include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' .
```

Confirm whether the library intentionally requires a worklet callback to be recreated before assigning severity. Report a confirmed re-serialization risk as **Medium** or **High** depending on observed frame/render impact.

## Phase 7 — Triage & Report (ALWAYS)

This phase is **ALWAYS** required after Phases 0–6, even when no findings are found.

Sort all findings in this order:

1. Critical
2. High
3. Medium
4. Low

Begin with a summary table:

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

Then write every finding using this required format:

```text
ID: R-001
Component: path/to/file.tsx — ComponentName
Phase: Phase N — Phase name
Severity: Critical | High | Medium | Low
Failure: From the developer's perspective, what breaks and when.
Fix: A concrete change naming the file, hook, and what to add, remove, or stabilize.
Evidence: The quoted code pattern or inspected code path supporting the finding.
```

The six required fields are `ID`, `Component`, `Phase`, `Severity`, `Failure`, and `Fix`. `Evidence` is required for auditability. Number findings consecutively as `R-001`, `R-002`, and so on after sorting.

If no findings exist, output the zero-count table and explicitly say that no findings were confirmed. Do not manufacture findings from grep matches that code inspection disproves.

**STOP HERE in report-only mode — ask the user which findings to fix before proceeding.**

## Phase 8 — Fix & Regression Hardening (audit-and-fix mode only, GATED)

This phase is **GATED — run only in audit-and-fix mode after the user explicitly requests fixes**. It must not run in report-only mode.

Fix findings in this order: Critical, High, Medium, then Low. After each fix:

1. Re-inspect the affected component and its neighboring hook/resource lifecycle.
2. Re-run the relevant quoted search from the finding.
3. Check that the fix did not introduce a new unstable dependency, stale closure, uncleaned resource, or render-time side effect.
4. Update the finding status and preserve the original evidence in the report.

After all fixes, apply regression hardening for every failure class with two or more findings, in this priority order:

1. **Lint rule:** enforce the pattern mechanically, such as a rule against missing effect cleanup, conditional hooks, or unstable dependency references.
2. **Shared utility:** use a shared cleanup hook or utility for repeated cancellation, subscription, polling, or bounded-cache behavior.
3. **Automated test:** add a test that mounts, updates, unmounts, and remounts the affected component or exercises the async/animation lifecycle.
   - This guard is **GATED — add it only when Phase 0 confirms a test suite exists**.
4. **Stricter compiler check:** enable a TypeScript, hook, or schema constraint that makes the unsafe shape fail earlier.
5. **`replit.md` convention note:** document the surviving project-specific convention only when the preceding mechanical guards cannot express it.

Use the smallest guard that reliably prevents recurrence; do not add all five automatically. Record which guard was selected and why.

### Fix-loop escape hatch

If three consecutive fixes each introduce a new finding, stop immediately. Surface the current findings list, identify the three fixes that caused new findings, and ask the user for guidance. Do not continue making speculative changes.

## Verification Checklist

Before invoking this skill in a future audit, confirm every statement below is true:

- [ ] The frontmatter contains `name: React Render & Memory Audit`.
- [ ] The frontmatter description is at least one complete sentence.
- [ ] Invocation Trigger names at least two concrete situations.
- [ ] Invocation Trigger explicitly distinguishes this skill from UX E2E and Bug Audit.
- [ ] Invocation Modes define report-only as the default and audit-and-fix as explicit.
- [ ] The severity rubric defines concrete Critical, High, Medium, and Low criteria.
- [ ] Phase 0 is marked ALWAYS and records every required stack flag.
- [ ] Phase 0 states the gates for React Native, React 18+, animation/worklets, and test-suite checks.
- [ ] Phases 1, 2, 4, and 7 are marked ALWAYS.
- [ ] Phase 3 is marked ALWAYS and states its React Native and Context gates.
- [ ] Phase 5 is marked ALWAYS and states its singleton and React Native gates.
- [ ] Phase 6 is marked ALWAYS and states its animation worklet gate.
- [ ] Phase 8 is explicitly gated to audit-and-fix mode.
- [ ] Every grep heuristic includes a concrete quoted code pattern.
- [ ] The finding block contains ID, Component, Phase, Severity, Failure, and Fix.
- [ ] The report sorts findings Critical → High → Medium → Low and includes a count table.
- [ ] The exact report-only stop point appears before the fix loop.
- [ ] The fix-loop escape hatch stops after three consecutive fixes introduce new findings.
- [ ] Regression hardening lists at least a lint rule, shared utility, automated test, and stricter compiler check.
- [ ] No example depends on a project-specific API client or a library unique to one codebase.