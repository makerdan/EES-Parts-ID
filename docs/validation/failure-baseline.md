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
pnpm run maintain:validation-baseline -- --max-evidence-days 60 --json
```

`--warning-days`, `BASELINE_WARNING_DAYS`, and
`--max-evidence-days`, `BASELINE_MAX_EVIDENCE_DAYS` must be finite,
non-negative integers. Each CLI threshold takes precedence over its
environment counterpart: `--warning-days` overrides
`BASELINE_WARNING_DAYS`, and `--max-evidence-days` overrides
`BASELINE_MAX_EVIDENCE_DAYS`. When omitted, the defaults are 30 and 90 days
respectively. A missing CLI value, blank or non-numeric environment value,
negative value, or fractional value prints an actionable diagnostic and exits
with status 2 before the catalog is read. With `--json`, configuration and
catalog errors are emitted as one structured JSON object on stderr.

Only `--file <path>`, `--warning-days <days>`, `--max-evidence-days <days>`,
and `--json` are supported. Unknown options and duplicate options fail before
the catalog is read. JSON reports include the effective values in
`thresholds.warningDays` and `thresholds.maxEvidenceDays`.

With `--json`, a successful report has this stable shape:

```json
{
  "catalog": "failure-baseline.json",
  "generated": "YYYY-MM-DD",
  "thresholds": {
    "warningDays": 30,
    "maxEvidenceDays": 90
  },
  "findings": []
}
```

`catalog` and `generated` are strings, `thresholds.warningDays` and
`thresholds.maxEvidenceDays` are non-negative integers, and `findings` is an
array of finding objects. Each finding has one of the kinds `expired`,
`review-due`, or `stale-evidence`, the full catalog `record`, and a non-empty
`message`:

```json
{
  "kind": "expired",
  "record": {
    "id": "BASE-EXAMPLE",
    "suite": "example-suite",
    "test": "exact test",
    "signature": "expected signature",
    "status": "active",
    "authority": "authoritative",
    "evidenceDate": "2026-08-01",
    "owner": "validation-maintainers",
    "reviewDeadline": "2026-08-31"
  },
  "message": "review deadline 2026-08-31 has expired"
}
```

The record uses the fields described in the record contract above and may also
include the optional `verificationDate`. Configuration failures are written to
stderr as one stable JSON object:

```json
{
  "error": "invalid_configuration",
  "code": "INVALID_CONFIGURATION",
  "message": "actionable summary",
  "errors": ["actionable diagnostic"]
}
```

Catalog failures use the same fields with `error` set to `invalid_catalog` and
`code` set to `INVALID_CATALOG`.

The report identifies expired records, approaching review deadlines, and stale
evidence. It is informational and does not run as part of a normal validation
tier. It never changes the catalog.