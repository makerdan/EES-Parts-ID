# UX E2E — AI Status and Provider Controls

**Journey:** Admin hub → AI & Enrichment → status/probe/catalogue/provider/fallback controls → save/reload  
**Mode:** Report-only  
**Phases:** 0–5, 8, 10–12

## App map and happy path

`app/(tabs)/upload.tsx` fetches `/admin/ai-status`, probes `/admin/ai-status/probe`, refreshes the catalogue, posts provider changes, and puts fallback routes through a guarded PUT. The section has generation/controller guards for status, probe, catalogue, and routes.

## Persistence and cross-context checks

Provider/fallback state is server-backed; the section keeps the current status in memory. `[MANUAL QA NEEDED]` verify reload after persisted versus runtime-only provider changes, provider outage, capability filtering, long model names, and a second admin session.

## Failure, retry, navigation, accessibility

Status/probe/catalogue/routes expose shared error text and disabled states. Provider save is the outlier: it has no AbortController or token/generation check and updates local state after the response.

## Findings

### HIGH

#### F-095 · AI provider save lifecycle · Phase 3 (Silent Failure)

**Failure:** `saveAiProvider` posts without a signal, request generation, or current-token check. If the admin leaves the section, logs out, or changes identity while the request is pending, its late response can set the provider and “saved/runtime-only” state for the wrong session; a transport failure after server acceptance can also leave the local display misleading.

**Fix:** `app/(tabs)/upload.tsx` `saveAiProvider` — use the same guarded controller/generation contract as routes/catalogue, clear/abort on token change, and reconcile with a fresh `/admin/ai-status` response before showing the final provider state.

### MEDIUM

#### F-096 · AI catalogue refresh response handling · Phase 3 (Silent Failure)

**Failure:** `refreshAiCatalogue` sets `aiStatus` from the response before checking `res.ok`. An error response containing a partial `catalogue` can replace a usable status snapshot, then display an error against the partial state and leave fallback choices based on incomplete data.

**Fix:** `app/(tabs)/upload.tsx` `refreshAiCatalogue` — validate HTTP status and the complete payload before committing it; retain the last known catalogue on failure and show Retry with the failed refresh reason.

## Seed/context

Provider routing is governed by Task 1174. Existing provider/fallback persistence tasks #1063 and #1138 own their specific save contract; this report isolates the remaining client lifecycle and partial-response behavior.

## [MANUAL QA NEEDED]

- Provider save while navigating/logging out.
- Catalogue outage, malformed payload, and safe fallback retention.
- Keyboard/screen-reader operation of model controls and disabled/busy announcements.

## Report-only stop

No fix or test change was made.
