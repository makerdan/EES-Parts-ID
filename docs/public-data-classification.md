# Public data classification

This is the contributor-facing boundary for a public source repository. When
classification is uncertain, treat a file as private and keep it out of Git
until the maintainer confirms otherwise.

| Classification | May be tracked? | Examples | Required handling |
| --- | --- | --- | --- |
| Public source | Yes | Application code, API/spec code, migrations, tests, synthetic dictionaries | Review for embedded credentials, personal data, and production identifiers |
| Public layout reference | Yes | The approved `data/public/warehouse-zones.csv` source and its README | Keep only the approved columns and value types; no row IDs, timestamps, inventory, or user data |
| Private runtime data | No | Replit PostgreSQL rows, Clerk users/sessions, analytics, audit/support data, logs, deployment state | Keep in the appropriate Replit-managed runtime service |
| Private uploaded objects | No | Part photos, catalog PDFs, spreadsheets, customer documents, screenshots | Keep in private object storage or an external local path; never commit the bytes or a durable public URL |
| Secret material | No | Database URLs, Clerk secret keys, AI keys, session secrets, tokens, private keys, passwords | Store in Replit Secrets or the provider; use reserved synthetic placeholders in tests |

## Replit runtime boundary

The deployed API keeps PostgreSQL data in Replit-hosted PostgreSQL, server
configuration in Replit Secrets, and uploaded part/catalog objects in the
private Replit Object Storage namespace. Catalog spreadsheets are supplied
from outside the repository and parsed in memory. The public map namespace is
the deliberate exception: its minimized layout assets are public and must not
be used as a database or inventory export.

Private object access is authenticated and uses private, no-store responses.
There is no generic anonymous private-object route. See
[the private uploaded-object policy](private-object-storage.md) for retention
and cleanup rules.

## Before tracking a file

1. Run `node scripts/test/public-repository-boundary.test.mjs`.
2. Confirm the file is source, synthetic test data, or intentionally public
   layout data.
3. Confirm it contains no database export, user record, upload, operational
   log, private object, or real credential.
4. For layout changes, confirm the public geometry and labels are safe to
   disclose and do not contain identifiers or timestamps. The boundary guard
   allows only `README.md` and `warehouse-zones.csv` under `data/public/`.
   The CSV header must remain exactly:
   `aisle_key,section,is_inventory,svg_x,svg_y,svg_width,svg_height,sort_order`.
   Aisle keys use `aisle-<integer>`, section is empty or a non-negative integer,
   `is_inventory` is `t` or `f`, geometry values are finite non-negative
   numbers, and `sort_order` is a non-negative integer.