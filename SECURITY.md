# Security policy

## Supported versions

Only the latest commit on the default `main` branch and the currently deployed
release are supported. Older commits, forks, local copies, and unreleased
branches may contain known issues and do not receive security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use GitHub's
private vulnerability reporting or a private security advisory for this
repository when that feature is available. Include the affected revision,
the smallest reproducible example that does not contain real private data, the
impact, and a suggested mitigation if you have one.

If private reporting is not available, contact the repository maintainer
privately through the account associated with this repository and request a
confidential channel. Do not include credentials, access tokens, customer
files, database exports, or uploaded documents in a report.

The maintainer will acknowledge a report when practical, investigate it
privately, coordinate a fix, and publish only the minimum details needed for a
release note after affected users can update. Please allow reasonable time for
coordination before public disclosure.

## Secret and credential handling

- Never commit a real secret, token, private key, password, connection string,
  or a copied production environment value.
- Put server-only values in Replit Secrets. `DATABASE_URL`, Clerk secret keys,
  AI provider keys, session secrets, and object-storage configuration must
  never enter the mobile/web bundle.
- Use reserved synthetic values such as `example.com`, `localhost`, and
  clearly fake test tokens in documentation and fixtures.
- If a secret is committed, stop distributing the revision, revoke or rotate
  the credential immediately through its provider, preserve the evidence
  needed for incident response without reposting the value, and privately
  notify the maintainer. Removing a file in a later commit is not sufficient;
  reachable history and forks must also be assessed.

## Clerk and Replit boundaries

Clerk authenticates users and supplies the client only with publishable
configuration. Authorization decisions, Clerk secret material, database
access, Replit integrations, and object-storage access stay on the server.
Replit-hosted PostgreSQL, Object Storage, Secrets, deployment configuration,
logs, analytics, and operational tooling are runtime services, not public
repository data.

The warehouse floor plan and minimized public map/layout data under
`data/public/` are intentionally public reference assets. This exception does not include
inventory records, user records, admin/audit data, support messages, analytics,
catalog documents, part photos, or any other uploaded object.

## Do not commit

Do not add user or customer data, database dumps or exports, inventory
exports, uploaded files, screenshots containing private information,
operational logs, private object-storage payloads, or real user identifiers.
Use external local files and synthetic fixtures for development and tests.
Review [the public data classification](docs/public-data-classification.md)
and [the release checklist](docs/public-release-checklist.md) before publishing
new source or layout assets.