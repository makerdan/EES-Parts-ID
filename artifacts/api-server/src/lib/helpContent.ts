/**
 * Versioned, server-owned Help content.
 *
 * This is deliberately separate from the electrical Reference prompt. Help is
 * an app-support contract: it is finite, reviewable, and safe to cache by
 * audience. The admin records live in the same governed source as the general
 * records, but are never included in a general response.
 */

export const HELP_SCHEMA_VERSION = "1.0";
export const HELP_CONTENT_VERSION = "1.0.0";

export type HelpAudience = "general" | "admin";

interface HelpRevision {
  contentVersion: string;
  revisedAt: string;
  source: "verified-product-workflow";
}

export interface HelpRecord {
  id: string;
  audience: HelpAudience;
  workflow: string;
  title: string;
  summary: string;
  body: string;
  prerequisites: Array<string>;
  steps: Array<string>;
  outcomes: Array<string>;
  recovery: Array<string>;
  limitations: Array<string>;
  revision: HelpRevision;
}

export interface HelpResponse {
  schemaVersion: string;
  contentVersion: string;
  audience: HelpAudience;
  records: Array<HelpRecord>;
}

export const HELP_LIMITS = {
  maxRecords: 32,
  maxRecordBytes: 12_000,
  maxIdLength: 80,
  maxWorkflowLength: 80,
  maxTitleLength: 120,
  maxSummaryLength: 320,
  maxBodyLength: 1_200,
  maxListItems: 12,
  maxListItemLength: 400,
} as const;

const GENERAL_HELP: Array<HelpRecord> = [
  {
    id: "help.account.sign-in",
    audience: "general",
    workflow: "account-sign-in",
    title: "Create an account and wait for approval",
    summary: "New accounts become usable after an administrator approves them.",
    body: "Register with email and password or a supported sign-in provider. The app shows a pending screen until approval is complete.",
    prerequisites: ["A valid email address", "An internet connection for registration"],
    steps: [
      "Choose Sign Up on the login screen.",
      "Complete registration, then wait on the pending approval screen.",
      "Use Refresh status to check for approval without restarting the app.",
      "Sign in again after approval if the app is not already showing the tabs.",
    ],
    outcomes: ["Approved accounts open the Search, Photo ID, and Map tabs."],
    recovery: [
      "If status remains pending, use Refresh status and contact support through Ref if approval is taking longer than expected.",
      "If the account is blocked, sign-in remains unavailable until an administrator resolves the account status.",
    ],
    limitations: ["Registration does not grant access immediately.", "Blocked accounts cannot use warehouse features."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.search.find-parts",
    audience: "general",
    workflow: "search-find-parts",
    title: "Find a part with Search",
    summary: "Search plain language, browse categories, or narrow results with filters.",
    body: "Search checks vendor, catalog number, description, and available search keywords. Results can be narrowed by attributes and dimensions.",
    prerequisites: ["An approved Parts ID account", "A part description, catalog number, or barcode when available"],
    steps: [
      "Open the Search tab and enter a plain-language description or catalog number.",
      "Use filter chips or Advanced filters to narrow vendor, attributes, markings, or dimensions.",
      "Open a result to review specifications, photos, variants, and bin locations.",
      "Tap a bin location or Map it to see where the part is stored.",
    ],
    outcomes: ["Matching inventory results appear in a ranked list.", "A part detail view shows its available warehouse locations."],
    recovery: [
      "Try fewer search words or browse by aisle, category, or barcode.",
      "On a slow connection, wait for the local cache to finish loading and retry.",
    ],
    limitations: ["Offline results are limited to the device cache.", "A result is not proof that stock is physically present in a bin."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.photo-id.identify-part",
    audience: "general",
    workflow: "photo-id-identify-part",
    title: "Identify a part with Photo ID",
    summary: "Use up to four photos and optional hints to compare a part with inventory.",
    body: "Photo ID sends the selected images and hints through the app's identification flow, then shows likely inventory matches that can be opened or mapped.",
    prerequisites: ["An approved Parts ID account", "Camera or photo-library access", "A recognizable view of the part"],
    steps: [
      "Open Photo ID and take or select up to four photos.",
      "Add optional hints such as vendor, color, size, or markings.",
      "Submit the photos and review the matching result cards.",
      "Open a card for details or choose Show on Map.",
    ],
    outcomes: ["Likely inventory matches appear with confidence information.", "Recent scans remain available for quick access."],
    recovery: [
      "Retake a photo in better light with the catalog label visible.",
      "Add a vendor, color, size, or markings hint and submit again.",
      "Use Search or Ref when Photo ID cannot identify the part.",
    ],
    limitations: ["Photo ID suggests matches; verify the part and specifications before stocking or issuing it.", "No more than four photos can be submitted at once."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.map.locate-parts",
    audience: "general",
    workflow: "map-locate-parts",
    title: "Locate a part on the warehouse map",
    summary: "Open a saved bin location from Search or Photo ID, then pan and zoom the floor plan.",
    body: "The Map tab shows the warehouse floor plan, zones, and part pins. A selected match is highlighted separately from related sizes.",
    prerequisites: ["An approved Parts ID account", "A part with a saved bin location"],
    steps: [
      "Open a part from Search or Photo ID.",
      "Choose Show on Map or tap a bin location.",
      "Pan and zoom the floor plan to reach the highlighted zone.",
      "Tap a zone to inspect the items stored there.",
    ],
    outcomes: ["The map centers on the selected warehouse location.", "The selected part and related locations are distinguishable on the map."],
    recovery: [
      "Return to the part details and confirm it has a bin location.",
      "Reset the map view and try the location again if the map is zoomed too far in.",
    ],
    limitations: ["Map pins reflect saved inventory locations and may not reflect a recently moved item.", "Cycle-count progress is stored on the device."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.reference.ask-question",
    audience: "general",
    workflow: "reference-ask-question",
    title: "Ask the Ref assistant",
    summary: "Use Ref for electrical terminology, inventory questions, and app guidance.",
    body: "Open Ref from the Search header. It can explain electrical terms, help look up inventory, describe app features, and provide general reference answers.",
    prerequisites: ["An approved Parts ID account", "The Ref button in the Search header"],
    steps: [
      "Tap the Ref button in the Search header.",
      "Choose a quick lookup or type a concise question.",
      "Review the answer and any related inventory context.",
      "Use Contact when you need to send a question to support.",
    ],
    outcomes: ["Ref returns a concise answer or indicates when it cannot answer.", "Contact messages are available to the support workflow."],
    recovery: [
      "Retry after checking the network connection if an answer fails.",
      "Rephrase the question with the part number or electrical term.",
      "Use the existing Search, Photo ID, or Map workflow for a direct app action.",
    ],
    limitations: ["Reference answers are informational; follow applicable electrical safety procedures and codes.", "Live reference answers can depend on network availability."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.settings.offline-cache",
    audience: "general",
    workflow: "settings-offline-cache",
    title: "Adjust settings and use cached information",
    summary: "Settings control the server URL, theme, units, and app information.",
    body: "Open Settings to choose a dimension unit, change theme mode, view app version information, and review the configured server URL. Recently viewed parts and quick answers can remain available from the local cache.",
    prerequisites: ["An approved Parts ID account", "Access to Settings"],
    steps: [
      "Open Settings from the app navigation.",
      "Choose the dimension unit and theme mode you want.",
      "Review the app version and configured server URL.",
      "Return to Search or Ref to use information already cached on the device.",
    ],
    outcomes: ["Measurements display in the selected unit.", "Previously cached parts and quick answers remain usable during short outages."],
    recovery: [
      "Restore the configured server URL if current data cannot be reached.",
      "Reconnect to the network and retry to refresh cached information.",
    ],
    limitations: ["Cached information can be older than the current warehouse data.", "Changing settings does not update inventory."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
];

const ADMIN_HELP: Array<HelpRecord> = [
  {
    id: "help.admin.measure",
    audience: "admin",
    workflow: "admin-measure",
    title: "Measure dimensions with LiDAR",
    summary: "Use a LiDAR-capable iPhone or iPad to capture a part bounding box.",
    body: "The Measure workflow is available to administrators on LiDAR devices. Measurements can pre-fill an item's dimensions or become a Search size-range filter.",
    prerequisites: ["A current administrator session with MFA", "An iPhone or iPad with LiDAR", "An item edit form or a Search workflow"],
    steps: [
      "Open Measure from an item edit form or the admin-enabled measurement entry point.",
      "Scan the part and review the captured bounding-box values.",
      "Edit values when necessary, then confirm the measurement.",
      "Save the item dimensions or apply the values as a Search size-range filter.",
    ],
    outcomes: ["Confirmed dimensions are written to the selected item or applied to Search."],
    recovery: ["Rescan with the part fully inside the camera frame.", "Review and manually correct values before confirming."],
    limitations: ["LiDAR measurement is unavailable on devices without LiDAR.", "Captured values require human verification."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.admin.inventory-import",
    audience: "admin",
    workflow: "admin-inventory-import",
    title: "Import inventory from a spreadsheet",
    summary: "Bulk-load vendor, catalog, and description data from CSV or XLSX.",
    body: "The admin import workflow parses spreadsheet rows, deduplicates inventory, and lets you choose how existing bin locations are handled.",
    prerequisites: ["A current administrator session with MFA", "A CSV or XLSX inventory file"],
    steps: [
      "Open the spreadsheet import tool in Admin.",
      "Upload the CSV or XLSX file and review the preview.",
      "Choose whether existing bin locations are skipped or replaced.",
      "Start the import and review the completion summary.",
    ],
    outcomes: ["Valid inventory rows are stored and duplicates are handled by the import rules.", "Invalid rows are reported for correction."],
    recovery: ["Correct the reported spreadsheet rows and upload the file again.", "If the import fails, keep the source file and retry after the server is available."],
    limitations: ["Only supported spreadsheet columns are imported.", "Importing does not verify that a physical bin currently contains the item."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.admin.catalog-review",
    audience: "admin",
    workflow: "admin-catalog-review",
    title: "Review extracted catalog changes",
    summary: "Upload a catalog PDF, review low-confidence extractions, and accept or discard changes.",
    body: "Catalog processing splits large PDFs, extracts parts, and flags uncertain results. Administrators can compare before and after descriptions and decide what to keep.",
    prerequisites: ["A current administrator session with MFA", "A manufacturer catalog PDF"],
    steps: [
      "Upload the catalog PDF from Admin.",
      "Wait for extraction and open the review queue.",
      "Compare each proposed change with the source material.",
      "Fix, revert, or discard the proposed change.",
    ],
    outcomes: ["Approved catalog changes are saved to inventory.", "Low-confidence work remains visible until it is resolved."],
    recovery: ["Resume a failed upload from its last completed chunk.", "Discard a bad extraction and correct the item manually."],
    limitations: ["AI extraction requires review before it should be treated as authoritative.", "Large files can take time to process."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.admin.enrichment",
    audience: "admin",
    workflow: "admin-enrichment",
    title: "Run inventory enrichment",
    summary: "Generate searchable keywords and expanded descriptions for unprocessed items.",
    body: "Admin enrichment fills missing searchable metadata in bulk so workers can find inventory using broader descriptions and attributes.",
    prerequisites: ["A current administrator session with MFA", "Inventory items that need enrichment"],
    steps: [
      "Open AI enrichment from Admin.",
      "Review the count of items eligible for processing.",
      "Start the enrichment job and monitor its status.",
      "Review the resulting keywords and descriptions where needed.",
    ],
    outcomes: ["Eligible inventory has additional searchable metadata.", "Existing manually maintained descriptions remain reviewable."],
    recovery: ["Retry a failed job after confirming the AI service is available.", "Edit an individual item when generated text needs correction."],
    limitations: ["Generated metadata is not a substitute for source documentation.", "Only items selected by the enrichment rules are processed."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.admin.inbox",
    audience: "admin",
    workflow: "admin-inbox",
    title: "Process support messages",
    summary: "Read worker messages sent through Ref and mark resolved conversations.",
    body: "The admin inbox receives messages submitted through the existing Contact flow. Administrators can review the message and mark it resolved.",
    prerequisites: ["A current administrator session with MFA", "A message submitted through Contact"],
    steps: [
      "Open the admin inbox.",
      "Read the message and its subject.",
      "Take the required support action outside this content workflow.",
      "Mark the message resolved when it is handled.",
    ],
    outcomes: ["The message's resolved state is updated for the admin inbox."],
    recovery: ["Leave the message unresolved when more work is required.", "Refresh the inbox if a status update is not visible."],
    limitations: ["The inbox does not replace warehouse or electrical safety procedures.", "Messages depend on the existing Contact submission flow."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
  {
    id: "help.admin.zone-editor",
    audience: "admin",
    workflow: "admin-zone-editor",
    title: "Maintain warehouse zones",
    summary: "Use the admin zone editor to draw, number, and correct warehouse zones.",
    body: "The zone editor changes the warehouse map's zone alignment and labels. Save only changes that match the current floor plan.",
    prerequisites: ["A current administrator session with MFA", "A verified warehouse floor plan"],
    steps: [
      "Open the zone editor from the Map admin tools.",
      "Draw or select the zone that needs attention.",
      "Set its number and alignment against the floor plan.",
      "Save the change and verify the zone on the Map tab.",
    ],
    outcomes: ["The saved zone geometry and label appear in the warehouse map."],
    recovery: ["Reopen the editor and correct the zone alignment.", "Remove an incorrect unsaved edit instead of saving it."],
    limitations: ["Zone edits affect how every user reads the warehouse map.", "Only administrators can change zone data."],
    revision: { contentVersion: HELP_CONTENT_VERSION, revisedAt: "2026-09-01", source: "verified-product-workflow" },
  },
];

export const ALL_HELP_RECORDS = Object.freeze([...GENERAL_HELP, ...ADMIN_HELP]) as ReadonlyArray<HelpRecord>;

const RECORD_KEYS = new Set([
  "id",
  "audience",
  "workflow",
  "title",
  "summary",
  "body",
  "prerequisites",
  "steps",
  "outcomes",
  "recovery",
  "limitations",
  "revision",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertText(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`Invalid Help ${name}`);
  }
}

function assertTextList(value: unknown, name: string): asserts value is Array<string> {
  if (!Array.isArray(value) || value.length === 0 || value.length > HELP_LIMITS.maxListItems) {
    throw new Error(`Invalid Help ${name}`);
  }
  for (const item of value) assertText(item, `${name} item`, HELP_LIMITS.maxListItemLength);
}

/**
 * Validate content at the serialization boundary. Keeping this runtime check
 * here means a future edit to the static corpus fails closed instead of
 * returning a partial or over-sized document.
 */
export function validateHelpRecords(records: ReadonlyArray<HelpRecord>): void {
  if (!Array.isArray(records) || records.length === 0 || records.length > HELP_LIMITS.maxRecords) {
    throw new Error("Invalid Help record collection");
  }

  const ids = new Set<string>();
  for (const record of records) {
    if (!isPlainObject(record)) throw new Error("Invalid Help record");
    for (const key of Object.keys(record)) {
      if (!RECORD_KEYS.has(key)) throw new Error("Invalid Help record field");
    }
    assertText(record.id, "id", HELP_LIMITS.maxIdLength);
    assertText(record.workflow, "workflow", HELP_LIMITS.maxWorkflowLength);
    assertText(record.title, "title", HELP_LIMITS.maxTitleLength);
    assertText(record.summary, "summary", HELP_LIMITS.maxSummaryLength);
    assertText(record.body, "body", HELP_LIMITS.maxBodyLength);
    if (record.audience !== "general" && record.audience !== "admin") throw new Error("Invalid Help audience");
    if (ids.has(record.id)) throw new Error("Duplicate Help record id");
    ids.add(record.id);

    assertTextList(record.prerequisites, "prerequisites");
    assertTextList(record.steps, "steps");
    assertTextList(record.outcomes, "outcomes");
    assertTextList(record.recovery, "recovery");
    assertTextList(record.limitations, "limitations");

    if (!isPlainObject(record.revision)) throw new Error("Invalid Help revision");
    assertText(record.revision.contentVersion, "revision contentVersion", 40);
    assertText(record.revision.revisedAt, "revision revisedAt", 40);
    if (record.revision.contentVersion !== HELP_CONTENT_VERSION || record.revision.source !== "verified-product-workflow") {
      throw new Error("Invalid Help revision metadata");
    }
    if (!Number.isFinite(Date.parse(record.revision.revisedAt))) throw new Error("Invalid Help revision date");
    if (JSON.stringify(record).length > HELP_LIMITS.maxRecordBytes) throw new Error("Help record is too large");
  }
}

const responseCache = new Map<string, HelpResponse>();

/**
 * Return a defensive response copy. The cache key includes both versions and
 * the audience, so an admin-populated response can never satisfy a general
 * request.
 */
export function getHelpResponse(audience: HelpAudience, workflow?: string): HelpResponse {
  if (audience !== "general" && audience !== "admin") throw new Error("Invalid Help audience");

  const cacheKey = `${HELP_SCHEMA_VERSION}:${HELP_CONTENT_VERSION}:${audience}`;
  let response = responseCache.get(cacheKey);
  if (!response) {
    validateHelpRecords(ALL_HELP_RECORDS);
    const records = ALL_HELP_RECORDS
      .filter((record) => record.audience === audience)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    response = Object.freeze({
      schemaVersion: HELP_SCHEMA_VERSION,
      contentVersion: HELP_CONTENT_VERSION,
      audience,
      records,
    });
    responseCache.set(cacheKey, response);
  }

  const selectedRecords = workflow
    ? response.records.filter((record) => record.workflow === workflow)
    : response.records;

  return JSON.parse(JSON.stringify({ ...response, records: selectedRecords })) as HelpResponse;
}
