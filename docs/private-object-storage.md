# Private uploaded-object policy

## Object classes

| Class | Storage namespace | Audience | Cache policy | Retention |
| --- | --- | --- | --- | --- |
| Warehouse map/layout SVG and tiles | `floor-plan/` and the public tile contract | Anonymous map readers | Public, bounded cache | Replaced map assets follow the existing public map contract |
| Part photos and catalog-derived images | `private/catalog-images/` | Approved application users and admins | `private, no-store` | Retain while referenced by inventory; remove on replacement, removal, inventory deletion, failed/cancelled/reverted processing |
| Resumable catalog PDF parts | `private/catalog-pdf-staging/<session>/` | Owning approved admin only | `no-store` | Remove bytes on successful handoff, cancellation, expiration, invalid/checksum failure, account deletion, and after cleanup; completed manifest metadata may remain |
| Spreadsheet payloads | No source-object namespace | Approved admins only during the request | Not cached | CSV bytes are parsed in memory and are not persisted |

Private database fields contain object references for server-side lookup only.
API responses expose an authenticated image route, never a durable bucket URL.
There is no generic anonymous private-object route.

Cleanup is idempotent and namespace-guarded. A private cleanup operation rejects
the public warehouse-map namespace before calling storage, so deleting an
inventory item or expiring an upload cannot remove shared map assets.