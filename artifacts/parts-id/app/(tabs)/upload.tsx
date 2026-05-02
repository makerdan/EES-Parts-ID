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

  // Apply step — POSTs to /inventory/upsert-batch with the chosen mode and an
  // optional selectedKeys list (used only when mode === "selected").
  const applyUpsert = useCallback(
    async (mode: UpsertMode, selectedKeys?: Array<{ vendor: string; catalog: string }>) => {
      if (!parsedRows.length) return;
      setUploadError(null);
      setUploadSuccess(null);
      setUploadPending(true);
      try {
        const body: { items: ParsedRow[]; mode: UpsertMode; selectedKeys?: Array<{ vendor: string; catalog: string }> } = {
          items: parsedRows,
          mode,
        };
        if (mode === "selected" && selectedKeys) body.selectedKeys = selectedKeys;

        const response = await fetch(`${API_BASE}/inventory/upsert-batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...adminHeaders },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errBody = await response.json().catch(() => ({})) as { error?: string };
          if (response.status === 401) {
            logoutAdmin();
            setUploadError("Admin session expired. Please unlock again.");
          } else {
            setUploadError(errBody.error ?? "Upload failed — could not save inventory items. Please try again.");
          }
          return;
        }

        const result = await response.json() as UpsertResult;
        setUploadSuccess(result);
        setParsedRows([]);
        setFileName(null);
        setFileType(null);
        setPreviewData(null);
        setExcludedKeys(new Set());
        await inventoryQuery.refetch();
      } catch {
        setUploadError("Upload failed — could not save inventory items. Please try again.");
      } finally {
        setUploadPending(false);
      }
    },
    [parsedRows, adminHeaders, logoutAdmin, inventoryQuery],
  );

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
                  Apply {selectedKeysFromReview.length} {selectedKeysFromReview.length === 1 ? "change" : "changes"}
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
