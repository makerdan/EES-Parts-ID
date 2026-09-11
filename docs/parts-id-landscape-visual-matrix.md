# Parts ID landscape visual matrix

Validated at short mobile landscape (844×390) with portrait rotation at 390×844. Source and component guards use the short-landscape threshold below 500 points.

| Surface category | Representative states | Evidence |
| --- | --- | --- |
| Signed out | Login, sign-up, verification form | Browser-confirmed internal scrolling to every final action and back; no ScrollView layout invariant |
| Approval guards | Pending, banned, regular-user Admin restriction | Shared scroll contract with flex-growing content and tab-bar bottom clearance; focused regression assertions |
| Tab navigation | Search, Photo ID, Map, Admin, Help | Browser-confirmed landscape navigation; Help route and selected tab survived landscape → portrait → landscape |
| Search and lists | Empty/search content, filters, virtualized result list | Browser-confirmed final controls above tab bar; FlatList keeps its own scrolling and dynamic bottom clearance |
| Photo and camera entry | Photo form, image actions, progress/result content | Browser-confirmed final action reachability; keyboard-aware content and compact landscape clearance |
| Warehouse map | Map surface, select mode, zoom controls, hint overlay | Browser-confirmed foreground controls remain usable above map; rotation and transform suites cover viewport changes |
| Measurement | Ready, scanning, confirm, camera/depth background | Component-confirmed short-landscape compact layout; absolute camera remains behind safe-area foreground controls |
| Admin and catalog stacks | Dashboard, audit, inbox, calibration, AI log, catalog review, item editor | Scroll/virtualized-list flex-growth guards; existing route tests plus landscape source contract cover loading, empty, error, and long-content branches |
| Forms and keyboard | Auth forms, Photo, Help, editor/contact forms | Browser-confirmed auth reachability; keyboard-aware scroll wrappers preserve taps and bottom actions |
| Overlays | Help intro, modals, sheets, banners, map hint, scanner overlay | Browser-confirmed Help intro dismissal; component tests and z-index/pointer contracts cover native map/camera overlays |
| Backgrounds and safe areas | Static screens, scrolling screens, map/camera surfaces | Root backgrounds fill flex containers; safe-area/tab-bar clearance remains foreground-owned rather than wrapping gesture or virtualized surfaces in a global scroll view |

## Automated evidence

- `landscapeReachability.test.ts` checks app orientation, safe-area-aware compact tabs, signed-out/guarded reachability, virtualized-list flex growth, keyboard wrappers, and foreground stacking.
- `map-orientation.test.ts` covers portrait/landscape viewport calculations.
- `WarehouseMapView.test.tsx` covers map transform and gesture behavior.
- `MeasurePartScreen.test.tsx` covers camera/measurement phases and short-landscape controls.