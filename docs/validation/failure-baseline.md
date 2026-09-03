# Failure baseline catalog

`failure-baseline.json` is the durable provenance catalog for failures that a
task may explicitly ignore. An empty catalog is intentional: failures must not
be waived merely because a suite name is familiar.

## Record contract

Each record has a unique `id`, exact `suite`, exact `test`, and exact
`signature`, plus:

- `status`: `active`, `needs-review`, `intermittent`, `environment-limited`, or
  `resolved`
- `authority`: must be `authoritative` before a record can authorize an ignore
- `evidenceDate`: the date the exact failure was observed
- `owner`: the person or team responsible for review
- `reviewDeadline`: the last date the record may authorize an ignore
- optional `verificationDate`: the latest confirming run

Only `active` records with authoritative provenance, a non-expired review
deadline, and evidence dated today or earlier are referenceable. Every other
state is context for maintenance, not permission to skip a failure.

## Plan declarations

Plans must declare exactly one ownership mode for each referenced record:

```markdown
- **Ignored baseline:** `BASE-EXAMPLE` — suite › test; match only this signature: exact failure signature.
- **Owned baseline repair:** `BASE-EXAMPLE-REPAIR` — suite › test; match only this signature: exact failure signature.
```

`Ignored baseline` means the task is unrelated and leaves the failure alone.
`Owned baseline repair` means the task owns fixing the failure; the baseline
label never blocks that repair. Suite, test, and signature must match exactly.
Unknown IDs, expired records, non-active statuses, duplicate declarations,
missing ownership, and mismatches fail closed.

Free-text `--pre-existing` and `--environment-observation` values in the plan
scaffold are task-local evidence. They do not create durable provenance or
authorize an ignore.

## Lifecycle

1. Capture the exact suite, test, and failure signature from a repeatable run.
2. Confirm provenance with the Failure Gate retry and evidence rules.
3. Add a dated record with an owner and a review deadline. Use
   `needs-review` unless the evidence is authoritative.
4. A reviewer verifies the record and changes it to `active` only when it is
   safe to reference.
5. Renew the evidence and deadline during review, or move the record to
   `resolved`, `intermittent`, or `environment-limited`.
6. Expired active records remain in history but cannot authorize a plan.

Do not promote a task-local self-classification automatically. Catalog edits
are a separate tracked maintenance change.

## Maintenance

Run the report explicitly:

```sh
pnpm run maintain:validation-baseline
pnpm run maintain:validation-baseline -- --warning-days 14 --json
```

The report identifies expired records, approaching review deadlines, and stale
evidence. It is informational and does not run as part of a normal validation
tier. It never changes the catalog.