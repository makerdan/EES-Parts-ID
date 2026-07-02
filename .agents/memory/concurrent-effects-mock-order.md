---
name: Concurrent effects consume fetchWithAuth mocks out of order
description: WarehouseMapView server-hash polling effect fires on mount at the same time as the SVG load effect; any test that stubs fetchWithAuth for _loadFloorPlanFromServer must account for the extra meta call.
---

WarehouseMapView registers two effects that call `fetchWithAuth` independently on mount:
1. **Server-hash polling** (line 1452): fires on mount, calls `GET /floor-plan/meta` immediately to establish the baseline hash (`knownServerHashRef.current`).
2. **SVG load IIFE** (line 1480): runs `_loadFloorPlanFromServer()` which also calls `GET /floor-plan/meta` then `GET /floor-plan/svg`.

Both effects are passive (useEffect), scheduled in registration order. The polling effect runs its async body first (it has no `await` before `fetchWithAuth`), so it consumes the first `mockResolvedValueOnce` before `_loadFloorPlanFromServer` runs.

**Why:** Debug tracing showed `fetchWithAuth=2 setCached=0` — both fetches completed before the drain loop but `setCached` was never reached. The SVG-load meta call received the SVG-response mock (no `.json` method), threw, fell through to `_loadFloorPlanFromBundle`, and ultimately called `setFallbackEmpty()` instead of `setCached`.

**How to apply:** Any test that stubs `fetchWithAuth` for the B-path (cold cache → server load) must prepend one extra `mockResolvedValueOnce` for the polling effect's meta call before the two stubs for `_loadFloorPlanFromServer`. Ordering must be:
1. `{ ok: true, json: async () => ({ hash }) }` — polling effect
2. `{ ok: true, json: async () => ({ hash }) }` — `_loadFloorPlanFromServer` meta
3. `{ ok: true, text: async () => "<svg/>" }` — `_loadFloorPlanFromServer` svg
4. `.mockResolvedValue({ ok: false })` — catch-all fallback
