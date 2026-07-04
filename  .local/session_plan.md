# Objective
Run an in-depth production-scope security scan across the application and report only real, exploitable vulnerabilities.

# Relevant information
- Production surface is the Express API in `artifacts/api-server` plus authenticated client flows in `artifacts/parts-id`.
- All `/api/*` traffic passes through `requireAppAuth` except the explicit public allowlist in `artifacts/api-server/src/middlewares/requireAppAuth.ts`.
- Admin-only routes are expected to enforce `requireAdminAuth` server-side; frontend admin state is not authoritative.
- High-risk concerns are broken access control, unsafe admin/query endpoints, file and image upload handling, AI/provider abuse, and data exposure through broad authenticated endpoints.
- `artifacts/mockup-sandbox` preview/design routes are treated as dev-only unless production reachability is demonstrated.
- Deterministic scans ran already: SAST produced mostly dev-only findings; HoundDog produced no findings.

# Tasks

### T001: Authentication and authorization boundaries
- **Blocked By**: []
- **Details**:
  - Inspect `requireAppAuth`, `requireAdminAuth`, `/admin/*`, approval flows, and any route that derives privilege from client-controlled state.
  - Files: `artifacts/api-server/src/middlewares/*.ts`, `artifacts/api-server/src/routes/admin*.ts`, `artifacts/api-server/src/routes/index.ts`, relevant client auth helpers if needed.
  - Acceptance: Confirm whether auth/admin enforcement is sound or document concrete broken access control findings.

### T002: Public and broadly authenticated data/API surfaces
- **Blocked By**: []
- **Details**:
  - Inspect public or app-authenticated read/search/reference/AI/contact/track endpoints for data exposure, missing rate limits, prompt abuse with security impact, and response overexposure.
  - Files: `artifacts/api-server/src/routes/inventory.ts`, `inventoryCategories.ts`, `reference.ts`, `ai.ts`, `contact.ts`, `track.ts`, `dictionaries.ts`, `health.ts`.
  - Acceptance: Confirm whether these surfaces expose sensitive data or permit abusive unauthenticated/authenticated actions with real impact.

### T003: Admin mutation, upload, and document-processing surfaces
- **Blocked By**: []
- **Details**:
  - Inspect admin upload/query/PDF/photo/floor-plan/object-storage flows for injection, arbitrary file handling, path traversal, unsafe content processing, and DoS-prone endpoints.
  - Files: `artifacts/api-server/src/routes/adminUpload.ts`, `catalogPdf.ts`, `floorPlan.ts`, `inventory.ts`, `adminQuery.ts`, `artifacts/api-server/src/lib/objectStorage.ts`, `artifacts/api-server/src/utils/pdfProcessor.ts`.
  - Acceptance: Confirm whether an attacker with available privileges can escape intended access or force disproportionate backend work.

### T004: Mobile client trust assumptions and token handling
- **Blocked By**: []
- **Details**:
  - Inspect the mobile client only where it affects server trust assumptions or leaks privileged capability, such as token handling, admin verification, and direct calls to sensitive endpoints.
  - Files: `artifacts/parts-id/app/_layout.tsx`, `artifacts/parts-id/contexts/AppContext.tsx`, `artifacts/parts-id/utils/*.ts`, selected admin screens.
  - Acceptance: Identify only client issues that materially weaken production security, not ordinary client-side UX flaws.
