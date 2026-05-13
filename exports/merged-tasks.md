# Merged Task History

Total: 32 merged tasks
Exported: 2026-05-13T01:12:35.753Z

---

## Task #1: Parts ID mobile app

- **State:** MERGED
- **Created:** 2026-05-01T01:29:08.749000+00:00
- **Updated:** 2026-05-01T04:13:11.790000+00:00

### Description

# Parts ID Mobile App

## What & Why
Build a mobile-first Expo (React Native) app for electrical parts identification and warehouse inventory lookup. Warehouse workers identify parts visually or by keyword and locate them by bin address. All dictionary data, inventory, and enrichment live in a PostgreSQL database. The app is protected by a simple password-only gate (no username).

## Done looks like
- Password-only login screen; one correct password grants access for the session
- Two primary se…(truncated)

---

## Task #2: Add barcode/QR scanning for instant part lookup

- **State:** MERGED
- **Created:** 2026-05-01T02:41:47.928000+00:00
- **Updated:** 2026-05-03T05:02:26.953000+00:00
- **Depends on:** #1

### Description

# Add barcode/QR scanning for instant part lookup

## What & Why
Workers in the warehouse already know the SKU they want; the bottleneck
is typing it on a phone. Letting them scan the barcode printed on the
box (or a QR code stuck on a bin) jumps straight to the right part in
under a second. Because vendor barcodes (UPCs) aren't the same string as
the warehouse catalog code, we need a lookup table that maps any scanned
string to a part — and a "scan-to-link" workflow so the warehouse can
teach t…(truncated)

---

## Task #4: Make the app work offline by caching the last search results

- **State:** MERGED
- **Created:** 2026-05-01T02:41:47.928000+00:00
- **Updated:** 2026-05-01T18:47:05.663000+00:00
- **Depends on:** #1

### Description

# Make the app work offline by caching the last search results

  ## What & Why
  Warehouse environments often have spotty WiFi near shelving. Caching the last successful inventory search results locally (using AsyncStorage or MMKV) lets workers browse recent results even when the API is unreachable. Fuse.js offline fallback is already wired in but only works if results were fetched previously.

  ## Done looks like
  - After each successful search, results are cached locally keyed by query
  - …(truncated)

---

## Task #5: Collapse Filter Dimensions by default

- **State:** MERGED
- **Created:** 2026-05-01T03:03:55.247000+00:00
- **Updated:** 2026-05-01T14:07:11.127000+00:00
- **Depends on:** #1

### Description

# Collapse Filter Dimensions by Default

## What & Why
The "Filter Dimensions" section in the filter panel is always expanded. It should start collapsed so the UI is less overwhelming, with a toggle to expand it when needed.

## Done looks like
- The "Filter Dimensions" section is collapsed by default when the filter panel opens
- A chevron/arrow icon or tap on the header row toggles it open and closed
- The active chip count badge is still visible in the header even when collapsed
- Expanding/c…(truncated)

---

## Task #6: Import spreadsheet as inventory database

- **State:** MERGED
- **Created:** 2026-05-01T03:22:03.733000+00:00
- **Updated:** 2026-05-01T20:09:31.637000+00:00
- **Depends on:** #1

### Description

# Import Spreadsheet as Inventory Database

## What & Why
The user has provided a spreadsheet (`Master_INC_Report_(04.29.2026)_-_For_PartsID_Database.xlsx`) containing 7,397 parts with columns matching the database schema exactly: `vendor`, `catalog`, `description`, `binlocation`. This task loads that file into the inventory table so the app has real data from day one.

## Done looks like
- All 7,397 parts from the spreadsheet are present in the inventory database
- Searching in the Parts ID app…(truncated)

---

## Task #7: Keyword search includes catalog numbers

- **State:** MERGED
- **Created:** 2026-05-01T03:24:53.595000+00:00
- **Updated:** 2026-05-01T20:15:50.271000+00:00
- **Depends on:** #1

### Description

# Keyword Search Matches Catalog Numbers

## What & Why
When a user types a catalog number (e.g. "BR120") into the "Keywords / Description" search field, they expect to see matching parts. The field does partial catalog parsing, but the SQL similarity check against the catalog column only uses the first few expanded terms — not the raw keyword string directly. This means catalog-number queries entered as keywords can miss results.

## Done looks like
- Typing a full or partial catalog number (e.…(truncated)

---

## Task #8: Auto-resize photos to fit size requirements

- **State:** MERGED
- **Created:** 2026-05-01T03:34:24.767000+00:00
- **Updated:** 2026-05-01T20:15:56.217000+00:00
- **Depends on:** #1

### Description

# Auto-resize Photos After Selection

## What & Why
After a user takes or imports a photo, run it through an image manipulation step that enforces a target resolution range. This ensures the AI vision model always receives an image that is large enough to identify the part clearly, and small enough to keep the request payload fast.

## Done looks like
- Photos that are too small (width under 800 px) are upscaled to at least 800 px wide before being sent.
- Photos that are very large (width over …(truncated)

---

## Task #9: Remember whether Filter Dimensions was left open or closed

- **State:** MERGED
- **Created:** 2026-05-01T04:14:45.336000+00:00
- **Updated:** 2026-05-01T20:28:00.451000+00:00
- **Depends on:** #5

### Description

# Remember whether Filter Dimensions was left open or closed

  ## What & Why
  The Filter Dimensions section now collapses by default, but resets to collapsed every time the filter panel is opened. If a user regularly works with dimension filters, they have to re-expand it every session.

  ## Done looks like
  - The expanded/collapsed state of the Filter Dimensions section persists across app restarts using AsyncStorage
  - On first launch it still defaults to collapsed
  - No other filter pan…(truncated)

---

## Task #10: Collapse other filter sections to reduce visual clutter

- **State:** MERGED
- **Created:** 2026-05-01T04:14:45.336000+00:00
- **Updated:** 2026-05-01T20:32:12.338000+00:00
- **Depends on:** #5

### Description

# Collapse other filter sections to reduce visual clutter

  ## What & Why
  Now that Filter Dimensions is collapsible, the text field rows (Keywords, Catalog #, Vendor, Color, Size, Material, Text/Numbers) are always fully visible even when not in use. Grouping them under a collapsible "Basic Filters" header — collapsed by default — would make the panel even cleaner on first open.

  ## Done looks like
  - The text field rows are wrapped in a collapsible "Basic Filters" section with the same ch…(truncated)

---

## Task #12: Let users manually clear the offline cache from settings

- **State:** MERGED
- **Created:** 2026-05-01T14:09:51.145000+00:00
- **Updated:** 2026-05-01T20:37:36.644000+00:00
- **Depends on:** #4

### Description

# Add a manual cache clear option

  ## What & Why
  The offline cache is currently only cleared on logout or after 24 hours. If inventory data changes frequently and workers need fresh results, giving them a manual "Clear cached data" option in a settings or profile screen lets them force a refresh without logging out.

  ## Done looks like
  - A settings or profile screen (or a section in the search screen) has a "Clear cached data" button
  - Tapping it removes both `parts_id_fuse_cache_v2` a…(truncated)

---

## Task #13: Enrich all 7,397 imported parts with AI search keywords

- **State:** MERGED
- **Created:** 2026-05-01T18:50:06.089000+00:00
- **Updated:** 2026-05-02T02:12:02.304000+00:00
- **Depends on:** #6

### Description

# Enrich all 7,397 imported parts with AI search keywords

  ## What & Why
  The spreadsheet import populated the inventory with real data, but none of the 7,397 parts have AI-generated keywords yet (enrichedAt is NULL for all). The existing /inventory/enrich endpoint processes 50 items per call. A script or background job that pages through all unenriched items and calls this endpoint will dramatically improve search quality — workers will find parts by describing what they're looking for in pl…(truncated)

---

## Task #14: Let admins update inventory by uploading a new spreadsheet in the app

- **State:** MERGED
- **Created:** 2026-05-01T18:50:06.089000+00:00
- **Updated:** 2026-05-02T02:02:52.882000+00:00
- **Depends on:** #6

### Description

# Let admins update inventory by uploading a new spreadsheet in the app

  ## What & Why
  Currently, updating the inventory database requires developer access and running a CLI script. When the warehouse receives a new INC report spreadsheet, an admin should be able to upload it directly from the Parts ID app to refresh the inventory — no developer involvement needed.

  ## Done looks like
  - An admin screen in the Parts ID mobile app (or a web admin page) accepts an .xlsx file upload
  - The …(truncated)

---

## Task #15: Show a loading indicator while a photo is being processed

- **State:** MERGED
- **Created:** 2026-05-01T20:11:29.515000+00:00
- **Updated:** 2026-05-02T01:53:06.481000+00:00
- **Depends on:** #8

### Description

# Show a loading indicator while a photo is being processed

  ## What & Why
  After auto-resize was added, picking a large image from the library can take a moment while resizeImage runs manipulateAsync. Currently the UI gives no feedback during this time — the user just waits with no indication anything is happening. A subtle spinner or "Processing…" state would prevent confusion.

  ## Done looks like
  - A loading state is set to true after the user picks an image and before resizeImage reso…(truncated)

---

## Task #16: Verify photo resize works correctly with real images

- **State:** MERGED
- **Created:** 2026-05-01T20:11:29.515000+00:00
- **Updated:** 2026-05-02T01:51:10.695000+00:00
- **Depends on:** #8

### Description

# Verify photo resize works correctly with real images

  ## What & Why
  The resizeImage utility was added without automated tests. Edge cases like images exactly at 800px or 1920px, or images with no reported width (width 0), should be verified to behave correctly.

  ## Done looks like
  - Unit tests cover: image under 800px is upscaled to 800px, image over 1920px is downscaled to 1920px, image within range is passed through unchanged, width=0 falls back gracefully

  ## Relevant files
  - `a…(truncated)

---

## Task #19: Move dimension filters into the top-bar Filters dropdown

- **State:** MERGED
- **Created:** 2026-05-01T20:18:36.590000+00:00
- **Updated:** 2026-05-01T20:45:07.126000+00:00

### Description

# Move Dimension Filters into Top-Bar Filters

## What & Why
The top-bar "Filters" dropdown currently shows only free-text fields (Keywords, Catalog #, Vendor, Color, Size, Material, Text/Numbers) and a confidence slider, but none of the structured chip-based dimension filters. Those 16 dimension chip rows (Category, Amperage, Color, Manufacturer, Size, Rating, Wire Type, Wire Gauge, Conduit Type, Conduit Size, Box Type, Box Gang Count, Mounting Type, Environment, Voltage, Pole Count) are buried…(truncated)

---

## Task #20: Change Log Off icon to Feather log-out

- **State:** MERGED
- **Created:** 2026-05-01T20:18:43.678000+00:00
- **Updated:** 2026-05-01T20:48:12.717000+00:00

### Description

# Change Log Off Icon

## What & Why
Replace the current `⎋` escape character used as the log-off button icon with the Feather `log-out` icon, which is already used elsewhere in the app and clearly communicates "sign out."

## Done looks like
- The log-off button on the home screen shows the Feather `log-out` icon (arrow exiting a door) instead of the `⎋` character.
- The button retains its existing size, style, and behavior.

## Out of scope
- Any changes to the logout flow or confirmation moda…(truncated)

---

## Task #21: Remember each worker's expanded/collapsed state for all filter sections

- **State:** MERGED
- **Created:** 2026-05-01T20:25:02.601000+00:00
- **Updated:** 2026-05-02T01:57:29.637000+00:00
- **Depends on:** #9

### Description

# Persist collapsed state for all filter sections

  ## What & Why
  Task #9 persists Filter Dimensions open/closed state. When Task #10 (Collapse other filter sections) ships, each new collapsible section will also reset on every launch. The same AsyncStorage pattern should extend to all panels so workers don't re-open sections every session.

  ## Done looks like
  - Every collapsible section added by Task #10 reads its initial state from AsyncStorage on mount and writes back on toggle
  - A s…(truncated)

---

## Task #23: Show workers how old their cached search results are

- **State:** MERGED
- **Created:** 2026-05-01T20:34:52.292000+00:00
- **Updated:** 2026-05-02T02:00:47.217000+00:00
- **Depends on:** #12

### Description

# Display cache age in the Settings modal

  ## What & Why
  Workers who tap "Clear" in Settings don't know whether the cache is 2 minutes or 23 hours old. Showing the age of the cached data (e.g. "Last updated 4 hours ago") next to the Clear button helps them decide whether clearing is actually needed.

  ## Done looks like
  - The "Search cache" row in the Settings modal shows a timestamp line: "Last updated X minutes/hours ago" or "No cached data"
  - The timestamp is read from the newest ent…(truncated)

---

## Task #24: Let workers reset chip filters without losing their text search terms

- **State:** MERGED
- **Created:** 2026-05-01T20:39:38.107000+00:00
- **Updated:** 2026-05-02T02:04:44.024000+00:00
- **Depends on:** #19

### Description

# Add a "Reset dimensions" button to clear chip filters independently

  ## What & Why
  Now that all 16 chip dimension rows are always visible in the Filters panel (not buried in a collapsible section), workers will interact with them more often. Currently the only way to clear chip selections is the "Clear" button at the bottom, which wipes all text fields too. Workers need a way to reset just the chip filters when they want to broaden a structured search without losing the keywords or catalog…(truncated)

---

## Task #25: Add a visible label to the top-bar settings button so workers know what it opens

- **State:** MERGED
- **Created:** 2026-05-01T20:46:08.261000+00:00
- **Updated:** 2026-05-01T20:50:15.379000+00:00
- **Depends on:** #20

### Description

# Label the top-bar settings/log-out button

  ## What & Why
  The top-bar button now shows the Feather `log-out` icon, but tapping it opens a "Settings" modal (cache clear + sign out). Workers may assume one tap immediately signs them out, rather than understanding it leads to a modal. A small label ("Settings" or "Menu") below or beside the icon would clarify intent at a glance.

  ## Done looks like
  - The top-bar button shows the log-out icon plus a compact text label (e.g. "Settings")
  - …(truncated)

---

## Task #26: Add real app settings to the Settings menu (font size, default filters)

- **State:** MERGED
- **Created:** 2026-05-01T20:49:32.395000+00:00
- **Updated:** 2026-05-01T20:57:45.791000+00:00
- **Depends on:** #25

### Description

# Add real app settings to the Settings menu

  ## What & Why
  Now that the button is clearly labeled "Settings", workers expect to find configurable preferences there. Currently the modal only offers cache clear and sign-out. Adding 1–2 lightweight settings (e.g. text size preference, default filter state) would justify the label and improve daily usability.

  ## Done looks like
  - The Settings modal includes at least one user-configurable preference (e.g. default filter panel open/closed on…(truncated)

---

## Task #27: Make the header buttons consistent in size and spacing

- **State:** MERGED
- **Created:** 2026-05-01T20:49:32.395000+00:00
- **Updated:** 2026-05-01T21:02:00.795000+00:00
- **Depends on:** #25

### Description

# Make the header buttons consistent in size and spacing

  ## What & Why
  The top-bar now has two buttons side by side — "Filters" toggle and "Settings". Their heights and padding are defined independently and can drift. Extracting a shared `HeaderButton` style or component would keep them visually aligned and make future header changes easier.

  ## Done looks like
  - Both header buttons use a shared base style or component
  - Their height, border-radius, and padding match visually
  - No c…(truncated)

---

## Task #28: Apply text size preference to the Photo ID results tab too

- **State:** MERGED
- **Created:** 2026-05-01T20:54:58.271000+00:00
- **Updated:** 2026-05-01T21:02:00.488000+00:00
- **Depends on:** #26

### Description

# Apply text size preference to the Photo ID results tab too

  ## What & Why
  The text size setting added to the Settings modal is currently only applied to search result cards on the Search tab. The Photo ID tab has its own result display that still uses fixed font sizes, so the setting has no effect there.

  ## Done looks like
  - The text size preference (Small / Normal / Large) is read from AsyncStorage or a shared context on app startup
  - Result cards shown after photo identification a…(truncated)

---

## Task #29: Let workers set a default minimum confidence threshold in Settings

- **State:** MERGED
- **Created:** 2026-05-01T20:54:58.271000+00:00
- **Updated:** 2026-05-01T21:13:23.684000+00:00
- **Depends on:** #26

### Description

# Let workers set a default minimum confidence threshold in Settings

  ## What & Why
  Workers frequently adjust the confidence threshold slider to find parts that don't hit the 50% default. Letting them save their preferred threshold in Settings means they don't have to re-adjust it on every search, reducing friction for workers who routinely use lower thresholds.

  ## Done looks like
  - Settings modal includes a default confidence threshold control (e.g. slider or step buttons: 30 / 50 / 70…(truncated)

---

## Task #30: Keep text size in sync across tabs instantly when changed in Settings

- **State:** MERGED
- **Created:** 2026-05-01T20:59:14.354000+00:00
- **Updated:** 2026-05-02T02:09:51.007000+00:00
- **Depends on:** #28

### Description

# Sync text size change across tabs without requiring a restart

  ## What & Why
  The text size preference is currently loaded once from AsyncStorage when each tab mounts. If a worker changes the text size in Settings (on the Search tab), the Photo ID tab won't reflect that change until the app is restarted. Lifting the setting into AppContext (or a shared React state) would make both tabs react instantly when the setting changes.

  ## Done looks like
  - Changing Text Size in the Settings mod…(truncated)

---

## Task #31: Use a shared button style for smaller action buttons throughout the search results area

- **State:** MERGED
- **Created:** 2026-05-01T20:59:35.977000+00:00
- **Updated:** 2026-05-02T01:42:44.936000+00:00
- **Depends on:** #27

### Description

# Use a shared button style for smaller action buttons in the search results area

  ## What & Why
  The search screen has several smaller action buttons (e.g. "New Search", "Clear Cache", text-size picker buttons) each with independently defined padding, border-radius, and font sizes. Extracting a shared secondary-button style would keep these consistent and easier to update in one place.

  ## Done looks like
  - A shared `secondaryBtn` (or similar) style is defined in the StyleSheet
  - The "…(truncated)

---

## Task #33: Rename "Filter Dimensions" to "Advanced Filters"

- **State:** MERGED
- **Created:** 2026-05-02T00:57:59.252000+00:00
- **Updated:** 2026-05-02T01:00:57.792000+00:00

### Description

# Rename "Filter Dimensions" to "Advanced Filters"

## What & Why
The section label "Filter Dimensions" in the filter panel should be renamed to "Advanced Filters" to use clearer, more intuitive language for workers.

## Done looks like
- The filter panel section previously labeled "Filter Dimensions" now displays "Advanced Filters" everywhere it appears in the UI.

## Out of scope
- Any changes to functionality or layout of the filter section.

## Steps
1. **Update the visible label** — Change …(truncated)

---

## Task #34: Remove Filters wrapper, show Advanced Filters directly

- **State:** MERGED
- **Created:** 2026-05-02T01:18:44.696000+00:00
- **Updated:** 2026-05-02T01:22:14.667000+00:00

### Description

# Remove Filters Wrapper, Show Advanced Filters Directly

## What & Why
The "Filters" toggle button in the search bar currently wraps the FilterPanel in a show/hide dropdown. Since Advanced Filters is already its own collapsible card inside the FilterPanel, the outer "Filters" wrapper is redundant. Remove it so the Advanced Filters card is always visible directly below the search bar, letting users expand/collapse it themselves.

## Done looks like
- The "Filters" / "Hide Filters" button is gone…(truncated)

---

## Task #35: Allow multiple photo selection from library in Photo ID tab

- **State:** MERGED
- **Created:** 2026-05-02T01:21:02.790000+00:00
- **Updated:** 2026-05-02T01:24:26.060000+00:00

### Description

# Allow Multiple Photo Selection in Photo ID Tab

## What & Why
When a worker taps the Gallery button on the Photo ID tab, they can currently only pick one photo at a time. This change lets them select multiple photos from their library in a single picker session, speeding up identification of parts that need more than one angle.

## Done looks like
- Tapping "Gallery" opens the native photo picker with multi-select enabled
- Workers can select up to 4 photos in one session
- All selected photos…(truncated)

---

## Task #37: Show a photo counter so workers know how many slots they have left

- **State:** MERGED
- **Created:** 2026-05-02T01:23:06.826000+00:00
- **Updated:** 2026-05-02T01:29:14.881000+00:00
- **Depends on:** #35

### Description

# Show a photo counter so workers know how many slots they have left

  ## What & Why
  With up to 4 photo slots available, workers currently have no visual indicator of how many they've used or how many remain. A small "2 / 4" counter near the image row would prevent confusion when the add buttons disappear after 4 photos are selected.

  ## Done looks like
  - A counter like "2 / 4 photos" is shown near the image row whenever at least one photo is added
  - The counter updates as photos are ad…(truncated)

---

## Task #39: Match parts across metric and imperial measurement units

- **State:** MERGED
- **Created:** 2026-05-02T01:40:01.021000+00:00
- **Updated:** 2026-05-02T03:23:26.967000+00:00

### Description

# Cross-Unit Measurement Matching

## What & Why
Workers may search for a part using metric measurements (e.g. "10mm conduit") while the part's description uses imperial units ("3/8 inch conduit"), or vice versa. Currently these searches miss each other entirely. This feature ensures that any measurement a worker types — in any unit — surfaces parts regardless of which unit system their description uses.

## Done looks like
- Searching "10mm" surfaces parts whose descriptions contain "3/8 inch" …(truncated)

---

## Task #40: Extend the shared button style to other bordered buttons in the app

- **State:** MERGED
- **Created:** 2026-05-02T01:41:39.262000+00:00
- **Updated:** 2026-05-02T02:12:14.134000+00:00
- **Depends on:** #31

### Description

# Extend the shared button style to other bordered buttons in the app

  ## What & Why
  Task #31 introduced a `secondaryBtn` shared style ({ borderWidth: 1, borderRadius: 8 }) for three small action buttons. Several other buttons in the same file also duplicate the same borderWidth/borderRadius pair independently and could compose from the shared base for easier future updates.

  ## Done looks like
  - `searchBarClearBtn` (borderRadius: 8, borderWidth: 1) composes from `secondaryBtn`
  - `logo…(truncated)

---
