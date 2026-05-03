/**
 * Upload + Inventory tab.
 *
 * Two responsibilities:
 *   1. Bulk-upload a parsed XLSX/CSV via chunked POSTs to /inventory/batch.
 *      Progress is persisted (`lib/uploadProgress`) so a backgrounded app or
 *      OS kill doesn't lose the worker's place mid-upload.
 *   2. Browse / per-item edit the resulting inventory (paginated FlatList,
 *      KeywordEditor inline edit).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as XLSX from "xlsx";
import { useListInventory } from "@workspace/api-client-react";
import {
  CHUNK_SIZE,
  chunkRows,
  clearUploadProgress,
  loadUploadProgress,
  saveUploadCheckpoint,
  saveUploadSeed,
  type InProgressUpload,
  type UploadSeed,
} from "../../lib/uploadProgress";

import { useColors } from "@/hooks/useColors";
import { ReferenceModal } from "@/components/ReferenceModal";
import { useApp } from "@/contexts/AppContext";
import type { InventoryItem } from "@workspace/api-client-react";
import { secondaryBtnBase } from "@/styles/shared";

const API_BASE =
  process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "";


// A single part as the upload UI sees it. `binLocations` is always an array;
// when there's only one bin the array has one entry, when the part appears in
// multiple bins (either two rows of the spreadsheet or one cell with several
// bins separated by `,` `;` `/` `\n`) the array carries every bin.
type ParsedRow = {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: string[];
};

// Bin-cell separators — must match BIN_CELL_SEPARATORS in the server's
// utils/binLocations.ts. Keep in sync.
const BIN_CELL_SEPARATORS = /[,;/\n\r]+/;

function splitBinCell(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(BIN_CELL_SEPARATORS)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function dedupeBinsCI(bins: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const b of bins) {
    const t = b.trim();
    if (!t) continue;
    const key = t.toUpperCase();
    if (!seen.has(key)) seen.set(key, t);
  }
  return Array.from(seen.values());
}

/**
 * Collapse two-rows-for-the-same-part into one. The first non-empty
 * description wins; bins from every row are appended and case-insensitively
 * de-duplicated. Vendor is upper-cased to match the unique-index semantics
 * on the server (UPPER(vendor), catalog).
 */
function aggregateRows(rows: readonly ParsedRow[]): ParsedRow[] {
  const byKey = new Map<string, ParsedRow>();
  for (const row of rows) {
    const vendor = row.vendor.trim().toUpperCase();
    const catalog = row.catalog.trim();
    if (!vendor || !catalog) continue;
    const key = `${vendor}|${catalog}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.binLocations = dedupeBinsCI([...existing.binLocations, ...row.binLocations]);
      if (!existing.description && row.description) {
        existing.description = row.description.trim();
      }
    } else {
      byKey.set(key, {
        vendor,
        catalog,
        description: row.description.trim(),
        binLocations: dedupeBinsCI(row.binLocations),
      });
    }
  }
  return Array.from(byKey.values());
}

// Preview classification of incoming rows against existing inventory.
// Mirrors PreviewUpsertResponse in the OpenAPI spec.
type PreviewMatchRow = {
  vendor: string;
  catalog: string;
  existingDescription: string;
  proposedDescription: string;
  existingBinLocations: string[];
  proposedBinLocations: string[];
  binChanged: boolean;
  descChanged: boolean;
};
type PreviewResponse = {
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  totalIncoming: number;
  changes: PreviewMatchRow[];
};
type UpsertMode = "add-new-only" | "overwrite-all" | "selected";
type UpsertResult = { inserted: number; updated: number; skipped: number; total: number };

type EnrichProgress = {
  progress: number;
  total: number;
  batchSize?: number;
  etaSeconds?: number | null;
  done?: boolean;
  error?: string;
  item?: { id: number; keywords: string[] };
};

type BulkJobStatus = {
  running: boolean;
  stopRequested: boolean;
  startedAt: string | null;
  processed: number;
  errors: number;
  total: number | null;
  finishedAt: string | null;
  lastError: string | null;
};

type MeasureJobStatus = {
  running: boolean;
  startedAt: string | null;
  processed: number;
  updated: number;
  total: number | null;
  finishedAt: string | null;
  lastError: string | null;
};

type EnrichSummary = {
  total: number;
  enriched: number;
  unenriched: number;
};

// ── Column header aliases ──────────────────────────────────────────────────
const VENDOR_ALIASES = ["vendor", "mfr", "manufacturer", "brand", "make", "supplier"];
const CATALOG_ALIASES = ["catalog", "catalog#", "cat#", "part", "part#", "partno", "item", "itemno", "sku", "model", "partnumber", "part number", "cat no", "catalog no"];
const DESC_ALIASES = ["description", "desc", "name", "product", "productname", "title", "item description"];
const BIN_ALIASES = ["bin", "bin location", "binlocation", "location", "loc", "shelf", "aisle", "bin#", "bin no"];

function findCol(headers: string[], aliases: string[]): number {
  return aliases.map(a => headers.indexOf(a)).find(i => i >= 0) ?? -1;
}

// ── Parse CSV text ─────────────────────────────────────────────────────────
//
// Records are tokenised with full RFC-4180 quote handling so that a quoted
// bin cell like "A-1\nB-2" survives parsing — splitting on bare `\r?\n`
// before quotes are honoured would silently drop bins after the first newline.
function parseCSV(text: string): ParsedRow[] {
  const records = parseCSVRecords(text);
  if (records.length < 2) return [];

  const headers = records[0]!.map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
  const vendorCol = findCol(headers, VENDOR_ALIASES);
  const catalogCol = findCol(headers, CATALOG_ALIASES);
  const descCol = findCol(headers, DESC_ALIASES);
  const binCol = findCol(headers, BIN_ALIASES);

  const rows: ParsedRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const cells = records[i]!;
    const vendor = vendorCol >= 0 ? cells[vendorCol]?.trim() ?? "" : "";
    const catalog = catalogCol >= 0 ? cells[catalogCol]?.trim() ?? "" : "";
    if (!vendor && !catalog) continue;
    // Don't trim the bin cell here — splitBinCell trims each token after
    // splitting so embedded newline separators are preserved.
    const binCell = binCol >= 0 ? cells[binCol] ?? "" : "";
    rows.push({
      vendor: vendor || "UNKNOWN",
      catalog: catalog || "UNKNOWN",
      description: descCol >= 0 ? cells[descCol]?.trim() ?? "" : "",
      binLocations: splitBinCell(binCell),
    });
  }
  // Collapse duplicate (vendor, catalog) rows so two rows for the same part
  // merge their bins instead of the second one losing.
  return aggregateRows(rows);
}

/**
 * Tokenise a full CSV document into records. Honours RFC-4180 quoting rules:
 * `""` is an escaped quote, and a quoted field may contain commas, `\r`, and
 * `\n` literally. Blank lines are skipped.
 */
function parseCSVRecords(text: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => { current.push(field); field = ""; };
  const pushRecord = () => {
    pushField();
    const isBlank = current.length === 1 && current[0]!.trim() === "";
    if (!isBlank) records.push(current);
    current = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\r") {
      // swallow; the following \n triggers the record boundary
    } else if (ch === "\n") {
      pushRecord();
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || current.length > 0) pushRecord();
  return records;
}

// ── Parse xlsx/xls/ods via SheetJS ────────────────────────────────────────
async function parseXlsx(uri: string): Promise<ParsedRow[]> {
  const response = await fetch(uri);
  const arrayBuffer = await response.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  const workbook = XLSX.read(uint8, { type: "array" });

  // Find the sheet with a Vendor or Catalog column
  let bestSheet: XLSX.WorkSheet | null = null;
  let bestScore = -1;
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as string[][];
    if (!rows[0]) continue;
    const headers = rows[0].map(h => String(h).trim().toLowerCase());
    let score = 0;
    if (VENDOR_ALIASES.some(a => headers.includes(a))) score += 2;
    if (CATALOG_ALIASES.some(a => headers.includes(a))) score += 2;
    if (score > bestScore) { bestScore = score; bestSheet = ws; }
  }

  if (!bestSheet) {
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]!];
    if (!firstSheet) return [];
    bestSheet = firstSheet;
  }

  const rawRows: string[][] = XLSX.utils.sheet_to_json(bestSheet, { header: 1, defval: "" }) as string[][];
  if (rawRows.length < 2) return [];

  const headers = rawRows[0]!.map(h => String(h).trim().toLowerCase());
  const vendorCol = findCol(headers, VENDOR_ALIASES);
  const catalogCol = findCol(headers, CATALOG_ALIASES);
  const descCol = findCol(headers, DESC_ALIASES);
  const binCol = findCol(headers, BIN_ALIASES);

  const rows: ParsedRow[] = [];
  for (let i = 1; i < rawRows.length; i++) {
    const cells = rawRows[i]!.map(c => String(c ?? "").trim());
    const vendor = vendorCol >= 0 ? cells[vendorCol] ?? "" : "";
    const catalog = catalogCol >= 0 ? cells[catalogCol] ?? "" : "";
    if (!vendor && !catalog) continue;
    const binCell = binCol >= 0 ? cells[binCol] ?? "" : "";
    rows.push({
      vendor: vendor || "UNKNOWN",
      catalog: catalog || "UNKNOWN",
      description: descCol >= 0 ? cells[descCol] ?? "" : "",
      binLocations: splitBinCell(binCell),
    });
  }
  // Collapse duplicate (vendor, catalog) rows so two rows for the same part
  // merge their bins instead of the second one losing.
  return aggregateRows(rows);
}

// ── Inventory row component ───────────────────────────────────────────────
function InventoryRow({ item, colors }: { item: InventoryItem; colors: ReturnType<typeof useColors> }) {
  const isEnriched = !!item.enrichedAt;
  return (
    <View style={[rowStyles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={rowStyles.left}>
        <Text style={[rowStyles.catalog, { color: colors.foreground }]}>{item.catalog}</Text>
        <Text style={[rowStyles.vendor, { color: colors.mutedForeground }]}>{item.vendor}</Text>
        {item.description ? (
          <Text style={[rowStyles.desc, { color: colors.mutedForeground }]} numberOfLines={1}>
            {item.description}
          </Text>
        ) : null}
      </View>
      <View style={rowStyles.right}>
        {(item.binLocations ?? []).length > 0 ? (
          <Text
            style={[rowStyles.bin, { color: colors.primary }]}
            numberOfLines={2}
          >
            {(item.binLocations ?? []).join(", ")}
          </Text>
        ) : null}
        <View style={[rowStyles.enrichBadge, { backgroundColor: isEnriched ? colors.success + "22" : colors.muted }]}>
          <Text style={[rowStyles.enrichText, { color: isEnriched ? colors.success : colors.mutedForeground }]}>
            {isEnriched ? "✓ AI" : "—"}
          </Text>
        </View>
      </View>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  left: { flex: 1 },
  right: { alignItems: "flex-end", gap: 4 },
  catalog: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  vendor: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  desc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  bin: { fontSize: 12, fontFamily: "Inter_600SemiBold", textAlign: "right", maxWidth: 120 },
  enrichBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4 },
  enrichText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
});

// ── Admin gate component ──────────────────────────────────────────────────
function AdminGate({ colors }: { colors: ReturnType<typeof useColors> }) {
  const { loginAdmin } = useApp();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setError(null);
    setLoading(true);
    const result = await loginAdmin(password);
    setLoading(false);
    if (!result.success) {
      setError(result.error ?? "Incorrect admin password");
      setPassword("");
    }
  };

  return (
    <View style={[gateStyles.container, { backgroundColor: colors.background }]}>
      <View style={[gateStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[gateStyles.icon]}>🔒</Text>
        <Text style={[gateStyles.title, { color: colors.foreground }]}>Admin Access Required</Text>
        <Text style={[gateStyles.hint, { color: colors.mutedForeground }]}>
          Inventory import is restricted to administrators. Enter the admin password to continue.
        </Text>

        <TextInput
          style={[gateStyles.input, { backgroundColor: colors.muted, color: colors.foreground, borderColor: error ? colors.destructive : colors.border }]}
          placeholder="Admin password"
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={handleLogin}
          returnKeyType="done"
          autoCapitalize="none"
          autoCorrect={false}
        />

        {error ? (
          <Text style={[gateStyles.error, { color: colors.destructive }]}>{error}</Text>
        ) : null}

        <Pressable
          onPress={handleLogin}
          disabled={loading || !password}
          style={[gateStyles.btn, { backgroundColor: loading || !password ? colors.muted : colors.primary }]}
        >
          {loading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={[gateStyles.btnText, { color: colors.primaryForeground }]}>Unlock</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const gateStyles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 380, borderRadius: 16, padding: 28, borderWidth: 1, alignItems: "center", gap: 14 },
  icon: { fontSize: 40 },
  title: { fontSize: 20, fontFamily: "Inter_700Bold", textAlign: "center" },
  hint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  input: { width: "100%", borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, fontFamily: "Inter_400Regular" },
  error: { fontSize: 13, fontFamily: "Inter_500Medium", textAlign: "center" },
  btn: { width: "100%", borderRadius: 8, paddingVertical: 14, alignItems: "center" },
  btnText: { fontSize: 16, fontFamily: "Inter_700Bold" },
});

// ── Main screen ───────────────────────────────────────────────────────────
export default function UploadScreen() {
  const colors = useColors();
  const { isAdmin, logoutAdmin, adminToken } = useApp();
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileType, setFileType] = useState<"csv" | "xlsx" | null>(null);
  const [enrichProgress, setEnrichProgress] = useState<EnrichProgress | null>(null);
  const [tab, setTab] = useState<"upload" | "inventory">("upload");
  const [uploadSuccess, setUploadSuccess] = useState<UpsertResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [inventoryPage, setInventoryPage] = useState(1);

  // ── Chunked / pausable / resumable upload state ──────────────────────────
  // The upload screen sends the parsed rows to /inventory/upsert-batch in
  // fixed-size chunks. After every successful chunk we persist progress to
  // AsyncStorage so the user can pause mid-run or resume after an app crash.
  // The server is idempotent for the modes we use, so re-sending a chunk is
  // safe.
  const [chunkProgress, setChunkProgress] = useState<{
    processed: number;
    total: number;
    inserted: number;
    updated: number;
    skipped: number;
  } | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const pauseRef = useRef(false);
  // Monotonic id for the current run. Bumped on every start, pause-after,
  // resume, or cancel. After every awaited fetch we compare runIdRef.current
  // against the captured myRunId; on mismatch the run aborts without
  // touching state or storage. This prevents a stale loop from clobbering
  // user intent (e.g. cancel) or running concurrently with a fresh start.
  const runIdRef = useRef(0);
  // AbortController for the in-flight fetch — cancel hits the network too,
  // not just the loop between chunks.
  const abortControllerRef = useRef<AbortController | null>(null);
  // Banner shown on mount when an old upload was left half-finished by a
  // previous session (e.g. the app was killed). null = nothing to resume.
  const [resumePrompt, setResumePrompt] = useState<InProgressUpload | null>(null);
  // Refs that mirror state we need to read inside the auto-resume effect
  // without causing it to re-run.
  const parsedRowsRef = useRef(parsedRows);
  useEffect(() => { parsedRowsRef.current = parsedRows; }, [parsedRows]);
  const chunkProgressRef = useRef<typeof chunkProgress>(null);
  useEffect(() => { chunkProgressRef.current = chunkProgress; }, [chunkProgress]);

  // ── Preview / review modal state ─────────────────────────────────────────
  // After parsing, we POST rows to /preview-upsert. If any existing rows would
  // change, we surface a 3-option chooser (add-new / overwrite-all / review).
  // "Review" expands `previewData.changes` into a per-row include/exclude list.
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null);
  const [chooserVisible, setChooserVisible] = useState(false);
  const [reviewVisible, setReviewVisible] = useState(false);
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const previewKey = useCallback(
    (vendor: string, catalog: string) => `${vendor.trim().toUpperCase()}|${catalog.trim().toUpperCase()}`,
    [],
  );

  // ── Catalog PDF enrichment state ─────────────────────────────────────────
  // Worker uploads a vendor catalog PDF (e.g. Bridgeport Fittings 2026); the
  // server parses the index, fuzzy-matches every catalog number against
  // existing inventory rows, and returns a tiered report. Exact + high-
  // confidence rows auto-apply; uncertain rows surface a per-row review modal
  // so the worker picks the right inventory candidate (or skips).
  type CatalogTier = "exact" | "highConfidence" | "uncertain" | "unmatched";
  type CatalogReportRow = {
    catalogNumber: string;
    pageNumbers: number[];
    description: string;
    dimensions: Record<string, string>;
    keywords: string[];
    tier: CatalogTier;
    candidates: Array<{
      inventoryId: number;
      vendor: string;
      catalog: string;
      description: string;
      distance: number;
      reason: string;
    }>;
  };
  type CatalogReport = {
    vendor: string;
    summary: { exact: number; highConfidence: number; uncertain: number; unmatched: number; total: number };
    rows: CatalogReportRow[];
  };
  type CatalogApplyResult = { runId: number | null; updated: number; skippedNoOp: number; errors: Array<{ inventoryId: number; error: string }> };
  type CatalogRun = {
    id: number;
    vendor: string;
    sourceFilename: string | null;
    startedAt: string;
    finishedAt: string | null;
    updatedCount: number;
    skippedCount: number;
    errorCount: number;
    revertedAt: string | null;
  };

  const [catalogPdfFileName, setCatalogPdfFileName] = useState<string | null>(null);
  type CatalogVendorOption = { vendor: string; displayName: string; sourceCatalog: string };
  const [catalogVendorOptions, setCatalogVendorOptions] = useState<CatalogVendorOption[]>([]);
  const [catalogPdfVendor, setCatalogPdfVendor] = useState<string>("BRIDGEPORT");
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false);
  const [catalogPdfPending, setCatalogPdfPending] = useState(false);
  const [catalogPdfError, setCatalogPdfError] = useState<string | null>(null);
  const [catalogReport, setCatalogReport] = useState<CatalogReport | null>(null);
  const [catalogApplyResult, setCatalogApplyResult] = useState<CatalogApplyResult | null>(null);
  const [catalogReviewVisible, setCatalogReviewVisible] = useState(false);
  // Per-uncertain-row decision: chosen inventoryId, or "skip".
  const [catalogReviewChoices, setCatalogReviewChoices] = useState<Record<string, number | "skip">>({});
  // Recent enrichment runs + per-row revert pending state.
  const [catalogRuns, setCatalogRuns] = useState<CatalogRun[]>([]);
  const [revertingRunId, setRevertingRunId] = useState<number | null>(null);

  // Bulk enrichment state
  const [bulkJobStatus, setBulkJobStatus] = useState<BulkJobStatus | null>(null);
  const [enrichSummary, setEnrichSummary] = useState<EnrichSummary | null>(null);
  const [bulkEnrichError, setBulkEnrichError] = useState<string | null>(null);
  const [bulkEnrichPending, setBulkEnrichPending] = useState(false);
  const [bulkStopPending, setBulkStopPending] = useState(false);

  // Measurement enrichment state
  const [measureJobStatus, setMeasureJobStatus] = useState<MeasureJobStatus | null>(null);
  const [measureEnrichError, setMeasureEnrichError] = useState<string | null>(null);
  const [measureEnrichPending, setMeasureEnrichPending] = useState(false);

  const inventoryQuery = useListInventory({ page: inventoryPage, limit: 50 });

  // Build admin auth headers for protected API calls
  const adminHeaders: Record<string, string> = adminToken
    ? { "Authorization": `Bearer ${adminToken}` }
    : {};

  // Keep a ref so interval callbacks always see the current token
  const adminTokenRef = useRef(adminToken);
  useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);

  const bulkPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const measurePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopBulkPoll = useCallback(() => {
    if (bulkPollRef.current !== null) {
      clearInterval(bulkPollRef.current);
      bulkPollRef.current = null;
    }
  }, []);

  const stopMeasurePoll = useCallback(() => {
    if (measurePollRef.current !== null) {
      clearInterval(measurePollRef.current);
      measurePollRef.current = null;
    }
  }, []);

  const fetchEnrichSummary = useCallback(async () => {
    try {
      const token = adminTokenRef.current;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${API_BASE}/inventory/enrich-summary`, { headers });
      if (res.status === 401) {
        logoutAdmin();
        setUploadError("Admin session expired. Please unlock again.");
        return;
      }
      if (!res.ok) return;
      const data = await res.json() as EnrichSummary;
      setEnrichSummary(data);
    } catch {}
  }, [logoutAdmin]);

  const pollBulkStatus = useCallback(async () => {
    try {
      const token = adminTokenRef.current;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${API_BASE}/inventory/bulk-enrich/status`, { headers });
      if (res.status === 401) {
        stopBulkPoll();
        logoutAdmin();
        setUploadError("Admin session expired. Please unlock again.");
        return;
      }
      if (!res.ok) return;
      const data = await res.json() as BulkJobStatus;
      setBulkJobStatus(data);
      if (data.running) {
        void fetchEnrichSummary();
      } else {
        stopBulkPoll();
        void fetchEnrichSummary();
      }
    } catch {}
  }, [stopBulkPoll, fetchEnrichSummary, logoutAdmin]);

  const startBulkPoll = useCallback(() => {
    stopBulkPoll();
    // Fire an immediate fetch so the UI responds before the first 2s tick
    void pollBulkStatus();
    bulkPollRef.current = setInterval(pollBulkStatus, 2000);
  }, [stopBulkPoll, pollBulkStatus]);

  const pollMeasureStatus = useCallback(async () => {
    try {
      const token = adminTokenRef.current;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${API_BASE}/inventory/enrich-measurements/status`, { headers });
      if (res.status === 401) {
        stopMeasurePoll();
        logoutAdmin();
        setUploadError("Admin session expired. Please unlock again.");
        return;
      }
      if (!res.ok) return;
      const data = await res.json() as MeasureJobStatus;
      setMeasureJobStatus(data);
      if (data.running) {
        void fetchEnrichSummary();
      } else {
        stopMeasurePoll();
        void fetchEnrichSummary();
      }
    } catch {}
  }, [stopMeasurePoll, fetchEnrichSummary, logoutAdmin]);

  const startMeasurePoll = useCallback(() => {
    stopMeasurePoll();
    void pollMeasureStatus();
    measurePollRef.current = setInterval(pollMeasureStatus, 2000);
  }, [stopMeasurePoll, pollMeasureStatus]);

  // On admin login, load coverage summary and check if jobs are already running.
  // On admin logout (isAdmin → false), stop any active polling immediately.
  useEffect(() => {
    if (!isAdmin) {
      stopBulkPoll();
      stopMeasurePoll();
      return;
    }
    fetchEnrichSummary();
    (async () => {
      try {
        const token = adminTokenRef.current;
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const [bulkRes, measureRes] = await Promise.all([
          fetch(`${API_BASE}/inventory/bulk-enrich/status`, { headers }),
          fetch(`${API_BASE}/inventory/enrich-measurements/status`, { headers }),
        ]);
        if (bulkRes.status === 401 || measureRes.status === 401) {
          logoutAdmin();
          setUploadError("Admin session expired. Please unlock again.");
          return;
        }
        if (bulkRes.ok) {
          const data = await bulkRes.json() as BulkJobStatus;
          setBulkJobStatus(data);
          if (data.running) startBulkPoll();
        }
        if (measureRes.ok) {
          const data = await measureRes.json() as MeasureJobStatus;
          setMeasureJobStatus(data);
          if (data.running) startMeasurePoll();
        }
      } catch {}
    })();
  }, [isAdmin, fetchEnrichSummary, startBulkPoll, stopBulkPoll, startMeasurePoll, stopMeasurePoll, logoutAdmin]);

  // Clean up polling on unmount
  useEffect(() => () => { stopBulkPoll(); stopMeasurePoll(); }, [stopBulkPoll, stopMeasurePoll]);

  // Fetch the supported catalog vendors so the picker shows real options.
  // Falls back to a Bridgeport-only list if the call fails (older server).
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/catalog-pdf/vendors`, { headers: adminHeaders });
        if (!res.ok) return;
        const body = await res.json() as { vendors: CatalogVendorOption[] };
        if (cancelled || !Array.isArray(body.vendors) || body.vendors.length === 0) return;
        setCatalogVendorOptions(body.vendors);
        setCatalogPdfVendor(prev => body.vendors.some(v => v.vendor === prev) ? prev : body.vendors[0]!.vendor);
      } catch {
        /* picker keeps default Bridgeport entry */
      }
    })();
    return () => { cancelled = true; };
    // adminHeaders is recomputed every render but the underlying token is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, adminToken]);

  const handleStartBulkEnrich = async () => {
    setBulkEnrichError(null);
    setBulkEnrichPending(true);
    try {
      const res = await fetch(`${API_BASE}/inventory/bulk-enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
      });
      if (res.status === 409) {
        const data = await res.json() as { job: BulkJobStatus };
        setBulkJobStatus(data.job);
        startBulkPoll();
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setBulkEnrichError(err.error ?? "Failed to start bulk enrichment");
        return;
      }
      const data = await res.json() as { job: BulkJobStatus };
      setBulkJobStatus(data.job);
      startBulkPoll();
    } catch {
      setBulkEnrichError("Failed to start bulk enrichment. Check your connection and try again.");
    } finally {
      setBulkEnrichPending(false);
    }
  };

  const handleStopBulkEnrich = async () => {
    setBulkStopPending(true);
    try {
      const res = await fetch(`${API_BASE}/inventory/bulk-enrich`, {
        method: "DELETE",
        headers: { ...adminHeaders },
      });
      if (res.ok) {
        const data = await res.json() as { job: BulkJobStatus };
        setBulkJobStatus(data.job);
      }
    } catch {
      // silently ignore — polling will detect the stopped state shortly
    } finally {
      setBulkStopPending(false);
    }
  };

  const handleStartMeasureEnrich = async () => {
    setMeasureEnrichError(null);
    setMeasureEnrichPending(true);
    try {
      const res = await fetch(`${API_BASE}/inventory/enrich-measurements`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
      });
      if (res.status === 409) {
        const data = await res.json() as { job: MeasureJobStatus };
        setMeasureJobStatus(data.job);
        startMeasurePoll();
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setMeasureEnrichError(err.error ?? "Failed to start measurement enrichment");
        return;
      }
      const data = await res.json() as { job: MeasureJobStatus };
      setMeasureJobStatus(data.job);
      startMeasurePoll();
    } catch {
      setMeasureEnrichError("Failed to start measurement enrichment. Check your connection and try again.");
    } finally {
      setMeasureEnrichPending(false);
    }
  };

  // ── Catalog PDF handlers ─────────────────────────────────────────────────
  // Forward the preview report + uncertain picks to the server. The server
  // itself auto-applies every exact + highConfidence row and applies the
  // worker's choice for each uncertain row, so the client just relays.
  // `sourceFilename` is passed in EXPLICITLY (not read from state) because
  // `handleCatalogPdfPick` calls this immediately after `setCatalogPdfFileName`,
  // and that state update isn't visible to closures captured from the same
  // render. Forwarding the name as an argument guarantees we record the file
  // the worker actually picked, not whatever the previous render had.
  const applyCatalogDecisions = useCallback(async (
    report: CatalogReport,
    uncertainPicks: Record<string, number | "skip">,
    sourceFilename: string | null,
  ): Promise<CatalogApplyResult | null> => {
    try {
      const res = await fetch(`${API_BASE}/admin/catalog-pdf/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({
          report,
          uncertainDecisions: uncertainPicks,
          sourceFilename,
        }),
      });
      if (res.status === 401) {
        logoutAdmin();
        setCatalogPdfError("Admin session expired. Please unlock again.");
        return null;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setCatalogPdfError(err.error ?? "Failed to apply catalog updates.");
        return null;
      }
      return (await res.json()) as CatalogApplyResult;
    } catch {
      setCatalogPdfError("Network error while applying catalog updates.");
      return null;
    }
    // adminHeaders is recomputed every render; the underlying token is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, logoutAdmin]);

  // Fetch the most recent catalog-PDF apply runs so the worker can revert
  // any of them. The list reloads after every successful apply or revert.
  const fetchCatalogRuns = useCallback(async () => {
    try {
      const token = adminTokenRef.current;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${API_BASE}/admin/catalog-pdf/runs?limit=20`, { headers });
      if (!res.ok) return;
      const body = await res.json() as { runs: CatalogRun[] };
      if (Array.isArray(body.runs)) setCatalogRuns(body.runs);
    } catch {
      /* silent — UI just won't show the section */
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) { setCatalogRuns([]); return; }
    void fetchCatalogRuns();
  }, [isAdmin, fetchCatalogRuns]);

  const handleRevertRun = useCallback(async (runId: number) => {
    setRevertingRunId(runId);
    setCatalogPdfError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/catalog-pdf/runs/${runId}/revert`, {
        method: "POST",
        headers: { ...adminHeaders },
      });
      if (res.status === 401) {
        logoutAdmin();
        setCatalogPdfError("Admin session expired. Please unlock again.");
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setCatalogPdfError(err.error ?? "Failed to revert this run.");
        return;
      }
      await fetchCatalogRuns();
      void inventoryQuery.refetch();
      void fetchEnrichSummary();
    } catch {
      setCatalogPdfError("Network error while reverting this run.");
    } finally {
      setRevertingRunId(null);
    }
    // adminHeaders is recomputed every render; the underlying token is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, fetchCatalogRuns, fetchEnrichSummary, inventoryQuery, logoutAdmin]);

  const handleCatalogPdfPick = async () => {
    setCatalogPdfError(null);
    setCatalogReport(null);
    setCatalogApplyResult(null);
    setCatalogReviewChoices({});
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf"],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setCatalogPdfFileName(asset.name);
      setCatalogPdfPending(true);

      // Multipart upload: `file` field carries the PDF, `vendor` field carries
      // the vendor name. RN's FormData accepts a { uri, name, type } object
      // for file fields and streams the file directly without loading it into
      // memory as a blob.
      const form = new FormData();
      form.append("vendor", catalogPdfVendor);
      form.append("file", {
        // RN-specific FormData file shape; cast for TS.
        uri: asset.uri,
        name: asset.name || "catalog.pdf",
        type: "application/pdf",
      } as unknown as Blob);

      const previewUrl = `${API_BASE}/admin/catalog-pdf/preview`;
      const res = await fetch(previewUrl, {
        method: "POST",
        // Do NOT set Content-Type — RN sets the multipart boundary itself.
        headers: { ...adminHeaders },
        body: form,
      });
      if (res.status === 401) {
        logoutAdmin();
        setCatalogPdfError("Admin session expired. Please unlock again.");
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setCatalogPdfError(err.error ?? "Failed to parse the catalog PDF.");
        return;
      }
      const report = (await res.json()) as CatalogReport;
      setCatalogReport(report);

      // Auto-apply exact + high-confidence rows immediately. Uncertain rows
      // wait for the worker to open the review modal. Pass `asset.name`
      // directly so the just-set state isn't relied on.
      const applied = await applyCatalogDecisions(report, {}, asset.name ?? null);
      if (applied) {
        setCatalogApplyResult(applied);
        void fetchCatalogRuns();
      }
    } catch (err) {
      setCatalogPdfError(err instanceof Error ? err.message : "Could not process the catalog PDF.");
    } finally {
      setCatalogPdfPending(false);
    }
  };

  const handleCatalogReviewApply = async () => {
    if (!catalogReport) return;
    setCatalogPdfPending(true);
    setCatalogPdfError(null);
    try {
      // Build a decisions list that includes ONLY the uncertain picks (the
      // exact + highConfidence rows were already auto-applied on preview).
      const uncertainOnly: CatalogReport = {
        ...catalogReport,
        rows: catalogReport.rows.filter(r => r.tier === "uncertain"),
      };
      const applied = await applyCatalogDecisions(uncertainOnly, catalogReviewChoices, catalogPdfFileName);
      if (applied) {
        const prev = catalogApplyResult ?? { runId: null, updated: 0, skippedNoOp: 0, errors: [] };
        setCatalogApplyResult({
          runId: applied.runId ?? prev.runId,
          updated: prev.updated + applied.updated,
          skippedNoOp: prev.skippedNoOp + applied.skippedNoOp,
          errors: [...prev.errors, ...applied.errors],
        });
        setCatalogReviewVisible(false);
        void fetchCatalogRuns();
      }
    } finally {
      setCatalogPdfPending(false);
    }
  };

  const handlePickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "text/csv",
          "text/comma-separated-values",
          "text/plain",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.oasis.opendocument.spreadsheet",
          "application/octet-stream",
          "*/*",
        ],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setFileName(asset.name);

      const ext = asset.name.split(".").pop()?.toLowerCase() ?? "";
      let rows: ParsedRow[] = [];

      if (ext === "csv" || ext === "txt") {
        const response = await fetch(asset.uri);
        if (!response.ok) throw new Error(`Failed to read file: ${response.status}`);
        const text = await response.text();
        rows = parseCSV(text);
        setFileType("csv");
      } else if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) {
        rows = await parseXlsx(asset.uri);
        setFileType("xlsx");
      } else {
        try {
          const response = await fetch(asset.uri);
          if (!response.ok) throw new Error(`Failed to read file: ${response.status}`);
          const text = await response.text();
          rows = parseCSV(text);
          setFileType("csv");
        } catch {
          rows = await parseXlsx(asset.uri);
          setFileType("xlsx");
        }
      }

      if (rows.length === 0) {
        setUploadError("No data rows found. Ensure your file has columns named: vendor, catalog (required), description, bin (optional).");
        return;
      }
      setUploadError(null);
      setUploadSuccess(null);
      setParsedRows(rows);
    } catch (err) {
      setUploadError("Failed to read file. Please try again.");
    }
  };

  // ── Chunked upload runner ────────────────────────────────────────────────
  // Sends rows in fixed-size chunks (CHUNK_SIZE) so the user can pause
  // between chunks and we can persist progress for crash recovery. The
  // server's /inventory/upsert-batch is idempotent for the modes we use, so
  // a re-sent chunk after an error or app kill is safe.
  //
  // Concurrency model:
  //   * Every entry to this function bumps runIdRef.current and aborts any
  //     prior in-flight controller. The new run captures myRunId at start.
  //   * After every awaited operation, we re-check runIdRef.current ===
  //     myRunId. On mismatch the run silently exits without writing state
  //     or storage. This guarantees that a fresh start, resume, or cancel
  //     fully supersedes any older loop, even if its fetch was mid-flight.
  const runChunkedUpload = useCallback(
    async (initial: InProgressUpload) => {
      // Supersede any previous run.
      const myRunId = ++runIdRef.current;
      abortControllerRef.current?.abort();
      const ctrl = new AbortController();
      abortControllerRef.current = ctrl;

      pauseRef.current = false;
      setIsPaused(false);
      setUploadError(null);
      setUploadSuccess(null);
      setUploadPending(true);

      // Local mutable state — single source of truth during the run.
      let processedIndex = initial.processedIndex;
      let totals = { ...initial.totals };
      const total = initial.parsedRows.length;
      setChunkProgress({ processed: processedIndex, total, ...totals });

      const chunks = chunkRows(initial.parsedRows.slice(processedIndex), CHUNK_SIZE);

      const isCurrent = () => runIdRef.current === myRunId;

      try {
        for (const chunk of chunks) {
          if (!isCurrent()) return;
          if (pauseRef.current) {
            setUploadPending(false);
            setIsPaused(true);
            return;
          }

          const body: {
            items: typeof chunk;
            mode: UpsertMode;
            selectedKeys?: Array<{ vendor: string; catalog: string }>;
          } = { items: chunk, mode: initial.mode };
          if (initial.mode === "selected" && initial.selectedKeys) {
            body.selectedKeys = initial.selectedKeys;
          }

          let response: Response;
          try {
            response = await fetch(`${API_BASE}/inventory/upsert-batch`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...adminHeaders },
              body: JSON.stringify(body),
              signal: ctrl.signal,
            });
          } catch (err) {
            // Aborted (cancel) or network blip. If a newer run took over,
            // exit silently. Otherwise keep state so user can Resume.
            if (!isCurrent()) return;
            const aborted =
              err instanceof Error && (err.name === "AbortError" || ctrl.signal.aborted);
            if (aborted) return;
            setUploadError(
              "Network error mid-upload — your progress was saved. Tap Resume to continue.",
            );
            setIsPaused(true);
            setUploadPending(false);
            return;
          }
          if (!isCurrent()) return;

          if (!response.ok) {
            const errBody = (await response.json().catch(() => ({}))) as { error?: string };
            if (!isCurrent()) return;
            if (response.status === 401) {
              // Auth gone — clear progress; the user can restart after re-unlock.
              await clearUploadProgress();
              if (!isCurrent()) return;
              logoutAdmin();
              setUploadError("Admin session expired. Please unlock again.");
              setChunkProgress(null);
              setUploadPending(false);
              return;
            }
            // Keep persisted state so the user can Resume after fixing the issue.
            setUploadError(
              errBody.error ?? "Upload failed mid-run — your progress was saved. Tap Resume to continue.",
            );
            setIsPaused(true);
            setUploadPending(false);
            return;
          }

          const partial = (await response.json()) as UpsertResult;
          if (!isCurrent()) return;
          totals = {
            inserted: totals.inserted + partial.inserted,
            updated: totals.updated + partial.updated,
            skipped: totals.skipped + partial.skipped,
          };
          processedIndex += chunk.length;

          // Persist a tiny checkpoint (no parsedRows) for crash recovery.
          await saveUploadCheckpoint({ processedIndex, totals });
          if (!isCurrent()) return;
          setChunkProgress({ processed: processedIndex, total, ...totals });
        }

        // All chunks done — clear progress and surface the success banner.
        if (!isCurrent()) return;
        await clearUploadProgress();
        if (!isCurrent()) return;
        setUploadSuccess({ ...totals, total });
        setChunkProgress(null);
        setParsedRows([]);
        setFileName(null);
        setFileType(null);
        setPreviewData(null);
        setExcludedKeys(new Set());
        await inventoryQuery.refetch();
      } finally {
        if (isCurrent()) setUploadPending(false);
      }
    },
    [adminHeaders, logoutAdmin, inventoryQuery],
  );

  // Apply step — kicks off a chunked upload from row 0. Writes the static
  // seed (rows + metadata + 0 checkpoint) once before the first chunk so a
  // mid-first-chunk crash is recoverable.
  const applyUpsert = useCallback(
    async (mode: UpsertMode, selectedKeys?: Array<{ vendor: string; catalog: string }>) => {
      if (!parsedRows.length) return;
      const seed: UploadSeed = {
        fileName,
        fileType,
        parsedRows,
        mode,
        selectedKeys: mode === "selected" ? selectedKeys : undefined,
        startedAt: Date.now(),
      };
      await saveUploadSeed(seed);
      await runChunkedUpload({
        ...seed,
        processedIndex: 0,
        totals: { inserted: 0, updated: 0, skipped: 0 },
      });
    },
    [parsedRows, fileName, fileType, runChunkedUpload],
  );

  // Pause: flip the ref so the in-flight loop exits between chunks. We do
  // NOT bump runIdRef here — we want the in-flight chunk to finish and
  // persist its checkpoint before the loop exits.
  const handlePauseUpload = useCallback(() => {
    pauseRef.current = true;
  }, []);

  // Resume: re-read the persisted checkpoint and continue from there.
  const handleResumeUpload = useCallback(async () => {
    const saved = await loadUploadProgress();
    if (!saved) {
      setIsPaused(false);
      setChunkProgress(null);
      return;
    }
    await runChunkedUpload(saved);
  }, [runChunkedUpload]);

  // Cancel: authoritative — abort the in-flight fetch, supersede the run,
  // wipe persisted state, reset UI. Any zombie loop will detect the
  // superseded runId and exit without writing anything.
  const handleCancelUpload = useCallback(async () => {
    runIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    pauseRef.current = false;
    await clearUploadProgress();
    setChunkProgress(null);
    setIsPaused(false);
    setUploadPending(false);
    setUploadError(null);
    setResumePrompt(null);
  }, []);

  // ── Auto-resume detection on mount ───────────────────────────────────────
  // If we find a persisted upload from a previous session AND the user is
  // an admin AND nothing is currently loaded or in-flight, surface the
  // banner. We read parsedRows / chunkProgress through refs so the effect
  // doesn't fight a freshly-started upload that began between mount and the
  // load promise resolving.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await loadUploadProgress();
      if (cancelled) return;
      if (
        saved &&
        isAdmin &&
        parsedRowsRef.current.length === 0 &&
        chunkProgressRef.current === null
      ) {
        setResumePrompt(saved);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally only on mount + when admin status changes; current
    // state is read through refs above to avoid stale-closure races.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // Resume from the banner prompt — same as Resume during a paused run.
  const handleResumeFromBanner = useCallback(async () => {
    if (!resumePrompt) return;
    const saved = resumePrompt;
    setResumePrompt(null);
    // Rehydrate the visible "what's being uploaded" labels.
    setFileName(saved.fileName);
    setFileType(saved.fileType);
    setTab("upload");
    await runChunkedUpload(saved);
  }, [resumePrompt, runChunkedUpload]);

  // Discard from the banner prompt — drop persisted state, dismiss banner.
  const handleDiscardFromBanner = useCallback(async () => {
    await clearUploadProgress();
    setResumePrompt(null);
  }, []);

  // Start step — first calls /inventory/preview-upsert. If existing rows would
  // change, surfaces the 3-option chooser. Otherwise applies overwrite-all
  // immediately (which is functionally identical when nothing differs).
  const handleUploadStart = async () => {
    if (!parsedRows.length) return;
    setUploadError(null);
    setUploadSuccess(null);
    setUploadPending(true);
    try {
      const response = await fetch(`${API_BASE}/inventory/preview-upsert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({ items: parsedRows }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({})) as { error?: string };
        if (response.status === 401) {
          logoutAdmin();
          setUploadError("Admin session expired. Please unlock again.");
        } else {
          setUploadError(errBody.error ?? "Could not analyze the file. Please try again.");
        }
        return;
      }

      const preview = await response.json() as PreviewResponse;
      setPreviewData(preview);

      if (preview.changedCount === 0) {
        // Nothing to ask about — apply immediately.
        setUploadPending(false);
        await applyUpsert("overwrite-all");
        return;
      }

      // Ask the user what to do with the existing matches.
      setExcludedKeys(new Set());
      setUploadPending(false);
      setChooserVisible(true);
    } catch {
      setUploadError("Could not analyze the file. Please try again.");
      setUploadPending(false);
    }
  };

  const toggleExcluded = useCallback(
    (vendor: string, catalog: string) => {
      const key = previewKey(vendor, catalog);
      setExcludedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [previewKey],
  );

  // Selected-mode keys = every changed match the user did NOT exclude.
  const selectedKeysFromReview = useMemo(() => {
    if (!previewData) return [];
    return previewData.changes
      .filter((c) => !excludedKeys.has(previewKey(c.vendor, c.catalog)))
      .map((c) => ({ vendor: c.vendor, catalog: c.catalog }));
  }, [previewData, excludedKeys, previewKey]);

  const handleEnrich = async (idsToEnrich?: number[]) => {
    setEnrichProgress({ progress: 0, total: 0 });
    try {
      const body = idsToEnrich?.length ? { ids: idsToEnrich } : {};
      const response = await fetch(`${API_BASE}/inventory/enrich`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeaders,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({})) as { error?: string };
        if (response.status === 401) {
          logoutAdmin();
          setUploadError("Admin session expired. Please unlock again.");
        } else {
          setUploadError(errBody.error ?? "AI enrichment failed — please check your connection and try again.");
        }
        setEnrichProgress(null);
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        // Buffer partial lines across chunk boundaries so we never try to parse
        // an incomplete "data: ..." SSE line.
        let sseBuffer = "";
        const processLine = async (line: string) => {
          if (!line.startsWith("data: ")) return;
          try {
            const data: EnrichProgress = JSON.parse(line.slice(6));
            setEnrichProgress(data);
            if (data.done) await inventoryQuery.refetch();
          } catch {}
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          // Keep the last (possibly incomplete) line in the buffer
          sseBuffer = lines.pop() ?? "";
          for (const line of lines) await processLine(line);
        }
        // Process any remaining buffered content when the stream closes
        if (sseBuffer.trim()) await processLine(sseBuffer);
      }
    } catch {
      setUploadError("AI enrichment failed — please check your connection and try again.");
      setEnrichProgress(null);
    }
  };

  const inventory = inventoryQuery.data?.items ?? [];
  const inventoryTotal = inventoryQuery.data?.total ?? 0;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>📤 Inventory</Text>
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>Upload & AI Enrich</Text>
          </View>
          {isAdmin ? (
            <Pressable onPress={logoutAdmin} style={[styles.lockBtn, { borderColor: colors.border }]}>
              <Text style={[styles.lockBtnText, { color: colors.mutedForeground }]}>🔓 Lock</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Admin gate — show when user is not yet authenticated as admin */}
      {!isAdmin ? (
        <AdminGate colors={colors} />
      ) : (
        <>
          {/* Inline error/success banners */}
          {uploadError ? (
            <View style={[styles.inlineBanner, styles.errorBanner, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "55" }]}>
              <Text style={[styles.inlineBannerText, { color: colors.destructive }]}>⚠ {uploadError}</Text>
              <Pressable onPress={() => setUploadError(null)} style={styles.bannerClose}>
                <Text style={{ color: colors.destructive, fontSize: 14 }}>✕</Text>
              </Pressable>
            </View>
          ) : null}
          {uploadSuccess ? (
            <View style={[styles.inlineBanner, styles.successBanner, { backgroundColor: "#10b98115", borderColor: "#10b98155" }]}>
              <Text style={[styles.inlineBannerText, { color: "#059669" }]}>
                Upload complete — created {uploadSuccess.inserted}, updated {uploadSuccess.updated}
                {uploadSuccess.skipped > 0 ? `, skipped ${uploadSuccess.skipped}` : ""} ({uploadSuccess.total} total)
              </Text>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Pressable onPress={() => { setUploadSuccess(null); setTab("inventory"); }}>
                  <Text style={{ color: "#059669", fontSize: 12, fontFamily: "Inter_600SemiBold" }}>View →</Text>
                </Pressable>
                <Pressable onPress={() => setUploadSuccess(null)} style={styles.bannerClose}>
                  <Text style={{ color: "#059669", fontSize: 14 }}>✕</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* Auto-resume banner — shown when a previous session left an upload
              partway through (app killed / crash / manual close). */}
          {resumePrompt ? (
            <View style={[styles.resumeBanner, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "55" }]}>
              <Text style={[styles.resumeTitle, { color: colors.primary }]}>
                Resume previous upload?
              </Text>
              <Text style={[styles.resumeBody, { color: colors.foreground }]}>
                {resumePrompt.fileName ?? "Untitled file"} — {resumePrompt.processedIndex} of {resumePrompt.parsedRows.length} rows processed.
              </Text>
              <View style={styles.resumeBtnRow}>
                <Pressable
                  onPress={() => { void handleResumeFromBanner(); }}
                  style={[styles.resumePrimary, { backgroundColor: colors.primary }]}
                >
                  <Text style={[styles.resumePrimaryText, { color: colors.primaryForeground }]}>Resume</Text>
                </Pressable>
                <Pressable
                  onPress={() => { void handleDiscardFromBanner(); }}
                  style={[styles.resumeSecondary, { borderColor: colors.border }]}
                >
                  <Text style={[styles.resumeSecondaryText, { color: colors.foreground }]}>Discard</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* In-flight upload progress card — visible while a chunked upload
              is running OR paused. Shows totals so far and Pause / Resume /
              Cancel controls. */}
          {chunkProgress ? (
            <View style={[styles.chunkCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.chunkTitle, { color: colors.foreground }]}>
                {isPaused ? "⏸ Upload paused" : "⬆️ Uploading…"}
              </Text>
              <Text style={[styles.chunkBody, { color: colors.mutedForeground }]}>
                {chunkProgress.processed} of {chunkProgress.total} rows processed
                {" — "}
                created {chunkProgress.inserted}, updated {chunkProgress.updated}
                {chunkProgress.skipped > 0 ? `, skipped ${chunkProgress.skipped}` : ""}
              </Text>
              <View style={[styles.chunkTrack, { backgroundColor: colors.muted }]}>
                <View
                  style={[
                    styles.chunkFill,
                    {
                      backgroundColor: isPaused ? colors.mutedForeground : colors.primary,
                      width: `${chunkProgress.total > 0 ? Math.min(100, (chunkProgress.processed / chunkProgress.total) * 100) : 0}%`,
                    },
                  ]}
                />
              </View>
              <View style={styles.chunkBtnRow}>
                {isPaused ? (
                  <Pressable
                    onPress={() => { void handleResumeUpload(); }}
                    style={[styles.chunkPrimary, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[styles.chunkPrimaryText, { color: colors.primaryForeground }]}>Resume</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={handlePauseUpload}
                    style={[styles.chunkPrimary, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[styles.chunkPrimaryText, { color: colors.primaryForeground }]}>Pause</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => { void handleCancelUpload(); }}
                  style={[styles.chunkSecondary, { borderColor: colors.border }]}
                >
                  <Text style={[styles.chunkSecondaryText, { color: colors.foreground }]}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* Tab bar */}
          <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
            {(["upload", "inventory"] as const).map(t => (
              <Pressable
                key={t}
                onPress={() => setTab(t)}
                style={[
                  styles.tabItem,
                  { borderBottomColor: tab === t ? colors.primary : "transparent" },
                ]}
              >
                <Text style={[styles.tabLabel, { color: tab === t ? colors.primary : colors.mutedForeground }]}>
                  {t === "upload" ? "Upload File" : `New Inventory (${inventoryTotal})`}
                </Text>
              </Pressable>
            ))}
          </View>

          {tab === "upload" ? (
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
              {/* File upload card */}
              <View style={[styles.uploadCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>📁 Import File</Text>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  Accepts: CSV, Excel (.xlsx/.xls), ODS{"\n"}
                  Required columns: vendor, catalog{"\n"}
                  Optional: description, bin (or binLocation)
                </Text>

                <Pressable onPress={handlePickFile} style={[styles.pickBtn, { borderColor: colors.primary }]}>
                  <Text style={[styles.pickBtnText, { color: colors.primary }]}>
                    📂 Choose CSV or Excel File
                  </Text>
                </Pressable>

                {fileName ? (
                  <View style={[styles.fileChip, { backgroundColor: colors.muted }]}>
                    <Text style={[styles.fileChipText, { color: colors.foreground }]}>
                      {fileType === "xlsx" ? "📊" : "📄"} {fileName}
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* Preview */}
              {parsedRows.length > 0 ? (
                <View style={[styles.previewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                    Preview ({parsedRows.length} rows)
                  </Text>

                  <View style={[styles.previewHeaderRow, { backgroundColor: colors.muted }]}>
                    {["VENDOR", "CATALOG", "DESCRIPTION", "BIN"].map(h => (
                      <Text
                        key={h}
                        style={[styles.previewHeaderCell, { color: colors.mutedForeground, flex: h === "DESCRIPTION" ? 2 : 1 }]}
                      >
                        {h}
                      </Text>
                    ))}
                  </View>

                  {parsedRows.slice(0, 8).map((row, i) => (
                    <View key={i} style={[styles.previewRow, { borderBottomColor: colors.border }]}>
                      <Text style={[styles.previewCell, { color: colors.foreground, flex: 1 }]} numberOfLines={1}>
                        {row.vendor}
                      </Text>
                      <Text style={[styles.previewCell, { color: colors.primary, flex: 1 }]} numberOfLines={1}>
                        {row.catalog}
                      </Text>
                      <Text style={[styles.previewCell, { color: colors.mutedForeground, flex: 2 }]} numberOfLines={1}>
                        {row.description}
                      </Text>
                      <Text style={[styles.previewCell, { color: colors.foreground, flex: 1 }]} numberOfLines={1}>
                        {row.binLocations.join(", ")}
                      </Text>
                    </View>
                  ))}

                  {parsedRows.length > 8 ? (
                    <Text style={[styles.moreRows, { color: colors.mutedForeground }]}>
                      +{parsedRows.length - 8} more rows
                    </Text>
                  ) : null}

                  <Pressable
                    onPress={handleUploadStart}
                    disabled={uploadPending}
                    style={[styles.uploadBtn, { backgroundColor: uploadPending ? colors.muted : colors.primary }]}
                  >
                    {uploadPending ? (
                      <ActivityIndicator color={colors.primaryForeground} />
                    ) : (
                      <Text style={[styles.uploadBtnText, { color: colors.primaryForeground }]}>
                        ⬆️ Upload {parsedRows.length} Items
                      </Text>
                    )}
                  </Pressable>
                </View>
              ) : null}

              {/* Bulk Enrichment Coverage */}
              <View style={[styles.enrichCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>📊 Enrichment Coverage</Text>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  AI generates searchable keywords for each part and saves them to the database permanently.
                </Text>

                {/* Global coverage stats */}
                {enrichSummary ? (
                  <>
                    <View style={styles.enrichStats}>
                      <View style={[styles.statChip, { backgroundColor: colors.success + "11" }]}>
                        <Text style={[styles.statValue, { color: colors.success }]}>
                          {enrichSummary.enriched.toLocaleString()}
                        </Text>
                        <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Enriched</Text>
                      </View>
                      <View style={[styles.statChip, { backgroundColor: colors.warning + "11" }]}>
                        <Text style={[styles.statValue, { color: colors.warning }]}>
                          {enrichSummary.unenriched.toLocaleString()}
                        </Text>
                        <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Pending</Text>
                      </View>
                      <View style={[styles.statChip, { backgroundColor: colors.muted }]}>
                        <Text style={[styles.statValue, { color: colors.foreground }]}>
                          {enrichSummary.total > 0
                            ? `${Math.round((enrichSummary.enriched / enrichSummary.total) * 100)}%`
                            : "—"}
                        </Text>
                        <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Coverage</Text>
                      </View>
                    </View>

                    {/* Coverage progress bar */}
                    {enrichSummary.total > 0 ? (
                      <View style={[styles.progressBar, { backgroundColor: colors.muted }]}>
                        <View
                          style={[
                            styles.progressFill,
                            {
                              backgroundColor: colors.success,
                              width: `${Math.round((enrichSummary.enriched / enrichSummary.total) * 100)}%`,
                            },
                          ]}
                        />
                      </View>
                    ) : null}
                  </>
                ) : (
                  <ActivityIndicator size="small" color={colors.primary} />
                )}

                {/* Bulk job progress (while running) */}
                {bulkJobStatus?.running ? (
                  <View style={styles.progressContainer}>
                    <View style={[styles.bulkStatusRow]}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={[styles.progressText, { color: colors.foreground, marginLeft: 8, flex: 1 }]}>
                        {bulkJobStatus.stopRequested ? "Stopping after current batch…" : "Background enrichment running…"}
                      </Text>
                      <Pressable
                        onPress={handleStopBulkEnrich}
                        disabled={bulkStopPending || bulkJobStatus.stopRequested}
                        style={[
                          styles.stopBtn,
                          { borderColor: (bulkStopPending || bulkJobStatus.stopRequested) ? colors.border : colors.destructive },
                        ]}
                      >
                        {bulkStopPending ? (
                          <ActivityIndicator size="small" color={colors.destructive} />
                        ) : (
                          <Text style={[styles.stopBtnText, { color: (bulkJobStatus.stopRequested) ? colors.mutedForeground : colors.destructive }]}>
                            {bulkJobStatus.stopRequested ? "Stopping…" : "Stop"}
                          </Text>
                        )}
                      </Pressable>
                    </View>
                    {bulkJobStatus.total != null && bulkJobStatus.total > 0 ? (
                      <>
                        <View style={[styles.progressBar, { backgroundColor: colors.muted }]}>
                          <View
                            style={[
                              styles.progressFill,
                              {
                                backgroundColor: colors.primary,
                                width: `${Math.round((bulkJobStatus.processed / bulkJobStatus.total) * 100)}%`,
                              },
                            ]}
                          />
                        </View>
                        <Text style={[styles.progressText, { color: colors.mutedForeground, fontSize: 12 }]}>
                          {bulkJobStatus.processed.toLocaleString()} / {bulkJobStatus.total.toLocaleString()} processed
                          {bulkJobStatus.errors > 0 ? ` · ${bulkJobStatus.errors} errors` : ""}
                        </Text>
                      </>
                    ) : null}
                  </View>
                ) : null}

                {/* Bulk job done state */}
                {bulkJobStatus && !bulkJobStatus.running && bulkJobStatus.finishedAt ? (
                  <View style={[styles.doneCard, { backgroundColor: colors.success + "11" }]}>
                    <Text style={[styles.doneText, { color: colors.success }]}>
                      ✓ Last run: {bulkJobStatus.processed.toLocaleString()} processed
                      {bulkJobStatus.errors > 0 ? `, ${bulkJobStatus.errors} errors` : ""}
                    </Text>
                  </View>
                ) : null}

                {/* Bulk job error */}
                {(bulkJobStatus?.lastError || bulkEnrichError) ? (
                  <View style={[styles.doneCard, { backgroundColor: colors.destructive + "11" }]}>
                    <Text style={[styles.doneText, { color: colors.destructive }]}>
                      ⚠ {bulkEnrichError ?? bulkJobStatus?.lastError}
                    </Text>
                  </View>
                ) : null}

                {/* Start / running button */}
                <Pressable
                  onPress={handleStartBulkEnrich}
                  disabled={bulkJobStatus?.running || bulkEnrichPending}
                  style={[
                    styles.enrichBtn,
                    { backgroundColor: (bulkJobStatus?.running || bulkEnrichPending) ? colors.muted : colors.primary },
                  ]}
                >
                  {bulkEnrichPending ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                      {bulkJobStatus?.running ? "⏳ Enrichment Running…" : "🚀 Start Bulk Enrichment"}
                    </Text>
                  )}
                </Pressable>
              </View>

              {/* Measurement Enrichment */}
              <View style={[styles.enrichCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>📐 Measurement Enrichment</Text>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  Converts measurement terms (e.g. 1/2" → 0.5in, 12mm) into searchable keywords for every part.
                </Text>

                {/* Running progress */}
                {measureJobStatus?.running ? (
                  <View style={styles.progressContainer}>
                    <View style={styles.bulkStatusRow}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={[styles.progressText, { color: colors.foreground, marginLeft: 8 }]}>
                        Measurement enrichment running…
                      </Text>
                    </View>
                    {measureJobStatus.total != null && measureJobStatus.total > 0 ? (
                      <>
                        <View style={[styles.progressBar, { backgroundColor: colors.muted }]}>
                          <View
                            style={[
                              styles.progressFill,
                              {
                                backgroundColor: colors.primary,
                                width: `${Math.round((measureJobStatus.processed / measureJobStatus.total) * 100)}%`,
                              },
                            ]}
                          />
                        </View>
                        <Text style={[styles.progressText, { color: colors.mutedForeground, fontSize: 12 }]}>
                          {measureJobStatus.processed.toLocaleString()} / {measureJobStatus.total.toLocaleString()} processed
                          {measureJobStatus.updated > 0 ? ` · ${measureJobStatus.updated} updated` : ""}
                        </Text>
                      </>
                    ) : null}
                  </View>
                ) : null}

                {/* Done state */}
                {measureJobStatus && !measureJobStatus.running && measureJobStatus.finishedAt ? (
                  <View style={[styles.doneCard, { backgroundColor: colors.success + "11" }]}>
                    <Text style={[styles.doneText, { color: colors.success }]}>
                      ✓ Last run: {measureJobStatus.processed.toLocaleString()} processed
                      {measureJobStatus.updated > 0 ? `, ${measureJobStatus.updated} updated` : ""}
                    </Text>
                  </View>
                ) : null}

                {/* Error */}
                {(measureJobStatus?.lastError || measureEnrichError) ? (
                  <View style={[styles.doneCard, { backgroundColor: colors.destructive + "11" }]}>
                    <Text style={[styles.doneText, { color: colors.destructive }]}>
                      ⚠ {measureEnrichError ?? measureJobStatus?.lastError}
                    </Text>
                  </View>
                ) : null}

                <Pressable
                  onPress={handleStartMeasureEnrich}
                  disabled={measureJobStatus?.running || measureEnrichPending}
                  style={[
                    styles.enrichBtn,
                    { backgroundColor: (measureJobStatus?.running || measureEnrichPending) ? colors.muted : colors.primary },
                  ]}
                >
                  {measureEnrichPending ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                      {measureJobStatus?.running ? "⏳ Running…" : "📐 Run Measurement Enrichment"}
                    </Text>
                  )}
                </Pressable>
              </View>

              {/* Quick-enrich (SSE streaming for immediate feedback) */}
              <View style={[styles.enrichCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>🤖 Quick Enrich</Text>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  Enrich a small batch immediately with live progress. Useful for newly imported items.
                </Text>

                {enrichProgress && !enrichProgress.done ? (
                  <View style={styles.progressContainer}>
                    <View style={[styles.progressBar, { backgroundColor: colors.muted }]}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            backgroundColor: colors.primary,
                            width: enrichProgress.total > 0
                              ? `${Math.round((enrichProgress.progress / enrichProgress.total) * 100)}%`
                              : "0%",
                          },
                        ]}
                      />
                    </View>
                    <Text style={[styles.progressText, { color: colors.foreground }]}>
                      {enrichProgress.progress} / {enrichProgress.total} items
                      {enrichProgress.batchSize ? ` (batch of ${enrichProgress.batchSize})` : ""}
                    </Text>
                    {enrichProgress.etaSeconds != null && enrichProgress.etaSeconds > 0 ? (
                      <Text style={[styles.progressText, { color: colors.mutedForeground, fontSize: 12 }]}>
                        ETA: ~{enrichProgress.etaSeconds < 60
                          ? `${enrichProgress.etaSeconds}s`
                          : `${Math.ceil(enrichProgress.etaSeconds / 60)}m`}
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                {enrichProgress?.done ? (
                  <View style={[styles.doneCard, { backgroundColor: colors.success + "11" }]}>
                    <Text style={[styles.doneText, { color: colors.success }]}>
                      ✓ Done! {enrichProgress.progress} items processed.
                    </Text>
                  </View>
                ) : null}

                <Pressable
                  onPress={() => handleEnrich()}
                  disabled={!!enrichProgress && !enrichProgress.done}
                  style={[
                    styles.enrichBtn,
                    { backgroundColor: (enrichProgress && !enrichProgress.done) ? colors.muted : colors.primary },
                  ]}
                >
                  <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                    {enrichProgress && !enrichProgress.done ? "Enriching…" : "🤖 Quick Enrich Pending"}
                  </Text>
                </Pressable>
              </View>

              {/* ── Catalog PDF Enrichment ──────────────────────────────────── */}
              <View style={[styles.enrichCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>📕 Catalog PDF</Text>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  Pick a supported vendor and upload its catalog PDF to enrich
                  matching inventory rows with descriptions, dimension chips, and
                  search keywords from the catalog.
                </Text>

                <View style={{ flexDirection: "row", alignItems: "center", marginVertical: 8 }}>
                  <Text style={{ color: colors.mutedForeground, fontSize: 12, fontFamily: "Inter_500Medium", marginRight: 8 }}>
                    VENDOR
                  </Text>
                  <Pressable
                    onPress={() => setVendorPickerOpen(true)}
                    style={{
                      flex: 1,
                      borderWidth: 1,
                      borderColor: colors.border,
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ color: colors.foreground, fontFamily: "Inter_500Medium" }}>
                      {catalogVendorOptions.find(v => v.vendor === catalogPdfVendor)?.displayName ?? catalogPdfVendor}
                    </Text>
                    <Text style={{ color: colors.mutedForeground }}>▾</Text>
                  </Pressable>
                </View>

                {(() => {
                  const selected = catalogVendorOptions.find(v => v.vendor === catalogPdfVendor);
                  return selected ? (
                    <Text style={{ color: colors.mutedForeground, fontSize: 11, marginBottom: 6 }}>
                      Expects: {selected.sourceCatalog}
                    </Text>
                  ) : null;
                })()}

                <Modal
                  transparent
                  visible={vendorPickerOpen}
                  animationType="fade"
                  onRequestClose={() => setVendorPickerOpen(false)}
                >
                  <Pressable
                    onPress={() => setVendorPickerOpen(false)}
                    style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center", padding: 24 }}
                  >
                    <View style={{ width: "100%", maxWidth: 380, backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12 }}>
                      <Text style={{ color: colors.foreground, fontFamily: "Inter_700Bold", fontSize: 14, marginBottom: 8 }}>
                        Select catalog vendor
                      </Text>
                      {(catalogVendorOptions.length > 0
                        ? catalogVendorOptions
                        : [{ vendor: "BRIDGEPORT", displayName: "Bridgeport Fittings", sourceCatalog: "Bridgeport Fittings 2026 Catalog" }]
                      ).map(opt => {
                        const isActive = opt.vendor === catalogPdfVendor;
                        return (
                          <Pressable
                            key={opt.vendor}
                            onPress={() => { setCatalogPdfVendor(opt.vendor); setVendorPickerOpen(false); }}
                            style={{
                              paddingVertical: 10,
                              paddingHorizontal: 12,
                              borderRadius: 8,
                              backgroundColor: isActive ? colors.primary + "22" : "transparent",
                              marginBottom: 4,
                            }}
                          >
                            <Text style={{ color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>{opt.displayName}</Text>
                            <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 2 }}>{opt.sourceCatalog}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </Pressable>
                </Modal>

                <Pressable
                  onPress={handleCatalogPdfPick}
                  disabled={catalogPdfPending}
                  style={[styles.pickBtn, { borderColor: colors.primary }]}
                >
                  {catalogPdfPending ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <Text style={[styles.pickBtnText, { color: colors.primary }]}>
                      📕 Choose Catalog PDF
                    </Text>
                  )}
                </Pressable>

                {catalogPdfFileName ? (
                  <View style={[styles.fileChip, { backgroundColor: colors.muted }]}>
                    <Text style={[styles.fileChipText, { color: colors.foreground }]}>
                      📄 {catalogPdfFileName}
                    </Text>
                  </View>
                ) : null}

                {catalogPdfError ? (
                  <View style={[styles.doneCard, { backgroundColor: colors.destructive + "11" }]}>
                    <Text style={[styles.doneText, { color: colors.destructive }]}>⚠ {catalogPdfError}</Text>
                  </View>
                ) : null}

                {/* Recent enrichment runs — each can be reverted to restore
                    the description + aiKeywords for every inventory row it
                    touched. Reverted runs show a strikethrough-style label
                    and lose their button. */}
                {catalogRuns.length > 0 ? (
                  <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
                    <Text style={{ color: colors.foreground, fontFamily: "Inter_600SemiBold", marginBottom: 8 }}>
                      Recent enrichment runs
                    </Text>
                    {catalogRuns.map((run) => {
                      const when = new Date(run.startedAt).toLocaleString();
                      const isReverting = revertingRunId === run.id;
                      const isReverted = !!run.revertedAt;
                      return (
                        <View
                          key={run.id}
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            paddingVertical: 8,
                            borderBottomWidth: 1,
                            borderBottomColor: colors.border,
                            opacity: isReverted ? 0.55 : 1,
                          }}
                        >
                          <View style={{ flex: 1, paddingRight: 8 }}>
                            <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Inter_500Medium" }} numberOfLines={1}>
                              {run.vendor} · {run.sourceFilename ?? "raw upload"}
                            </Text>
                            <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 2 }}>
                              {when} · {run.updatedCount} updated
                              {run.errorCount > 0 ? ` · ${run.errorCount} errors` : ""}
                              {isReverted ? " · reverted" : ""}
                            </Text>
                          </View>
                          {isReverted ? null : (
                            <Pressable
                              onPress={() => { void handleRevertRun(run.id); }}
                              disabled={isReverting || revertingRunId !== null}
                              style={{
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                borderRadius: 6,
                                borderWidth: 1,
                                borderColor: isReverting ? colors.border : colors.destructive,
                              }}
                            >
                              {isReverting ? (
                                <ActivityIndicator size="small" color={colors.destructive} />
                              ) : (
                                <Text style={{ color: colors.destructive, fontSize: 12, fontFamily: "Inter_600SemiBold" }}>
                                  Revert
                                </Text>
                              )}
                            </Pressable>
                          )}
                        </View>
                      );
                    })}
                  </View>
                ) : null}

                {catalogReport ? (
                  <View style={{ marginTop: 8 }}>
                    <Text style={{ color: colors.foreground, fontFamily: "Inter_500Medium", marginBottom: 4 }}>
                      Parsed {catalogReport.summary.total.toLocaleString()} catalog entries:
                    </Text>
                    <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                      ✅ {catalogReport.summary.exact} exact ·{" "}
                      ⚡ {catalogReport.summary.highConfidence} high-confidence ·{" "}
                      ❓ {catalogReport.summary.uncertain} uncertain ·{" "}
                      ❌ {catalogReport.summary.unmatched} no match
                    </Text>
                    {catalogApplyResult ? (
                      <Text style={{ color: colors.success, fontSize: 13, marginTop: 4 }}>
                        ✓ Applied: {catalogApplyResult.updated} updated, {catalogApplyResult.skippedNoOp} unchanged
                        {catalogApplyResult.errors.length > 0 ? `, ${catalogApplyResult.errors.length} errors` : ""}
                      </Text>
                    ) : null}
                    {catalogReport.summary.uncertain > 0 ? (
                      <Pressable
                        onPress={() => setCatalogReviewVisible(true)}
                        style={[styles.enrichBtn, { backgroundColor: colors.primary, marginTop: 8 }]}
                      >
                        <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                          📝 Review {catalogReport.summary.uncertain} uncertain matches
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </ScrollView>
          ) : (
            <View style={{ flex: 1 }}>
              {inventoryQuery.isLoading ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="large" color={colors.primary} />
                  <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Loading inventory…</Text>
                </View>
              ) : inventory.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyEmoji}>📦</Text>
                  <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Inventory</Text>
                  <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                    Upload a CSV or Excel file to add inventory items.
                  </Text>
                  <Pressable
                    onPress={() => setTab("upload")}
                    style={[styles.goUploadBtn, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[styles.goUploadText, { color: colors.primaryForeground }]}>Go to Upload</Text>
                  </Pressable>
                </View>
              ) : (
                <FlatList
                  data={inventory}
                  keyExtractor={item => String(item.id)}
                  renderItem={({ item }) => <InventoryRow item={item} colors={colors} />}
                  contentContainerStyle={{ padding: 12, paddingBottom: 120 }}
                  ListHeaderComponent={() => (
                    <View style={styles.inventoryHeader}>
                      <Text style={[styles.inventoryCount, { color: colors.foreground }]}>
                        {inventoryTotal} items total
                      </Text>
                      <Pressable
                        onPress={() => handleEnrich()}
                        style={[styles.enrichSmallBtn, { backgroundColor: colors.primary }]}
                      >
                        <Text style={[styles.enrichSmallText, { color: colors.primaryForeground }]}>🤖 Enrich All</Text>
                      </Pressable>
                    </View>
                  )}
                  ListFooterComponent={() =>
                    inventoryQuery.data && inventoryPage * 50 < inventoryTotal ? (
                      <Pressable
                        onPress={() => setInventoryPage(p => p + 1)}
                        style={[styles.loadMoreBtn, { borderColor: colors.border }]}
                      >
                        <Text style={[styles.loadMoreText, { color: colors.primary }]}>Load More</Text>
                      </Pressable>
                    ) : null
                  }
                />
              )}
            </View>
          )}
        </>
      )}

      <ReferenceModal />

      {/* ── Catalog PDF: per-row review of uncertain matches ──────────────── */}
      <Modal
        visible={catalogReviewVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCatalogReviewVisible(false)}
      >
        <SafeAreaView style={[styles.reviewSafeArea, { backgroundColor: colors.background }]}>
          <View style={[styles.reviewHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.reviewTitle, { color: colors.foreground }]}>
              Review uncertain matches
            </Text>
            <Text style={[styles.reviewSub, { color: colors.mutedForeground }]}>
              Pick the inventory row each catalog entry should enrich, or skip it.
            </Text>
          </View>

          <FlatList
            data={catalogReport?.rows.filter(r => r.tier === "uncertain") ?? []}
            keyExtractor={(r) => r.catalogNumber}
            contentContainerStyle={{ padding: 12, paddingBottom: 120 }}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            ListEmptyComponent={() => (
              <Text style={{ color: colors.mutedForeground, textAlign: "center", marginTop: 40 }}>
                No uncertain matches.
              </Text>
            )}
            renderItem={({ item }) => {
              const choice = catalogReviewChoices[item.catalogNumber];
              return (
                <View
                  style={[
                    styles.reviewRow,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.reviewCatalog, { color: colors.foreground }]} numberOfLines={1}>
                    {item.catalogNumber}
                  </Text>
                  <Text style={[styles.reviewVendor, { color: colors.mutedForeground }]} numberOfLines={2}>
                    {item.description}
                  </Text>
                  <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 4 }}>
                    Pages {item.pageNumbers.join(", ")} · {Object.entries(item.dimensions).map(([k, v]) => `${k}=${v}`).join(" · ") || "no chip dims"}
                  </Text>

                  <View style={{ marginTop: 10, gap: 6 }}>
                    {item.candidates.map((c) => {
                      const selected = choice === c.inventoryId;
                      return (
                        <Pressable
                          key={c.inventoryId}
                          onPress={() =>
                            setCatalogReviewChoices((prev) => ({ ...prev, [item.catalogNumber]: c.inventoryId }))
                          }
                          style={{
                            borderWidth: 1,
                            borderColor: selected ? colors.primary : colors.border,
                            backgroundColor: selected ? colors.primary + "11" : "transparent",
                            borderRadius: 8,
                            padding: 8,
                          }}
                        >
                          <Text style={{ color: colors.foreground, fontFamily: "Inter_500Medium" }}>
                            {c.catalog} <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>· {c.reason}</Text>
                          </Text>
                          {c.description ? (
                            <Text style={{ color: colors.mutedForeground, fontSize: 12 }} numberOfLines={2}>
                              {c.description}
                            </Text>
                          ) : null}
                        </Pressable>
                      );
                    })}
                    <Pressable
                      onPress={() =>
                        setCatalogReviewChoices((prev) => ({ ...prev, [item.catalogNumber]: "skip" }))
                      }
                      style={{
                        borderWidth: 1,
                        borderColor: choice === "skip" ? colors.destructive : colors.border,
                        backgroundColor: choice === "skip" ? colors.destructive + "11" : "transparent",
                        borderRadius: 8,
                        padding: 8,
                      }}
                    >
                      <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>
                        Skip this entry
                      </Text>
                    </Pressable>
                  </View>
                </View>
              );
            }}
          />

          <View
            style={{
              flexDirection: "row",
              gap: 8,
              padding: 12,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              backgroundColor: colors.background,
            }}
          >
            <Pressable
              onPress={() => setCatalogReviewVisible(false)}
              style={[secondaryBtnBase, { flex: 1, borderColor: colors.border }]}
            >
              <Text style={{ color: colors.foreground, fontFamily: "Inter_500Medium" }}>Close</Text>
            </Pressable>
            <Pressable
              onPress={handleCatalogReviewApply}
              disabled={catalogPdfPending}
              style={[styles.enrichBtn, { backgroundColor: colors.primary, flex: 2, marginTop: 0 }]}
            >
              {catalogPdfPending ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                  Apply picks
                </Text>
              )}
            </Pressable>
          </View>
        </SafeAreaView>
      </Modal>

      {/* ── Chooser modal: 3 options for handling existing matches ────────── */}
      <Modal
        visible={chooserVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setChooserVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.chooserCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.chooserTitle, { color: colors.foreground }]}>
              Existing items would change
            </Text>
            <Text style={[styles.chooserBody, { color: colors.mutedForeground }]}>
              {previewData
                ? `${previewData.newCount} new ${previewData.newCount === 1 ? "item" : "items"} to add. ${previewData.changedCount} existing ${previewData.changedCount === 1 ? "item" : "items"} would change (location and/or description).`
                : ""}
            </Text>

            <Pressable
              onPress={() => { setChooserVisible(false); setReviewVisible(true); }}
              style={[styles.chooserBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.chooserBtnText, { color: colors.primaryForeground }]}>
                📝 Review case by case
              </Text>
            </Pressable>

            <Pressable
              onPress={() => { setChooserVisible(false); void applyUpsert("add-new-only"); }}
              style={[styles.chooserBtnAlt, { borderColor: colors.border }]}
            >
              <Text style={[styles.chooserBtnAltText, { color: colors.foreground }]}>
                ➕ Only add new entries
              </Text>
            </Pressable>

            <Pressable
              onPress={() => { setChooserVisible(false); void applyUpsert("overwrite-all"); }}
              style={[styles.chooserBtnAlt, { borderColor: colors.border }]}
            >
              <Text style={[styles.chooserBtnAltText, { color: colors.foreground }]}>
                ♻️ Overwrite all changes
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setChooserVisible(false)}
              style={styles.chooserCancel}
            >
              <Text style={[styles.chooserCancelText, { color: colors.mutedForeground }]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── Review modal: per-row include/exclude toggle ───────────────────── */}
      <Modal
        visible={reviewVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setReviewVisible(false)}
      >
        <SafeAreaView style={[styles.reviewSafeArea, { backgroundColor: colors.background }]}>
          <View style={[styles.reviewHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.reviewTitle, { color: colors.foreground }]}>
              Review changes
            </Text>
            <Text style={[styles.reviewSub, { color: colors.mutedForeground }]}>
              {previewData
                ? `${selectedKeysFromReview.length} of ${previewData.changedCount} included`
                : ""}
            </Text>
          </View>

          <FlatList
            data={previewData?.changes ?? []}
            keyExtractor={(c) => previewKey(c.vendor, c.catalog)}
            contentContainerStyle={{ padding: 12, paddingBottom: 100 }}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            renderItem={({ item }) => {
              const key = previewKey(item.vendor, item.catalog);
              const included = !excludedKeys.has(key);
              return (
                <View
                  style={[
                    styles.reviewRow,
                    {
                      backgroundColor: colors.card,
                      borderColor: included ? colors.primary : colors.border,
                      opacity: included ? 1 : 0.55,
                    },
                  ]}
                >
                  <View style={styles.reviewRowHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.reviewCatalog, { color: colors.foreground }]} numberOfLines={1}>
                        {item.catalog}
                      </Text>
                      <Text style={[styles.reviewVendor, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {item.vendor}
                      </Text>
                    </View>
                    <Switch
                      value={included}
                      onValueChange={() => toggleExcluded(item.vendor, item.catalog)}
                    />
                  </View>

                  {item.binChanged ? (
                    <View style={styles.diffBlock}>
                      <Text style={[styles.diffLabel, { color: colors.mutedForeground }]}>BIN LOCATION</Text>
                      <Text style={[styles.diffOld, { color: colors.mutedForeground }]} numberOfLines={2}>
                        was: {item.existingBinLocations.length > 0 ? item.existingBinLocations.join(", ") : "(none)"}
                      </Text>
                      <Text style={[styles.diffNew, { color: colors.success }]} numberOfLines={2}>
                        new: {item.proposedBinLocations.join(", ")}
                      </Text>
                    </View>
                  ) : null}

                  {item.descChanged ? (
                    <View style={styles.diffBlock}>
                      <Text style={[styles.diffLabel, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
                      <Text style={[styles.diffOld, { color: colors.mutedForeground }]} numberOfLines={3}>
                        was: {item.existingDescription || "(empty)"}
                      </Text>
                      <Text style={[styles.diffNew, { color: colors.success }]} numberOfLines={3}>
                        new: {item.proposedDescription}
                      </Text>
                    </View>
                  ) : null}
                </View>
              );
            }}
            ListEmptyComponent={() => (
              <Text style={[styles.reviewEmpty, { color: colors.mutedForeground }]}>
                No changes to review.
              </Text>
            )}
          />

          <View style={[styles.reviewFooter, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
            <Pressable
              onPress={() => setReviewVisible(false)}
              style={[styles.reviewCancel, { borderColor: colors.border }]}
            >
              <Text style={[styles.reviewCancelText, { color: colors.foreground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setReviewVisible(false);
                void applyUpsert("selected", selectedKeysFromReview);
              }}
              disabled={uploadPending}
              style={[
                styles.reviewConfirm,
                { backgroundColor: uploadPending ? colors.muted : colors.primary },
              ]}
            >
              {uploadPending ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.reviewConfirmText, { color: colors.primaryForeground }]}>
                  {`Apply ${selectedKeysFromReview.length} ${selectedKeysFromReview.length === 1 ? "change" : "changes"}`}
                  {previewData && previewData.newCount > 0
                    ? ` (${previewData.newCount} new ${previewData.newCount === 1 ? "row" : "rows"} will still be added)`
                    : ""}
                </Text>
              )}
            </Pressable>
          </View>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  lockBtn: { ...secondaryBtnBase, paddingHorizontal: 12, paddingVertical: 7 },
  lockBtnText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  tabBar: { flexDirection: "row", borderBottomWidth: 1 },
  tabItem: { flex: 1, alignItems: "center", paddingVertical: 12, borderBottomWidth: 2 },
  tabLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  uploadCard: { borderRadius: 12, padding: 16, borderWidth: 1, marginBottom: 14, gap: 10 },
  resumeBanner: { marginHorizontal: 16, marginTop: 10, padding: 12, borderRadius: 10, borderWidth: 1, gap: 6 },
  resumeTitle: { fontSize: 14, fontFamily: "Inter_700Bold" },
  resumeBody: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  resumeBtnRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  resumePrimary: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  resumePrimaryText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  resumeSecondary: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center", borderWidth: 1 },
  resumeSecondaryText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  chunkCard: { marginHorizontal: 16, marginTop: 10, padding: 14, borderRadius: 12, borderWidth: 1, gap: 8 },
  chunkTitle: { fontSize: 15, fontFamily: "Inter_700Bold" },
  chunkBody: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  chunkTrack: { height: 8, borderRadius: 4, overflow: "hidden", marginTop: 4 },
  chunkFill: { height: "100%", borderRadius: 4 },
  chunkBtnRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  chunkPrimary: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  chunkPrimaryText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  chunkSecondary: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center", borderWidth: 1 },
  chunkSecondaryText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  cardTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  cardHint: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19 },
  pickBtn: { borderWidth: 2, borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  pickBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  fileChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, alignSelf: "flex-start" },
  fileChipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  previewCard: { borderRadius: 12, padding: 14, borderWidth: 1, marginBottom: 14 },
  previewHeaderRow: { flexDirection: "row", paddingHorizontal: 6, paddingVertical: 6, borderRadius: 4, marginBottom: 2, marginTop: 8 },
  previewHeaderCell: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5 },
  previewRow: { flexDirection: "row", paddingHorizontal: 6, paddingVertical: 7, borderBottomWidth: 1 },
  previewCell: { fontSize: 12, fontFamily: "Inter_400Regular", paddingRight: 4 },
  moreRows: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 8 },
  uploadBtn: { marginTop: 12, borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  uploadBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  enrichCard: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 12, marginBottom: 14 },
  progressContainer: { gap: 8 },
  bulkStatusRow: { flexDirection: "row", alignItems: "center" },
  stopBtn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, marginLeft: 8 },
  stopBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  progressBar: { height: 8, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 4 },
  progressText: { fontSize: 13, fontFamily: "Inter_500Medium", textAlign: "center" },
  doneCard: { padding: 12, borderRadius: 8 },
  doneText: { fontSize: 14, fontFamily: "Inter_600SemiBold", textAlign: "center" },
  enrichStats: { flexDirection: "row", gap: 10 },
  statChip: { flex: 1, alignItems: "center", padding: 12, borderRadius: 8 },
  statValue: { fontSize: 22, fontFamily: "Inter_700Bold" },
  statLabel: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  enrichBtn: { borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  enrichBtnText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 20, fontFamily: "Inter_700Bold", marginBottom: 8 },
  emptyHint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 20 },
  goUploadBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  goUploadText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  inventoryHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  inventoryCount: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  enrichSmallBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  enrichSmallText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  loadMoreBtn: { ...secondaryBtnBase, padding: 12, alignItems: "center", marginTop: 8 },
  loadMoreText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  inlineBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1 },
  errorBanner: {},
  successBanner: {},
  inlineBannerText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1, lineHeight: 18 },
  bannerClose: { paddingLeft: 10 },

  // Chooser modal
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 20 },
  chooserCard: { width: "100%", maxWidth: 380, borderRadius: 16, padding: 20, borderWidth: 1, gap: 10 },
  chooserTitle: { fontSize: 18, fontFamily: "Inter_700Bold", textAlign: "center" },
  chooserBody: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19, marginBottom: 6 },
  chooserBtn: { borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  chooserBtnText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  chooserBtnAlt: { borderRadius: 8, paddingVertical: 13, alignItems: "center", borderWidth: 1 },
  chooserBtnAltText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  chooserCancel: { paddingVertical: 10, alignItems: "center", marginTop: 4 },
  chooserCancelText: { fontSize: 13, fontFamily: "Inter_500Medium" },

  // Review modal
  reviewSafeArea: { flex: 1 },
  reviewHeader: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  reviewTitle: { fontSize: 18, fontFamily: "Inter_700Bold" },
  reviewSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  reviewRow: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  reviewRowHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  reviewCatalog: { fontSize: 14, fontFamily: "Inter_700Bold" },
  reviewVendor: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  diffBlock: { gap: 2, marginTop: 4 },
  diffLabel: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5 },
  diffOld: { fontSize: 12, fontFamily: "Inter_400Regular", textDecorationLine: "line-through" },
  diffNew: { fontSize: 12, fontFamily: "Inter_500Medium" },
  reviewEmpty: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 40 },
  reviewFooter: { flexDirection: "row", gap: 10, padding: 12, borderTopWidth: 1 },
  reviewCancel: { flex: 1, borderRadius: 8, paddingVertical: 13, alignItems: "center", borderWidth: 1 },
  reviewCancelText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  reviewConfirm: { flex: 2, borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  reviewConfirmText: { fontSize: 14, fontFamily: "Inter_700Bold" },
});
