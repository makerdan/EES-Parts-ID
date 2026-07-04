import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InventoryItem } from "@workspace/api-client-react";
import { useListInventory } from "@workspace/api-client-react";
import * as DocumentPicker from "expo-document-picker";
import { File as FsFile, Paths as FsPaths } from "expo-file-system";
import { useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import { isLiDARSupported } from "lidar-measure";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { SheetData } from "read-excel-file/universal";
import { readSheet } from "read-excel-file/universal";
import { z } from "zod";

import { AddPartForm } from "@/components/AddPartForm";
import { BarcodeAddPart } from "@/components/BarcodeAddPart";
import { BinEditor } from "@/components/BinEditor";
import { BulkShelfAssign } from "@/components/BulkShelfAssign";
import { CatalogPdfUpload } from "@/components/CatalogPdfUpload";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import type { PartDimensions } from "@/components/MeasurePartScreen";
import { MeasurePartScreen } from "@/components/MeasurePartScreen";
import { ReferenceModal } from "@/components/ReferenceModal";
import { ShelfCatalogEntry } from "@/components/ShelfCatalogEntry";
import { UserAdminButtonRow } from "@/components/UserAdminButtonRow";
import { useApp } from "@/contexts/AppContext";
import { useApiStatus } from "@/hooks/useApiStatus";
import { useColors } from "@/hooks/useColors";
import { secondaryBtnBase } from "@/styles/shared";
import {
  fetchAdminUsers,
  handleUserAction as runUserAction,
} from "@/utils/adminUserActions";
import { API_BASE } from "@/utils/apiBase";
import {
  activeReplacementCount,
  type BinDiffRow,
  type ParsedRow,
  preservedBinCount,
  serializeToCsv,
  toggleSkipAll,
  toggleSkipRow,
} from "@/utils/binSkipLogic";
import {
  applyDiscardAll,
  type ExpandDescResult,
  runSaveAll,
} from "@/utils/expandDescHandlers";
import { serializeInventoryToCsv } from "@/utils/exportCsv";
import { useTrackScreen } from "@/utils/useTrackScreen";

const EXPAND_DESC_DRAFT_KEY = "@expandDesc:draft";
type ExpandDescDraft = {
  results: Array<ExpandDescResult>;
  streamDone: boolean;
  model: string | null;
  remaining: number | null;
  savedAt: number;
};

const SQL_EXAMPLES: Array<{ label: string; group: string; sql: string }> = [
  {
    group: "Browse",
    label: "All parts (paginated)",
    sql: "SELECT id, vendor, catalog, description\nFROM inventory\nORDER BY vendor, catalog\nLIMIT 50",
  },
  {
    group: "Browse",
    label: "Part count by vendor",
    sql: "SELECT vendor, COUNT(*) AS parts\nFROM inventory\nGROUP BY vendor\nORDER BY parts DESC",
  },
  {
    group: "Search & Filter",
    label: "Search description",
    sql: "SELECT id, vendor, catalog, description\nFROM inventory\nWHERE description ILIKE '%contactor%'\nLIMIT 50",
  },
  {
    group: "Search & Filter",
    label: "Parts in a bin",
    sql: "SELECT id, vendor, catalog, description, bin_locations\nFROM inventory\nWHERE bin_locations && ARRAY['A01']\nLIMIT 50",
  },
  {
    group: "Search & Filter",
    label: "Parts missing a bin",
    sql: "SELECT id, vendor, catalog, description\nFROM inventory\nWHERE array_length(bin_locations, 1) = 0\n   OR bin_locations IS NULL\nLIMIT 50",
  },
  {
    group: "Enrichment",
    label: "Enrichment summary",
    sql: "SELECT\n  COUNT(*) AS total,\n  COUNT(enriched_at) AS enriched,\n  COUNT(*) FILTER (WHERE enriched_at IS NULL) AS pending\nFROM inventory",
  },
  {
    group: "Enrichment",
    label: "Parts not yet enriched",
    sql: "SELECT id, vendor, catalog, description\nFROM inventory\nWHERE enriched_at IS NULL\nLIMIT 50",
  },
  {
    group: "Dimensions",
    label: "Parts with measured dimensions",
    sql: "SELECT vendor, catalog,\n  (dimensions->>'length')::numeric AS length_mm,\n  (dimensions->>'width')::numeric AS width_mm,\n  (dimensions->>'height')::numeric AS height_mm,\n  (dimensions->>'diameter')::numeric AS diameter_mm\nFROM inventory\nWHERE dimensions IS NOT NULL\nLIMIT 50",
  },
  {
    group: "Warehouse",
    label: "All map zones",
    sql: "SELECT aisle_id, section_num, is_inventory\nFROM warehouse_zone\nORDER BY aisle_id, section_num",
  },
];

type BinDiffSummary = {
  willReplaceBins: number;
  willAddBins: number;
  willPreserveBins: number;
  noChange: number;
  rows: Array<BinDiffRow>;
  willReplaceBarcodes: number;
  willAddBarcodes: number;
  willPreserveBarcodes: number;
  willBarcodeConflicts: number;
};

// CSV/XLSX cell may pack multiple bins separated by ; or | — split, trim, drop blanks.
function parseBinCell(cell: string): Array<string> {
  const trimmed = cell.trim();
  if (!trimmed) return [];
  return trimmed.split(/[;|]/).map(b => b.trim()).filter(b => b.length > 0);
}

type EnrichProgress = {
  progress: number;
  total: number;
  batchSize?: number;
  etaSeconds?: number | null;
  done?: boolean;
  error?: string;
  item?: { id: number; keywords: Array<string> };
};

type BulkJobStatus = {
  running: boolean;
  stopRequested: boolean;
  force: boolean;
  startedAt: string | null;
  processed: number;
  errors: number;
  total: number | null;
  finishedAt: string | null;
  lastError: string | null;
  model: string | null;
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

const EnrichSummarySchema = z.object({ total: z.number(), enriched: z.number(), unenriched: z.number() });
const BulkJobStatusSchema = z.object({
  running: z.boolean(),
  stopRequested: z.boolean(),
  force: z.boolean(),
  startedAt: z.string().nullable(),
  processed: z.number(),
  errors: z.number(),
  total: z.number().nullable(),
  finishedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  model: z.string().nullable(),
});
const MeasureJobStatusSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  processed: z.number(),
  updated: z.number(),
  total: z.number().nullable(),
  finishedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
const SseExpandDescDataSchema = z.object({
  status: z.string().optional(),
  done: z.boolean().optional(),
  processed: z.number().optional(),
  total: z.number().optional(),
  remaining: z.number().optional(),
  id: z.number().optional(),
  partNumber: z.string().optional(),
  originalDescription: z.string().optional(),
  expandedDescription: z.string().nullable().optional(),
  error: z.string().optional(),
  progress: z.number().optional(),
  model: z.string().optional(),
});
const BinDiffSummarySchema = z.object({
  willReplaceBins: z.number(),
  willAddBins: z.number(),
  willPreserveBins: z.number(),
  noChange: z.number(),
  rows: z.array(z.unknown()),
  willReplaceBarcodes: z.number(),
  willAddBarcodes: z.number(),
  willPreserveBarcodes: z.number(),
  willBarcodeConflicts: z.number(),
});
const BulkJobWrapperSchema = z.object({ job: BulkJobStatusSchema });
const MeasureJobWrapperSchema = z.object({ job: MeasureJobStatusSchema });
const ApiErrorSchema = z.object({ error: z.string().optional() });
const UploadResultSchema = z.object({ inserted: z.number(), updated: z.number(), total: z.number() });
const QueryResultSchema = z.object({
  columns: z.array(z.string()).optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  rowCount: z.number().optional(),
  error: z.string().optional(),
});

// ── Column header aliases ──────────────────────────────────────────────────
const VENDOR_ALIASES = ["vendor", "mfr", "manufacturer", "brand", "make", "supplier"];
const CATALOG_ALIASES = ["catalog", "catalog#", "cat#", "part", "part#", "partno", "item", "itemno", "sku", "model", "partnumber", "part number", "cat no", "catalog no"];
const DESC_ALIASES = ["description", "desc", "name", "product", "productname", "title", "item description"];
const BIN_ALIASES = ["bin", "bin location", "binlocation", "location", "loc", "shelf", "aisle", "bin#", "bin no"];
const BARCODE_ALIASES = ["barcode", "barcodes", "barcode#", "upc", "ean", "gtin"];

function findCol(headers: Array<string>, aliases: Array<string>): number {
  return aliases.map(a => headers.indexOf(a)).find(i => i >= 0) ?? -1;
}

// ── Parse CSV text ─────────────────────────────────────────────────────────
function parseCSV(rawText: string): Array<ParsedRow> {
  // Strip UTF-8 BOM (\uFEFF) if present so Excel-exported files parse correctly.
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0]!.split(",").map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
  const vendorCol = findCol(headers, VENDOR_ALIASES);
  const catalogCol = findCol(headers, CATALOG_ALIASES);
  const descCol = findCol(headers, DESC_ALIASES);
  const binCol = findCol(headers, BIN_ALIASES);
  const barcodeCol = findCol(headers, BARCODE_ALIASES);

  const rows: Array<ParsedRow> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i]!);
    const vendor = vendorCol >= 0 ? cells[vendorCol]?.trim() ?? "" : "";
    const catalog = catalogCol >= 0 ? cells[catalogCol]?.trim() ?? "" : "";
    if (!vendor && !catalog) continue;
    rows.push({
      vendor: vendor || "UNKNOWN",
      catalog: catalog || "UNKNOWN",
      description: descCol >= 0 ? cells[descCol]?.trim() ?? "" : "",
      binLocations: binCol >= 0 ? parseBinCell(cells[binCol] ?? "") : [],
      barcodes: barcodeCol >= 0 ? (cells[barcodeCol] ?? "").trim().split(/[,;|]/).map(b => b.trim()).filter(b => b.length > 0) : [],
    });
  }
  return rows;
}

function splitCSVLine(line: string): Array<string> {
  const cells: Array<string> = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map(c => c.replace(/^"|"$/g, ""));
}

// ── Parse .xlsx/.xlsm via read-excel-file ─────────────────────────────────
async function parseXlsx(uri: string): Promise<Array<ParsedRow>> {
  const response = await fetch(uri);
  const arrayBuffer = await response.arrayBuffer();

  // Try sheets 1-5, pick the one with the best Vendor/Catalog header match
  let bestRows: SheetData | null = null;
  let bestScore = -1;
  for (let sheetNum = 1; sheetNum <= 5; sheetNum++) {
    try {
      const rows = await readSheet(arrayBuffer, sheetNum);
      if (!rows || rows.length === 0) break;
      const hdrs = rows[0].map(h => String(h ?? "").trim().toLowerCase());
      let score = 0;
      if (VENDOR_ALIASES.some(a => hdrs.includes(a))) score += 2;
      if (CATALOG_ALIASES.some(a => hdrs.includes(a))) score += 2;
      if (score > bestScore) { bestScore = score; bestRows = rows; }
      if (bestScore >= 4) break;
    } catch {
      break;
    }
  }

  if (!bestRows || bestRows.length < 2) return [];

  const headers = bestRows[0]!.map(h => String(h ?? "").trim().toLowerCase());
  const vendorCol = findCol(headers, VENDOR_ALIASES);
  const catalogCol = findCol(headers, CATALOG_ALIASES);
  const descCol = findCol(headers, DESC_ALIASES);
  const binCol = findCol(headers, BIN_ALIASES);
  const barcodeCol = findCol(headers, BARCODE_ALIASES);

  const rows: Array<ParsedRow> = [];
  for (let i = 1; i < bestRows.length; i++) {
    const cells = bestRows[i]!.map(c => String(c ?? "").trim());
    const vendor = vendorCol >= 0 ? cells[vendorCol] ?? "" : "";
    const catalog = catalogCol >= 0 ? cells[catalogCol] ?? "" : "";
    if (!vendor && !catalog) continue;
    rows.push({
      vendor: vendor || "UNKNOWN",
      catalog: catalog || "UNKNOWN",
      description: descCol >= 0 ? cells[descCol] ?? "" : "",
      binLocations: binCol >= 0 ? parseBinCell(cells[binCol] ?? "") : [],
      barcodes: barcodeCol >= 0 ? (cells[barcodeCol] ?? "").split(/[,;|]/).map(b => b.trim()).filter(b => b.length > 0) : [],
    });
  }
  return rows;
}

// ── Inventory row component ───────────────────────────────────────────────
function InventoryRow({
  item,
  colors,
  onEditBins,
}: {
  item: InventoryItem;
  colors: ReturnType<typeof useColors>;
  onEditBins?: (item: InventoryItem) => void;
}) {
  const isEnriched = !!item.enrichedAt;
  const hasBins = !!item.binLocations && item.binLocations.length > 0;
  return (
    <Pressable
      onPress={onEditBins ? () => onEditBins(item) : undefined}
      style={[rowStyles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
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
        {hasBins ? (
          <Text style={[rowStyles.bin, { color: colors.primary }]}>
            {item.binLocations.join(", ")}
          </Text>
        ) : onEditBins ? (
          <Text style={[rowStyles.bin, { color: colors.mutedForeground, fontStyle: "italic" }]}>
            + add bin
          </Text>
        ) : null}
        <View style={[rowStyles.enrichBadge, { backgroundColor: isEnriched ? colors.success + "22" : colors.muted }]}>
          <Text style={[rowStyles.enrichText, { color: isEnriched ? colors.success : colors.mutedForeground }]}>
            {isEnriched ? "✓ AI" : "—"}
          </Text>
        </View>
      </View>
    </Pressable>
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
  bin: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  enrichBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4 },
  enrichText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
});

// ── Admin gate component ──────────────────────────────────────────────────
// Admin authority is role-based (Clerk). Non-admins simply see a restricted
// notice — there is no password to enter.
function AdminRestricted({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[gateStyles.container, { backgroundColor: colors.background }]}>
      <View style={[gateStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[gateStyles.icon]}>🔒</Text>
        <Text style={[gateStyles.title, { color: colors.foreground }]}>Admin Access Required</Text>
        <Text style={[gateStyles.hint, { color: colors.mutedForeground }]}>
          Inventory tools are restricted to administrators. Ask an existing admin to grant your
          account admin access, then reopen this tab.
        </Text>
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
});

// ── ExpandDescResultCard ───────────────────────────────────────────────────
// Defined outside UploadScreen (which has "use no memo") so React.memo works.
// Typing in the text box only re-renders this card; the parent screen is
// not re-rendered on each keystroke, preventing ScrollView scroll-to-top
// and TextInput focus loss.  The parent's editedText is synced on blur so
// that "Save All" sees the latest text.
const ExpandDescResultCard = React.memo(function ExpandDescResultCard({
  result,
  onSave,
  onDiscard,
  onTextBlur,
}: {
  result: ExpandDescResult;
  onSave: (id: number, text: string) => void;
  onDiscard: (id: number) => void;
  onTextBlur: (id: number, text: string) => void;
}) {
  const colors = useColors();
  const [localText, setLocalText] = useState(result.editedText);
  const isFinalised = result.savedStatus === "saved" || result.savedStatus === "discarded";
  const cardBg =
    result.savedStatus === "saved"
      ? colors.success + "11"
      : result.savedStatus === "discarded"
        ? colors.muted
        : result.savedStatus === "error"
          ? colors.destructive + "0d"
          : colors.background;
  const cardBorder =
    result.savedStatus === "saved"
      ? colors.success + "44"
      : result.savedStatus === "discarded"
        ? colors.border
        : result.savedStatus === "error"
          ? colors.destructive + "55"
          : colors.primary + "33";
  return (
    <View style={{ borderRadius: 12, padding: 16, borderWidth: 1, gap: 12, marginBottom: 0, marginTop: 10, backgroundColor: cardBg, borderColor: cardBorder }}>
      <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: colors.mutedForeground }}>
        {result.partNumber}
      </Text>
      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
        Original: {result.originalDescription}
      </Text>
      {result.error ? (
        <Text style={{ fontSize: 12, color: colors.destructive, fontFamily: "Inter_400Regular" }}>
          ⚠ AI error — skipped
        </Text>
      ) : (
        <TextInput
          value={localText}
          onChangeText={setLocalText}
          onBlur={() => onTextBlur(result.id, localText)}
          multiline
          numberOfLines={2}
          maxLength={1000}
          editable={!isFinalised}
          style={{
            borderWidth: 1,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontSize: 13,
            fontFamily: "Inter_400Regular",
            minHeight: 60,
            textAlignVertical: "top",
            backgroundColor: isFinalised ? colors.muted : colors.background,
            borderColor: colors.border,
            color: result.savedStatus === "discarded" ? colors.mutedForeground : colors.foreground,
          }}
        />
      )}
      {!isFinalised ? (
        <View style={{ gap: 6 }}>
          {result.savedStatus === "error" ? (
            <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.destructive }}>
              ⚠ Save failed — tap to retry
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              onPress={() => onSave(result.id, localText)}
              disabled={result.savedStatus === "saving" || !localText.trim()}
              style={{
                flex: 1,
                borderRadius: 8,
                paddingVertical: 8,
                alignItems: "center",
                backgroundColor: (result.savedStatus === "saving" || !localText.trim()) ? colors.muted : colors.primary,
              }}
            >
              {result.savedStatus === "saving" ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={{ color: colors.primaryForeground, fontSize: 13, fontFamily: "Inter_700Bold" }}>
                  {result.savedStatus === "error" ? "Retry" : "Save"}
                </Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => onDiscard(result.id)}
              style={{ flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: "center", backgroundColor: colors.muted }}
            >
              <Text style={{ color: colors.mutedForeground, fontSize: 13, fontFamily: "Inter_700Bold" }}>Discard</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Text style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: result.savedStatus === "saved" ? colors.success : colors.mutedForeground }}>
          {result.savedStatus === "saved" ? "✓ Saved" : "— Discarded"}
        </Text>
      )}
    </View>
  );
});

// ── Main screen ───────────────────────────────────────────────────────────
export default function UploadScreen() {
  "use no memo";
  useTrackScreen("Upload");
  const { width: screenWidth } = useWindowDimensions();
  const isNarrow = screenWidth <= 320;
  const colors = useColors();
  const router = useRouter();
  const { isAdmin, logoutAdmin, adminToken, showToast } = useApp();
  const { status: apiStatus, restarting: apiRestarting, triggerRestart, checkStatus, bots: apiBots, probeSingleBot } = useApiStatus({
    apiBase: API_BASE,
    adminToken: isAdmin ? adminToken : null,
  });
  const apiCheckAnim = useRef(new Animated.Value(1)).current;
  const [apiChecking, setApiChecking] = useState(false);
  const [activeBadge, setActiveBadge] = useState<string | null>(null);
  const probingBotsRef = useRef<Set<string>>(new Set());
  const [probingBots, setProbingBots] = useState<Set<string>>(new Set());

  const reprobe = useCallback(async (botName: string) => {
    if (probingBotsRef.current.has(botName)) return;
    probingBotsRef.current.add(botName);
    setProbingBots(new Set(probingBotsRef.current));
    try {
      await probeSingleBot(botName);
    } finally {
      probingBotsRef.current.delete(botName);
      setProbingBots(new Set(probingBotsRef.current));
    }
  }, [probeSingleBot]);

  const [aiStatusBots, setAiStatusBots] = useState<Record<string, string>>({});
  const [aiStatusLoading, setAiStatusLoading] = useState(false);
  const [aiStatusError, setAiStatusError] = useState<string | null>(null);
  const [aiStatusProbing, setAiStatusProbing] = useState(false);

  const fetchAiStatus = useCallback(async () => {
    if (!adminToken || !API_BASE) return;
    setAiStatusLoading(true);
    setAiStatusError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/ai-status`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { bots: Record<string, string> };
      setAiStatusBots(data.bots ?? {});
    } catch (err) {
      setAiStatusError(err instanceof Error ? err.message : "Failed to load AI status");
    } finally {
      setAiStatusLoading(false);
    }
  }, [adminToken]);

  const triggerAiProbe = useCallback(async () => {
    if (!adminToken || !API_BASE || aiStatusProbing) return;
    setAiStatusProbing(true);
    setAiStatusError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/ai-status/probe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { bots: Record<string, string> };
      setAiStatusBots(data.bots ?? {});
    } catch (err) {
      setAiStatusError(err instanceof Error ? err.message : "Probe failed");
    } finally {
      setAiStatusProbing(false);
    }
  }, [adminToken, aiStatusProbing]);

  useEffect(() => {
    if (adminToken) {
      fetchAiStatus();
    }
  }, [adminToken, fetchAiStatus]);

  const handleRestartPress = useCallback(() => {
    Alert.alert(
      "Restart API server?",
      "The server will briefly go offline while it restarts.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Restart", style: "destructive", onPress: () => { triggerRestart(); } },
      ],
    );
  }, [triggerRestart]);

  const handleCheckPress = useCallback(async () => {
    const native = Platform.OS !== "web";
    Animated.sequence([
      Animated.timing(apiCheckAnim, { toValue: 0.82, duration: 100, useNativeDriver: native }),
      Animated.spring(apiCheckAnim, { toValue: 1, useNativeDriver: native, tension: 240, friction: 7 }),
    ]).start();
    setApiChecking(true);
    await checkStatus();
    setApiChecking(false);
  }, [apiCheckAnim, checkStatus]);

  const lidarSupported = isLiDARSupported();
  const [parsedRows, setParsedRows] = useState<Array<ParsedRow>>([]);
  const [rawCsv, setRawCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileType, setFileType] = useState<"csv" | "xlsx" | null>(null);
  const [enrichProgress, setEnrichProgress] = useState<EnrichProgress | null>(null);
  const [tab, setTab] = useState<"import" | "enrichment" | "addpart" | "query" | "users">("import");
  const [addpartScrollY, setAddpartScrollY] = useState(0);
  const [measureVisible, setMeasureVisible] = useState(false);
  const [measuredDims, setMeasuredDims] = useState<PartDimensions | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState<{ inserted: number; updated: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [inventoryPage, setInventoryPage] = useState(1);
  const [binEditorItem, setBinEditorItem] = useState<InventoryItem | null>(null);
  const [shelfEntryOpen, setShelfEntryOpen] = useState(false);
  const [bulkShelfOpen, setBulkShelfOpen] = useState(false);

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

  // Expand-descriptions enrichment state
  const [expandDescResults, setExpandDescResults] = useState<Array<ExpandDescResult>>([]);
  const [expandDescProgress, setExpandDescProgress] = useState<{ done: number; total: number } | null>(null);
  const [expandDescModel, setExpandDescModel] = useState<string | null>(null);
  const [expandDescStreamDone, setExpandDescStreamDone] = useState(false);
  const [expandDescRunning, setExpandDescRunning] = useState(false);
  const [expandDescError, setExpandDescError] = useState<string | null>(null);
  const [expandDescRemaining, setExpandDescRemaining] = useState<number | null>(null);
  const [expandDescDraftSavedAt, setExpandDescDraftSavedAt] = useState<number | null>(null);

  // SQL query tab state
  const [queryText, setQueryText] = useState("SELECT * FROM inventory LIMIT 20");
  const [queryRunning, setQueryRunning] = useState(false);
  const [queryResult, setQueryResult] = useState<{ columns: Array<string>; rows: Array<Record<string, unknown>>; rowCount: number } | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryExportPending, setQueryExportPending] = useState<"csv" | "xlsx" | null>(null);
  const [queryHelpOpen, setQueryHelpOpen] = useState(false);

  // User management tab state
  const [usersData, setUsersData] = useState<Array<import("@/utils/adminUserActions").UserRow>>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userActionPending, setUserActionPending] = useState<string | null>(null);

  // Bin diff / replace-warning state
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Floor plan upload state (admin-only)
  const [floorPlanFile, setFloorPlanFile] = useState<{ name: string; uri: string } | null>(null);
  const [floorPlanUploading, setFloorPlanUploading] = useState(false);
  const [floorPlanResult, setFloorPlanResult] = useState<{ success: boolean; message: string } | null>(null);

  const [binDiff, setBinDiff] = useState<BinDiffSummary | null>(null);
  const [binDiffPending, setBinDiffPending] = useState(false);
  const [binDiffFailed, setBinDiffFailed] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [skipBinRows, setSkipBinRows] = useState<Set<number>>(new Set());
  const [replaceListOpen, setReplaceListOpen] = useState(false);
  const [replaceListSearch, setReplaceListSearch] = useState("");

  const inventoryQuery = useListInventory({ page: inventoryPage, limit: 50 });

  // Build admin auth headers for protected API calls
  const adminHeaders = useMemo<Record<string, string>>(
    () => (adminToken ? { Authorization: `Bearer ${adminToken}` } : {} as Record<string, string>),
    [adminToken],
  );

  // Keep a ref so interval callbacks always see the current token
  const adminTokenRef = useRef(adminToken);
  useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);

  // SSE reader refs — cancelled on unmount to prevent setState on unmounted component
  const enrichReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const expandDescReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  // Abort flags — set true by the unmount cleanup so catch/finally blocks know
  // not to call setState after the component has been torn down.
  const enrichAbortedRef = useRef(false);
  const expandDescAbortedRef = useRef(false);
  useEffect(() => {
    return () => {
      enrichAbortedRef.current = true;
      enrichReaderRef.current?.cancel().catch(() => {});
      expandDescAbortedRef.current = true;
      expandDescReaderRef.current?.cancel().catch(() => {});
    };
  }, []);
  const pasteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-fetch bin-diff preview whenever the raw CSV changes so admins
  // see a replace-warning before they can press Upload.
  // Uses POST /api/admin/upload/preview (raw CSV text) — the same endpoint
  // that the final upload will use, so the diff is always accurate.
  // Preview is a HARD precondition for upload — if it fails, upload is blocked
  // and the admin must retry (pick file again) or re-authenticate.
  // An AbortController cancels any in-flight request when rawCsv or token
  // change, preventing stale responses from overwriting state for a newer file.
  useEffect(() => {
    if (!rawCsv || parsedRows.length === 0) {
      setBinDiff(null);
      setBinDiffFailed(false);
      setReplaceConfirmed(false);
      setSkipBinRows(new Set());
      setReplaceListOpen(false);
      return;
    }
    if (!adminToken) return;
    const controller = new AbortController();
    setBinDiffPending(true);
    setBinDiffFailed(false);
    setBinDiff(null);
    const token = adminToken;
    fetch(`${API_BASE}/admin/upload/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      signal: controller.signal,
      body: JSON.stringify({ csv: rawCsv }),
    })
      .then(async r => {
        if (r.status === 401) {
          logoutAdmin();
          setUploadError("Admin session expired. Please unlock again.");
          setBinDiffFailed(true);
          return;
        }
        if (!r.ok) throw new Error("preview failed");
        const binParsed = BinDiffSummarySchema.safeParse(await r.json());
        if (!binParsed.success) { console.warn("[upload] bin-diff unexpected shape:", binParsed.error.message); setBinDiffFailed(true); setUploadError("Unexpected response from server — please try again."); return; }
        const data = binParsed.data as BinDiffSummary;
        setBinDiff(data);
        setBinDiffFailed(false);
        setReplaceConfirmed(false);
        setSkipBinRows(new Set());
        setReplaceListOpen(false);
      })
      .catch(err => {
        // Ignore abort errors — the effect re-ran with new data
        if (err instanceof Error && err.name === "AbortError") return;
        setBinDiff(null);
        setBinDiffFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBinDiffPending(false);
      });
    return () => {
      controller.abort();
    };
  }, [rawCsv, parsedRows.length, adminToken, logoutAdmin]);

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
      const parsed = EnrichSummarySchema.safeParse(await res.json());
      if (!parsed.success) { console.warn("[upload] fetchEnrichSummary unexpected shape:", parsed.error.message); return; }
      const data = parsed.data;
      setEnrichSummary(data);
    } catch (err) {
      console.error('[upload] fetchEnrichSummary', err);
    }
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
      const parsed = BulkJobStatusSchema.safeParse(await res.json());
      if (!parsed.success) { console.warn("[upload] pollBulkStatus unexpected shape:", parsed.error.message); return; }
      const data = parsed.data;
      setBulkJobStatus(data);
      if (data.running) {
        void fetchEnrichSummary();
      } else {
        stopBulkPoll();
        void fetchEnrichSummary();
      }
    } catch (err) {
      console.error('[upload] pollBulkStatus', err);
    }
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
      const parsed = MeasureJobStatusSchema.safeParse(await res.json());
      if (!parsed.success) { console.warn("[upload] pollMeasureStatus unexpected shape:", parsed.error.message); return; }
      const data = parsed.data;
      setMeasureJobStatus(data);
      if (data.running) {
        void fetchEnrichSummary();
      } else {
        stopMeasurePoll();
        void fetchEnrichSummary();
      }
    } catch (err) {
      console.error('[upload] pollMeasureStatus', err);
    }
  }, [stopMeasurePoll, fetchEnrichSummary, logoutAdmin]);

  const startMeasurePoll = useCallback(() => {
    stopMeasurePoll();
    void pollMeasureStatus();
    measurePollRef.current = setInterval(pollMeasureStatus, 2000);
  }, [stopMeasurePoll, pollMeasureStatus]);

  const handleQueryExport = useCallback(async (format: "csv" | "xlsx") => {
    if (!adminToken || queryExportPending || !queryText.trim()) return;
    setQueryExportPending(format);
    try {
      const res = await fetch(`${API_BASE}/admin/query?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ sql: queryText }),
      });
      if (res.status === 401) {
        logoutAdmin();
        return;
      }
      if (!res.ok) {
        setQueryError(`Export failed: HTTP ${res.status}`);
        return;
      }

      const blob = await res.blob();
      const filename = `query-results.${format}`;

      if (Platform.OS === "web") {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const arrayBuffer = await blob.arrayBuffer();
        const file = new FsFile(FsPaths.cache, filename);
        await file.write(new Uint8Array(arrayBuffer));
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(file.uri, {
            mimeType: format === "csv"
              ? "text/csv"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            dialogTitle: `Export ${format.toUpperCase()}`,
          });
        }
      }
    } catch (err) {
      console.error('[upload] handleQueryExport', err);
      setQueryError('Export failed — check your connection and try again.');
    } finally {
      setQueryExportPending(null);
    }
  }, [adminToken, queryExportPending, queryText, logoutAdmin]);

  // On admin login, load coverage summary and check if jobs are already running.
  // On admin logout (isAdmin → false), stop any active polling immediately.
  useEffect(() => {
    if (!isAdmin) {
      stopBulkPoll();
      stopMeasurePoll();
      return;
    }
    setUploadError(null);
    setBulkEnrichError(null);
    setMeasureEnrichError(null);
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
          const bulkParsed = BulkJobStatusSchema.safeParse(await bulkRes.json());
          if (bulkParsed.success) {
            setBulkJobStatus(bulkParsed.data);
            if (bulkParsed.data.running) startBulkPoll();
          }
        }
        if (measureRes.ok) {
          const measureParsed = MeasureJobStatusSchema.safeParse(await measureRes.json());
          if (measureParsed.success) {
            setMeasureJobStatus(measureParsed.data);
            if (measureParsed.data.running) startMeasurePoll();
          }
        }
      } catch (err) {
        console.error('[upload] load initial job status', err);
        setUploadError("Could not load enrichment status. Check your connection.");
      }
    })();
  }, [isAdmin, fetchEnrichSummary, startBulkPoll, stopBulkPoll, startMeasurePoll, stopMeasurePoll, logoutAdmin]);

  // Clean up polling on unmount
  useEffect(() => () => {
    stopBulkPoll();
    stopMeasurePoll();
    if (pasteDebounceRef.current) clearTimeout(pasteDebounceRef.current);
  }, [stopBulkPoll, stopMeasurePoll]);

  const handleStartBulkEnrich = async (force = false) => {
    setBulkEnrichError(null);
    setBulkEnrichPending(true);
    try {
      const res = await fetch(`${API_BASE}/inventory/bulk-enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({ force }),
      });
      if (res.status === 409) {
        const p409 = BulkJobWrapperSchema.safeParse(await res.json());
        if (p409.success) setBulkJobStatus(p409.data.job);
        startBulkPoll();
        return;
      }
      if (!res.ok) {
        const errParsed = ApiErrorSchema.safeParse(await res.json().catch(() => ({})));
        setBulkEnrichError(errParsed.success ? (errParsed.data.error ?? "Failed to start bulk enrichment") : "Failed to start bulk enrichment");
        return;
      }
      const pOk = BulkJobWrapperSchema.safeParse(await res.json());
      if (!pOk.success) { console.warn("[upload] bulk-enrich start unexpected shape:", pOk.error.message); setBulkEnrichError("Unexpected response from server — please try again."); return; }
      setBulkJobStatus(pOk.data.job);
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
        const pStop = BulkJobWrapperSchema.safeParse(await res.json());
        if (pStop.success) setBulkJobStatus(pStop.data.job);
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
        const p409m = MeasureJobWrapperSchema.safeParse(await res.json());
        if (p409m.success) setMeasureJobStatus(p409m.data.job);
        startMeasurePoll();
        return;
      }
      if (!res.ok) {
        const errParsedM = ApiErrorSchema.safeParse(await res.json().catch(() => ({})));
        setMeasureEnrichError(errParsedM.success ? (errParsedM.data.error ?? "Failed to start measurement enrichment") : "Failed to start measurement enrichment");
        return;
      }
      const pOkM = MeasureJobWrapperSchema.safeParse(await res.json());
      if (!pOkM.success) { console.warn("[upload] measure-enrich start unexpected shape:", pOkM.error.message); setMeasureEnrichError("Unexpected response from server — please try again."); return; }
      setMeasureJobStatus(pOkM.data.job);
      startMeasurePoll();
    } catch {
      setMeasureEnrichError("Failed to start measurement enrichment. Check your connection and try again.");
    } finally {
      setMeasureEnrichPending(false);
    }
  };

  const handleStartExpandDescriptions = async (extraHeaders?: Record<string, string>) => {
    expandDescAbortedRef.current = false;
    AsyncStorage.removeItem(EXPAND_DESC_DRAFT_KEY).catch(() => {});
    setExpandDescDraftSavedAt(null);
    setExpandDescRunning(true);
    setExpandDescError(null);
    setExpandDescResults([]);
    setExpandDescProgress(null);
    setExpandDescModel(null);
    setExpandDescStreamDone(false);
    setExpandDescRemaining(null);

    try {
      const response = await fetch(`${API_BASE}/inventory/expand-descriptions`, {
        method: "POST",
        headers: { ...adminHeaders, ...extraHeaders },
      });

      if (!response.ok) {
        if (response.status === 401) {
          logoutAdmin();
          setUploadError("Admin session expired. Please unlock again.");
          return;
        }
        const errParsedED = ApiErrorSchema.safeParse(await response.json().catch(() => ({})));
        setExpandDescError(errParsedED.success ? (errParsedED.data.error ?? "Failed to start expansion") : "Failed to start expansion");
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        setExpandDescError("Export failed — no response body. Please try again.");
        return;
      }

      expandDescReaderRef.current = reader;
      let sseBuffer = "";
      let poeChainExhausted = false;

      const processLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        try {
          const rawData: unknown = JSON.parse(line.slice(6));
          const parsedData = SseExpandDescDataSchema.safeParse(rawData);
          if (!parsedData.success) { console.warn("[upload] SSE expand-desc unexpected shape:", parsedData.error.message); return; }
          const data = parsedData.data;
          if (data.status === "poe_chain_exhausted") {
            poeChainExhausted = true;
            return;
          }
          if (data.model != null && data.id == null && !data.done) {
            setExpandDescModel(data.model);
            if (data.total != null) {
              setExpandDescProgress({ done: 0, total: data.total });
            }
          } else if (data.done) {
            setExpandDescStreamDone(true);
            setExpandDescRemaining(data.remaining ?? null);
            setExpandDescProgress({ done: data.processed ?? 0, total: data.total ?? 0 });
          } else if (data.id != null) {
            setExpandDescResults(prev => [...prev, {
              id: data.id!,
              partNumber: data.partNumber ?? "",
              originalDescription: data.originalDescription ?? "",
              expandedDescription: data.expandedDescription ?? null,
              editedText: data.expandedDescription ?? "",
              savedStatus: data.error ? "discarded" : "pending",
              error: data.error,
            }]);
            if (data.progress != null && data.total != null) {
              setExpandDescProgress({ done: data.progress, total: data.total });
            }
          }
        } catch (err) { console.warn('[expandDesc] SSE parse error', line, err); }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line.trim());
      }
      if (sseBuffer.trim()) processLine(sseBuffer.trim());

      if (poeChainExhausted && !extraHeaders?.["x-use-openai-fallback"]) {
        Alert.alert(
          "AI Unavailable",
          "All AI bots are currently unavailable. Retry using OpenAI instead?",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Use OpenAI",
              onPress: () => handleStartExpandDescriptions({ "x-use-openai-fallback": "true" }),
            },
          ],
        );
      }

      expandDescReaderRef.current = null;
    } catch {
      if (!expandDescAbortedRef.current) {
        setExpandDescError("Failed to expand descriptions. Check your connection and try again.");
      }
      expandDescReaderRef.current = null;
    } finally {
      if (!expandDescAbortedRef.current) {
        setExpandDescRunning(false);
      }
    }
  };

  const handleSaveExpandResult = useCallback(async (id: number, text: string) => {
    setExpandDescResults(prev =>
      prev.map(r => r.id === id ? { ...r, savedStatus: "saving" } : r),
    );
    try {
      const res = await fetch(`${API_BASE}/inventory/${id}/expanded-description`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...adminHeaders },
        body: JSON.stringify({ expandedDescription: text.trim() || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setExpandDescResults(prev =>
        prev.map(r => r.id === id ? { ...r, savedStatus: "saved", editedText: text } : r),
      );
    } catch {
      setExpandDescResults(prev =>
        prev.map(r => r.id === id ? { ...r, savedStatus: "error" } : r),
      );
    }
  }, [adminHeaders]);

  const handleDiscardExpandResult = useCallback((id: number) => {
    setExpandDescResults(prev =>
      prev.map(r => r.id === id ? { ...r, savedStatus: "discarded" } : r),
    );
  }, []);

  const handleTextBlur = useCallback((id: number, text: string) => {
    setExpandDescResults(prev =>
      prev.map(r => r.id === id ? { ...r, editedText: text } : r),
    );
  }, []);

  const handleSaveAll = async () => {
    await runSaveAll(
      expandDescResults,
      expandDescRunning,
      (id, status) =>
        setExpandDescResults(prev =>
          prev.map(r => r.id === id ? { ...r, savedStatus: status } : r),
        ),
      API_BASE,
      adminHeaders,
    );
  };

  const handleDiscardAll = () => {
    setExpandDescResults(prev => applyDiscardAll(prev, expandDescRunning));
  };

  const handleClearExpandDescDraft = useCallback(() => {
    AsyncStorage.removeItem(EXPAND_DESC_DRAFT_KEY).catch(() => {});
    setExpandDescResults([]);
    setExpandDescStreamDone(false);
    setExpandDescModel(null);
    setExpandDescRemaining(null);
    setExpandDescDraftSavedAt(null);
  }, []);

  // Load draft on mount
  useEffect(() => {
    AsyncStorage.getItem(EXPAND_DESC_DRAFT_KEY).then(raw => {
      if (!raw) return;
      try {
        const draft: ExpandDescDraft = JSON.parse(raw);
        const pending = draft.results.filter(
          r => r.savedStatus === "pending" || r.savedStatus === "saving",
        ).map(r => r.savedStatus === "saving" ? { ...r, savedStatus: "pending" as const } : r);
        if (pending.length === 0) {
          AsyncStorage.removeItem(EXPAND_DESC_DRAFT_KEY).catch(() => {});
          return;
        }
        setExpandDescResults(pending);
        setExpandDescStreamDone(draft.streamDone);
        setExpandDescModel(draft.model);
        setExpandDescRemaining(draft.remaining);
        setExpandDescDraftSavedAt(draft.savedAt);
      } catch { /* ignore corrupt draft */ }
    }).catch(() => {});
  }, []);

  // Save draft whenever results change (auto-clear when all resolved)
  useEffect(() => {
    if (expandDescResults.length === 0) return;
    const hasPending = expandDescResults.some(
      r => r.savedStatus === "pending" || r.savedStatus === "saving",
    );
    if (!hasPending) {
      AsyncStorage.removeItem(EXPAND_DESC_DRAFT_KEY).catch(() => {});
      setExpandDescDraftSavedAt(null);
      return;
    }
    const draft: ExpandDescDraft = {
      results: expandDescResults,
      streamDone: expandDescStreamDone,
      model: expandDescModel,
      remaining: expandDescRemaining,
      savedAt: Date.now(),
    };
    AsyncStorage.setItem(EXPAND_DESC_DRAFT_KEY, JSON.stringify(draft)).catch(() => {});
  }, [expandDescResults, expandDescStreamDone, expandDescModel, expandDescRemaining]);

  const handlePickFile = async () => {
    setPasteText("");
    if (pasteDebounceRef.current) clearTimeout(pasteDebounceRef.current);
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
      let rows: Array<ParsedRow> = [];
      // rawText holds the CSV string that will be sent to the admin upload
      // endpoint. For CSV/TXT files this is the file's raw text. For XLSX/ODS
      // files the parsed rows are serialized back to CSV so the server-side
      // parser sees the same data.
      let rawText: string | null = null;

      if (ext === "csv" || ext === "txt") {
        const response = await fetch(asset.uri);
        if (!response.ok) throw new Error(`Failed to read file: ${response.status}`);
        const text = await response.text();
        rows = parseCSV(text);
        // Normalize through serializeToCsv so the server always receives a
        // canonical header row (Vendor,Catalog,Description,BinLocation) even
        // when the source file used broad client-side aliases like "mfr",
        // "part#", etc. that the server-side parser wouldn't recognise.
        rawText = serializeToCsv(rows, new Set());
        setFileType("csv");
      } else if (["xlsx", "xlsm"].includes(ext)) {
        rows = await parseXlsx(asset.uri);
        // Serialize to CSV so we can send it to admin/upload/preview and
        // admin/upload which only accept raw CSV text. skipBinRows is empty
        // at this point (file just loaded), so all bin data is included.
        rawText = serializeToCsv(rows, new Set());
        setFileType("xlsx");
      } else {
        try {
          const response = await fetch(asset.uri);
          if (!response.ok) throw new Error(`Failed to read file: ${response.status}`);
          const text = await response.text();
          rows = parseCSV(text);
          rawText = serializeToCsv(rows, new Set());
          setFileType("csv");
        } catch {
          rows = await parseXlsx(asset.uri);
          rawText = serializeToCsv(rows, new Set());
          setFileType("xlsx");
        }
      }

      if (rows.length === 0) {
        setUploadError("No data rows found. Ensure your file has columns named: vendor, catalog (required), description, bin (optional).");
        return;
      }
      setUploadError(null);
      setUploadSuccess(null);
      setRawCsv(rawText);
      setParsedRows(rows);
    } catch {
      setUploadError("Failed to read file. Please try again.");
    }
  };

  const handlePasteChange = useCallback((text: string) => {
    setPasteText(text);
    setFileName(null);
    setFileType(null);
    if (pasteDebounceRef.current) clearTimeout(pasteDebounceRef.current);
    if (!text.trim()) {
      setParsedRows([]);
      setRawCsv(null);
      return;
    }
    pasteDebounceRef.current = setTimeout(() => {
      const rows = parseCSV(text);
      if (rows.length === 0) {
        setUploadError("No data rows found. Ensure the text has columns: vendor, catalog (required), description, bin (optional).");
        setParsedRows([]);
        setRawCsv(null);
        return;
      }
      setUploadError(null);
      setUploadSuccess(null);
      setParsedRows(rows);
      setRawCsv(serializeToCsv(rows, new Set()));
    }, 400);
  }, []);

  const handleUpload = async () => {
    if (!parsedRows.length || !rawCsv) return;
    // Defensive guard: never commit an upload if the preview hasn't successfully
    // loaded. The UI already keeps the button disabled in this state, but this
    // guard adds a function-level safety net in case of unexpected state drift.
    if (binDiffPending || binDiffFailed || binDiff === null) return;
    setUploadError(null);
    setUploadSuccess(null);
    setUploadPending(true);
    try {
      // Build the CSV to submit. For rows where the admin toggled "skip bin
      // update" we rebuild the CSV with those bin cells blanked so the server
      // preserves the existing assignment instead of overwriting it.
      // When no rows are skipped we send the original raw CSV unchanged.
      const csvToSubmit = skipBinRows.size > 0
        ? serializeToCsv(parsedRows, skipBinRows)
        : rawCsv;

      const response = await fetch(`${API_BASE}/admin/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeaders,
        },
        body: JSON.stringify({ csv: csvToSubmit }),
      });

      if (!response.ok) {
        const bodyParsed = ApiErrorSchema.safeParse(await response.json().catch(() => ({})));
        if (response.status === 401) {
          logoutAdmin();
          setUploadError("Admin session expired. Please unlock again.");
        } else {
          setUploadError(bodyParsed.success ? (bodyParsed.data.error ?? "Upload failed — could not save inventory items. Please try again.") : "Upload failed — could not save inventory items. Please try again.");
        }
        return;
      }

      const resultParsed = UploadResultSchema.safeParse(await response.json());
      if (!resultParsed.success) { console.warn("[upload] upload result unexpected shape:", resultParsed.error.message); setUploadError("Unexpected response from server — please try again."); return; }
      const result = resultParsed.data;
      setUploadSuccess({ inserted: result.inserted, updated: result.updated, total: result.total });
      setParsedRows([]);
      setRawCsv(null);
      setFileName(null);
      setFileType(null);
      setPasteText("");
      await inventoryQuery.refetch();
    } catch {
      setUploadError("Upload failed — could not save inventory items. Please try again.");
    } finally {
      setUploadPending(false);
    }
  };

  const handleEnrich = async (idsToEnrich?: Array<number>) => {
    enrichAbortedRef.current = false;
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
        const errBodyParsed = ApiErrorSchema.safeParse(await response.json().catch(() => ({})));
        if (response.status === 401) {
          logoutAdmin();
          setUploadError("Admin session expired. Please unlock again.");
        } else {
          setUploadError(errBodyParsed.success ? (errBodyParsed.data.error ?? "AI enrichment failed — please check your connection and try again.") : "AI enrichment failed — please check your connection and try again.");
        }
        setEnrichProgress(null);
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        setUploadError("Enrichment failed — no response body. Please try again.");
        setEnrichProgress(null);
        return;
      }

      enrichReaderRef.current = reader;
      // Buffer partial lines across chunk boundaries so we never try to parse
      // an incomplete "data: ..." SSE line.
      let sseBuffer = "";
      const processLine = async (line: string) => {
        if (!line.startsWith("data: ")) return;
        try {
          const data: EnrichProgress = JSON.parse(line.slice(6));
          setEnrichProgress(data);
          if (data.done) await inventoryQuery.refetch();
        } catch (err) {
          console.error('[upload] processLine SSE', err);
        }
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
      enrichReaderRef.current = null;
    } catch {
      if (!enrichAbortedRef.current) {
        setUploadError("AI enrichment failed — please check your connection and try again.");
        setEnrichProgress(null);
      }
      enrichReaderRef.current = null;
    }
  };

  const handleExportCsv = async () => {
    setExportPending(true);
    setExportError(null);
    try {
      const pageSize = 200;
      let page = 1;
      let allItems: Array<InventoryItem> = [];
      let total = Infinity;
      let maxPages = Infinity;
      let pagesFetched = 0;

      while (allItems.length < total) {
        if (pagesFetched >= maxPages) {
          console.warn("[handleExportCsv] page cap reached — aborting export", { page, pagesFetched, maxPages, total });
          throw new Error("Export aborted — unexpected server response. Please try again.");
        }
        const url = `${API_BASE}/inventory?page=${page}&limit=${pageSize}`;
        const res = await fetch(url, { headers: adminHeaders });
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const data: { items: Array<InventoryItem>; total: number } = await res.json();
        total = data.total;
        if (maxPages === Infinity) {
          maxPages = Math.ceil(total / pageSize) + 1;
        }
        allItems = allItems.concat(data.items);
        pagesFetched++;
        if (data.items.length < pageSize) break;
        page++;
      }

      const csvContent = serializeInventoryToCsv(allItems);
      const exportFileName = `inventory-export-${new Date().toISOString().slice(0, 10)}.csv`;

      if (Platform.OS === "web") {
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = exportFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const file = new FsFile(FsPaths.cache, exportFileName);
        await file.write(csvContent);
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(file.uri, {
            mimeType: "text/csv",
            dialogTitle: "Export Inventory CSV",
            UTI: "public.comma-separated-values-text",
          });
        }
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportPending(false);
    }
  };

  // ── Floor plan upload handlers ─────────────────────────────────────────────
  const handlePickFloorPlan = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["image/svg+xml", "text/plain", "*/*"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setFloorPlanFile({ name: asset.name, uri: asset.uri });
    setFloorPlanResult(null);
  };

  const handleUploadFloorPlan = async () => {
    if (!floorPlanFile) return;
    setFloorPlanUploading(true);
    setFloorPlanResult(null);
    try {
      const content = await fetch(floorPlanFile.uri).then(r => r.text());
      const token = adminTokenRef.current;
      if (!token) {
        setFloorPlanResult({ success: false, message: "Admin session expired — please lock and unlock again" });
        return;
      }
      const res = await fetch(`${API_BASE}/admin/floor-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ svg: content }),
      });
      if (!res.ok) {
        const fpParsed = ApiErrorSchema.safeParse(await res.json().catch(() => ({ error: "Upload failed" })));
        setFloorPlanResult({ success: false, message: fpParsed.success ? (fpParsed.data.error ?? "Upload failed") : "Upload failed" });
      } else {
        setFloorPlanResult({ success: true, message: "Floor plan uploaded — the app will use the new plan on next launch." });
        setFloorPlanFile(null);
      }
    } catch {
      setFloorPlanResult({ success: false, message: "Network error — check connection and try again" });
    } finally {
      setFloorPlanUploading(false);
    }
  };

  const inventory = inventoryQuery.data?.items ?? [];
  const inventoryTotal = inventoryQuery.data?.total ?? 0;

  const TAB_LABELS: Record<"import" | "enrichment" | "addpart" | "query" | "users", string> = {
    import: "Import",
    enrichment: `Enrich (${inventoryTotal})`,
    addpart: "Add Part / Barcode",
    query: "Ask Database",
    users: "Users",
  };

  const fetchUsers = async () => {
    if (!adminToken) return;
    await fetchAdminUsers({ apiBase: API_BASE, adminToken, setUsersLoading, setUsersError, setUsersData });
  };

  const handleUserAction = async (
    clerkUserId: string,
    action: import("@/utils/adminUserActions").UserAction,
  ) => {
    if (!adminToken) return;
    await runUserAction(clerkUserId, action, {
      apiBase: API_BASE,
      adminToken,
      userActionPending,
      setUserActionPending,
      showToast,
      fetchUsers,
    });
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <View style={{ flexShrink: 0 }}>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>📤 Inventory</Text>
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>Upload & AI Enrich</Text>
          </View>
          {isAdmin ? (
            <View style={styles.headerActions}>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                <Animated.View style={{ transform: [{ scale: apiCheckAnim }] }}>
                  <Pressable
                    onPress={handleCheckPress}
                    onLongPress={handleRestartPress}
                    style={[
                      styles.apiStatusPill,
                      {
                        backgroundColor:
                          apiRestarting || apiChecking
                            ? "#6b7280"
                            : apiStatus === "ok"
                            ? "#10b981"
                            : apiStatus === "degraded"
                            ? "#f59e0b"
                            : apiStatus === "error"
                            ? "#ef4444"
                            : "#6b7280",
                      },
                    ]}
                  >
                    <Text style={styles.apiStatusPillText}>
                      {apiRestarting
                        ? "⟳ Restarting…"
                        : apiStatus === "ok"
                        ? "● API: ok"
                        : apiStatus === "degraded"
                        ? "● API: degraded"
                        : apiStatus === "error"
                        ? "● API: error"
                        : "● API: …"}
                    </Text>
                  </Pressable>
                </Animated.View>
                {Object.keys(apiBots).length > 0 ? (
                  <View>
                    <View style={styles.botStatusRow}>
                      {Object.entries(apiBots).map(([name, botStatus]) => {
                        const dotColor =
                          botStatus === "ok"
                            ? "#10b981"
                            : botStatus === "timeout"
                            ? "#f59e0b"
                            : "#ef4444";
                        const isProbing = probingBots.has(name);
                        if (isNarrow) {
                          return (
                            <Pressable
                              key={name}
                              onPress={() => {
                                setActiveBadge(activeBadge === name ? null : name);
                                reprobe(name);
                              }}
                              style={[
                                styles.botStatusBadge,
                                { backgroundColor: isProbing ? "#6b7280" : dotColor },
                                activeBadge === name && styles.botStatusBadgeActive,
                              ]}
                              accessibilityLabel={`${name}: ${isProbing ? "probing" : botStatus}`}
                              accessibilityRole="button"
                            />
                          );
                        }
                        return (
                          <Pressable
                            key={name}
                            onPress={() => reprobe(name)}
                            style={[
                              styles.botStatusChip,
                              {
                                backgroundColor: dotColor + "20",
                                borderColor: dotColor,
                              },
                            ]}
                            accessibilityLabel={`${name}: ${isProbing ? "probing" : botStatus}. Tap to re-probe.`}
                            accessibilityRole="button"
                          >
                            {isProbing ? (
                              <ActivityIndicator size="small" color={dotColor} />
                            ) : (
                              <Text style={[styles.botStatusDot, { color: dotColor }]}>●</Text>
                            )}
                            <Text
                              style={[styles.botStatusText, { color: colors.foreground }]}
                              numberOfLines={1}
                            >
                              {name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {isNarrow && activeBadge !== null && apiBots[activeBadge] !== undefined ? (
                      <View
                        style={[
                          styles.botStatusPopover,
                          { backgroundColor: colors.card, borderColor: colors.border },
                        ]}
                      >
                        <Text
                          style={[styles.botStatusPopoverName, { color: colors.foreground }]}
                          numberOfLines={2}
                        >
                          {activeBadge}
                        </Text>
                        <Text style={[styles.botStatusPopoverStatus, {
                          color:
                            apiBots[activeBadge] === "ok"
                              ? "#10b981"
                              : apiBots[activeBadge] === "timeout"
                              ? "#f59e0b"
                              : "#ef4444",
                        }]}>
                          {apiBots[activeBadge]}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      </View>

      {/* Admin gate — inventory tools are restricted to admin-role users */}
      {!isAdmin ? (
        <AdminRestricted colors={colors} />
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
                Upload complete — inserted {uploadSuccess.inserted}, updated {uploadSuccess.updated} ({uploadSuccess.total} total)
              </Text>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                <Pressable onPress={() => { setUploadSuccess(null); setTab("enrichment"); }}>
                  <Text style={{ color: "#059669", fontSize: 12, fontFamily: "Inter_600SemiBold" }}>View →</Text>
                </Pressable>
                <Pressable onPress={() => setUploadSuccess(null)} style={styles.bannerClose}>
                  <Text style={{ color: "#059669", fontSize: 14 }}>✕</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {/* Tab bar */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.tabBar, { borderBottomColor: colors.border }]} contentContainerStyle={{ flexDirection: "row" }}>
            {(["import", "enrichment", "addpart", "query", "users"] as const).map(t => (
              <Pressable
                key={t}
                onPress={() => {
                  setTab(t);
                  if (t === "users") fetchUsers();
                }}
                style={[
                  styles.tabItem,
                  { borderBottomColor: tab === t ? colors.primary : "transparent" },
                ]}
              >
                <Text style={[styles.tabLabel, { color: tab === t ? colors.primary : colors.mutedForeground }]}>
                  {TAB_LABELS[t]}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {tab === "import" ? (
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
              {/* File upload card */}
              <View style={[styles.uploadCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>📁 Import File</Text>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  Accepts: CSV, Excel (.xlsx/.xlsm){"\n"}
                  Required columns: vendor, catalog{"\n"}
                  Optional: description, bin (or binLocation), barcodes (upc/ean/gtin){"\n"}
                  Multiple bins per row: separate with ; or |{"\n"}
                  Multiple barcodes per row: separate with , ; or |
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

                {/* Paste input */}
                <View style={styles.pasteDivider}>
                  <View style={[styles.pasteDividerLine, { backgroundColor: colors.border }]} />
                  <Text style={[styles.pasteDividerLabel, { backgroundColor: colors.card, color: colors.mutedForeground }]}>or</Text>
                </View>
                <Text style={[styles.pasteLabel, { color: colors.mutedForeground }]}>
                  Paste rows from a spreadsheet
                </Text>
                <View style={styles.pasteInputWrapper}>
                  <KeyboardDoneInput
                    value={pasteText}
                    onChangeText={handlePasteChange}
                    placeholder={"Vendor,Catalog,Description,BinLocation\nEATON,BR120,1 Pole Breaker,A1"}
                    placeholderTextColor={colors.mutedForeground}
                    multiline
                    scrollEnabled
                    style={[styles.pasteInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                    autoCorrect={false}
                    autoCapitalize="none"
                    textAlignVertical="top"
                  />
                  {pasteText.length > 0 ? (
                    <Pressable
                      onPress={() => handlePasteChange("")}
                      style={[styles.pasteClearBtn, { backgroundColor: colors.mutedForeground + "33" }]}
                      hitSlop={8}
                    >
                      <Text style={[styles.pasteClearBtnText, { color: colors.mutedForeground }]}>✕</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              {/* Preview */}
              {parsedRows.length > 0 ? (
                <View style={[styles.previewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                    Preview ({parsedRows.length} rows)
                  </Text>

                  {(() => {
                    const hasBarcodes = parsedRows.some(r => r.barcodes.length > 0);
                    return (
                      <>
                        <View style={[styles.previewHeaderRow, { backgroundColor: colors.muted }]}>
                          {["VENDOR", "CATALOG", "DESCRIPTION", "BIN"].map(h => (
                            <Text
                              key={h}
                              style={[styles.previewHeaderCell, { color: colors.mutedForeground, flex: h === "DESCRIPTION" ? 2 : 1 }]}
                            >
                              {h}
                            </Text>
                          ))}
                          {hasBarcodes ? (
                            <Text style={[styles.previewHeaderCell, { color: colors.mutedForeground, flex: 1 }]}>
                              BARCODES
                            </Text>
                          ) : null}
                          <Text style={[styles.previewHeaderCell, { color: colors.mutedForeground, width: 44, textAlign: "center" }]}>
                            SKIP
                          </Text>
                        </View>

                        {parsedRows.slice(0, 8).map((row, i) => {
                          const diffRow = binDiff?.rows[i];
                          const isReplace = diffRow?.status === "replace";
                          const isBarcodeReplace = diffRow?.barcodeStatus === "replace";
                          const isBarcodeConflict = diffRow?.barcodeStatus === "conflict";
                          const isSkipped = skipBinRows.has(i);
                          const rowBg = isBarcodeConflict
                            ? colors.destructive + "18"
                            : (isReplace && !isSkipped) || isBarcodeReplace
                              ? colors.warning + "18"
                              : undefined;
                          return (
                            <View key={i} style={[styles.previewRow, { borderBottomColor: colors.border, backgroundColor: rowBg }]}>
                              <Text style={[styles.previewCell, { color: colors.foreground, flex: 1 }]} numberOfLines={1}>
                                {row.vendor}
                              </Text>
                              <Text style={[styles.previewCell, { color: colors.primary, flex: 1 }]} numberOfLines={1}>
                                {row.catalog}
                              </Text>
                              <Text style={[styles.previewCell, { color: colors.mutedForeground, flex: 2 }]} numberOfLines={1}>
                                {row.description}
                              </Text>
                              <View style={{ flex: 1 }}>
                                {isReplace && !isSkipped ? (
                                  <>
                                    <Text style={[styles.previewCell, { color: colors.warning, textDecorationLine: "line-through", fontSize: 10 }]} numberOfLines={1}>
                                      {diffRow.existingBins.join(", ")}
                                    </Text>
                                    <Text style={[styles.previewCell, { color: colors.foreground }]} numberOfLines={1}>
                                      {row.binLocations.join(", ")}
                                    </Text>
                                  </>
                                ) : (
                                  <Text style={[styles.previewCell, { color: isSkipped ? colors.mutedForeground : colors.foreground }]} numberOfLines={1}>
                                    {isSkipped ? "(kept)" : row.binLocations.join(", ")}
                                  </Text>
                                )}
                              </View>
                              {hasBarcodes ? (
                                <View style={{ flex: 1 }}>
                                  {isBarcodeConflict ? (
                                    <>
                                      <Text style={[styles.previewCell, { color: colors.destructive, fontSize: 10, fontFamily: "Inter_600SemiBold" }]} numberOfLines={1}>
                                        ✕ conflict
                                      </Text>
                                      {diffRow?.conflictingItem ? (
                                        <Text style={[styles.previewCell, { color: colors.destructive, fontSize: 9, opacity: 0.8 }]} numberOfLines={1}>
                                          used by {diffRow.conflictingItem.vendor} {diffRow.conflictingItem.catalog}
                                        </Text>
                                      ) : null}
                                    </>
                                  ) : isBarcodeReplace && diffRow?.existingBarcodes && diffRow.existingBarcodes.length > 0 ? (
                                    <Text style={[styles.previewCell, { color: colors.warning, textDecorationLine: "line-through", fontSize: 10 }]} numberOfLines={1}>
                                      {diffRow.existingBarcodes.join(", ")}
                                    </Text>
                                  ) : null}
                                  <Text style={[styles.previewCell, { color: isBarcodeConflict ? colors.destructive : colors.mutedForeground, fontSize: 11 }]} numberOfLines={1}>
                                    {row.barcodes.join(", ")}
                                  </Text>
                                </View>
                              ) : null}
                              {isReplace ? (
                                <Pressable
                                  onPress={() => {
                                    setSkipBinRows(prev => toggleSkipRow(prev, i));
                                  }}
                                  style={[styles.skipToggle, { backgroundColor: isSkipped ? colors.success + "22" : colors.warning + "22", borderColor: isSkipped ? colors.success : colors.warning }]}
                                >
                                  <Text style={{ fontSize: 11, color: isSkipped ? colors.success : colors.warning, fontFamily: "Inter_600SemiBold" }}>
                                    {isSkipped ? "✓" : "⚠"}
                                  </Text>
                                </Pressable>
                              ) : (
                                <View style={{ width: 44 }} />
                              )}
                            </View>
                          );
                        })}
                      </>
                    );
                  })()}

                  {parsedRows.length > 8 ? (
                    <Text style={[styles.moreRows, { color: colors.mutedForeground }]}>
                      +{parsedRows.length - 8} more rows
                    </Text>
                  ) : null}

                  {/* Bin diff summary / warning */}
                  {binDiffPending ? (
                    <View style={[styles.diffCard, { backgroundColor: colors.muted }]}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={[styles.diffText, { color: colors.mutedForeground, marginLeft: 8 }]}>Checking for bin conflicts…</Text>
                    </View>
                  ) : binDiff ? (
                    <>
                      {/* Summary chips */}
                      <View style={styles.diffSummaryRow}>
                        {binDiff.willReplaceBins > 0 ? (
                          <View style={[styles.diffChip, { backgroundColor: colors.warning + "22", borderColor: colors.warning + "55" }]}>
                            <Text style={[styles.diffChipCount, { color: colors.warning }]}>{activeReplacementCount(binDiff.willReplaceBins, skipBinRows, binDiff.rows)}</Text>
                            <Text style={[styles.diffChipLabel, { color: colors.warning }]}>will replace bins</Text>
                          </View>
                        ) : null}
                        {binDiff.willAddBins > 0 ? (
                          <View style={[styles.diffChip, { backgroundColor: colors.success + "15", borderColor: colors.success + "44" }]}>
                            <Text style={[styles.diffChipCount, { color: colors.success }]}>{binDiff.willAddBins}</Text>
                            <Text style={[styles.diffChipLabel, { color: colors.success }]}>will add bins</Text>
                          </View>
                        ) : null}
                        {binDiff.willPreserveBins > 0 ? (
                          <View style={[styles.diffChip, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                            <Text style={[styles.diffChipCount, { color: colors.mutedForeground }]}>{preservedBinCount(binDiff.willPreserveBins, skipBinRows, binDiff.rows)}</Text>
                            <Text style={[styles.diffChipLabel, { color: colors.mutedForeground }]}>bins preserved</Text>
                          </View>
                        ) : null}
                        {binDiff.willReplaceBarcodes > 0 ? (
                          <View style={[styles.diffChip, { backgroundColor: colors.warning + "22", borderColor: colors.warning + "55" }]}>
                            <Text style={[styles.diffChipCount, { color: colors.warning }]}>{binDiff.willReplaceBarcodes}</Text>
                            <Text style={[styles.diffChipLabel, { color: colors.warning }]}>will replace barcodes</Text>
                          </View>
                        ) : null}
                        {binDiff.willAddBarcodes > 0 ? (
                          <View style={[styles.diffChip, { backgroundColor: colors.success + "15", borderColor: colors.success + "44" }]}>
                            <Text style={[styles.diffChipCount, { color: colors.success }]}>{binDiff.willAddBarcodes}</Text>
                            <Text style={[styles.diffChipLabel, { color: colors.success }]}>will add barcodes</Text>
                          </View>
                        ) : null}
                        {binDiff.willPreserveBarcodes > 0 ? (
                          <View style={[styles.diffChip, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                            <Text style={[styles.diffChipCount, { color: colors.mutedForeground }]}>{binDiff.willPreserveBarcodes}</Text>
                            <Text style={[styles.diffChipLabel, { color: colors.mutedForeground }]}>barcodes preserved</Text>
                          </View>
                        ) : null}
                        {binDiff.willBarcodeConflicts > 0 ? (
                          <View style={[styles.diffChip, { backgroundColor: colors.destructive + "20", borderColor: colors.destructive + "55" }]}>
                            <Text style={[styles.diffChipCount, { color: colors.destructive }]}>{binDiff.willBarcodeConflicts}</Text>
                            <Text style={[styles.diffChipLabel, { color: colors.destructive }]}>barcode conflict{binDiff.willBarcodeConflicts !== 1 ? "s" : ""}</Text>
                          </View>
                        ) : null}
                      </View>

                      {/* Barcode conflict error — blocks upload until the CSV is fixed */}
                      {binDiff.willBarcodeConflicts > 0 ? (
                        <View style={[styles.replaceWarning, { backgroundColor: colors.destructive + "12", borderColor: colors.destructive + "55" }]}>
                          <Text style={[styles.replaceWarningTitle, { color: colors.destructive }]}>
                            ✕ {binDiff.willBarcodeConflicts} row{binDiff.willBarcodeConflicts !== 1 ? "s have" : " has"} a barcode conflict
                          </Text>
                          <Text style={[styles.replaceWarningHint, { color: colors.mutedForeground }]}>
                            One or more barcodes in your CSV are already assigned to a different inventory item. Upload is blocked — fix the CSV by removing or correcting those barcodes, then re-upload.
                          </Text>
                          <View style={{ marginTop: 8 }}>
                            {binDiff.rows.map((diffRow, idx) => {
                              if (diffRow.barcodeStatus !== "conflict") return null;
                              return (
                                <View key={idx} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 4, gap: 6 }}>
                                  <Text style={{ color: colors.destructive, fontSize: 11, fontFamily: "Inter_600SemiBold", marginTop: 1 }}>✕</Text>
                                  <View style={{ flex: 1 }}>
                                    <Text style={{ color: colors.foreground, fontSize: 12, fontFamily: "Inter_600SemiBold" }} numberOfLines={1}>
                                      {diffRow.vendor} {diffRow.catalog}
                                    </Text>
                                    {diffRow.conflictingItem ? (
                                      <Text style={{ color: colors.mutedForeground, fontSize: 11 }} numberOfLines={1}>
                                        barcode in use by {diffRow.conflictingItem.vendor} {diffRow.conflictingItem.catalog}
                                      </Text>
                                    ) : null}
                                  </View>
                                </View>
                              );
                            })}
                          </View>
                        </View>
                      ) : null}

                      {/* Replace warning with skip-all and confirmation */}
                      {binDiff.willReplaceBins > 0 ? (
                        <View style={[styles.replaceWarning, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "55" }]}>
                          <Text style={[styles.replaceWarningTitle, { color: colors.warning }]}>
                            ⚠ {binDiff.willReplaceBins} row{binDiff.willReplaceBins !== 1 ? "s" : ""} will overwrite existing bin assignments
                          </Text>
                          <Text style={[styles.replaceWarningHint, { color: colors.mutedForeground }]}>
                            Expand the list below to review each replacement individually, or use the skip-all button to keep all existing bins.
                          </Text>

                          {/* Collapsible full replacement list */}
                          <Pressable
                            onPress={() => { setReplaceListOpen(v => !v); setReplaceListSearch(""); }}
                            style={[styles.reviewToggleBtn, { borderColor: colors.warning + "88", backgroundColor: colors.warning + "10" }]}
                          >
                            <Text style={[styles.reviewToggleBtnText, { color: colors.warning }]}>
                              {replaceListOpen ? "▲ Hide replacement list" : `▼ Review ${binDiff.willReplaceBins} replacement${binDiff.willReplaceBins !== 1 ? "s" : ""}`}
                            </Text>
                          </Pressable>

                          {replaceListOpen ? (
                            <ScrollView
                              style={[styles.replaceList, { borderColor: colors.warning + "44", backgroundColor: colors.warning + "08" }]}
                              nestedScrollEnabled
                            >
                              {binDiff.willReplaceBins > 20 ? (
                                <View style={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4 }}>
                                  <KeyboardDoneInput
                                    value={replaceListSearch}
                                    onChangeText={setReplaceListSearch}
                                    placeholder="Search by vendor or catalog…"
                                    placeholderTextColor={colors.mutedForeground}
                                    style={{
                                      backgroundColor: colors.background,
                                      borderColor: colors.warning + "66",
                                      borderWidth: 1,
                                      borderRadius: 6,
                                      paddingHorizontal: 10,
                                      paddingVertical: 6,
                                      fontSize: 13,
                                      color: colors.foreground,
                                      fontFamily: "Inter_400Regular",
                                    }}
                                    clearButtonMode="while-editing"
                                    autoCorrect={false}
                                    autoCapitalize="none"
                                  />
                                </View>
                              ) : null}
                              {binDiff.rows.map((diffRow, idx) => {
                                if (diffRow.status !== "replace") return null;
                                const query = replaceListSearch.trim().toLowerCase();
                                if (query && !diffRow.catalog.toLowerCase().includes(query) && !diffRow.vendor.toLowerCase().includes(query)) return null;
                                const parsedRow = parsedRows[idx];
                                const isSkipped = skipBinRows.has(idx);
                                return (
                                  <View key={idx} style={[styles.replaceListRow, { borderBottomColor: colors.warning + "33" }]}>
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                      <Text style={[styles.replaceListCatalog, { color: colors.foreground }]} numberOfLines={1}>
                                        {diffRow.catalog}
                                      </Text>
                                      <Text style={[styles.replaceListVendor, { color: colors.mutedForeground }]} numberOfLines={1}>
                                        {diffRow.vendor}
                                      </Text>
                                      {isSkipped ? (
                                        <Text style={[styles.replaceListBins, { color: colors.mutedForeground, fontStyle: "italic" }]} numberOfLines={1}>
                                          keeping: {diffRow.existingBins.join(", ")}
                                        </Text>
                                      ) : (
                                        <>
                                          <Text style={[styles.replaceListBins, { color: colors.warning, textDecorationLine: "line-through" }]} numberOfLines={1}>
                                            {diffRow.existingBins.join(", ")}
                                          </Text>
                                          <Text style={[styles.replaceListBins, { color: colors.foreground }]} numberOfLines={1}>
                                            {parsedRow?.binLocations.join(", ") ?? diffRow.incomingBins.join(", ")}
                                          </Text>
                                        </>
                                      )}
                                    </View>
                                    <Pressable
                                      onPress={() => {
                                        setSkipBinRows(prev => toggleSkipRow(prev, idx));
                                        setReplaceConfirmed(false);
                                      }}
                                      style={[styles.skipToggle, { backgroundColor: isSkipped ? colors.success + "22" : colors.warning + "22", borderColor: isSkipped ? colors.success : colors.warning }]}
                                    >
                                      <Text style={{ fontSize: 11, color: isSkipped ? colors.success : colors.warning, fontFamily: "Inter_600SemiBold" }}>
                                        {isSkipped ? "✓" : "⚠"}
                                      </Text>
                                    </Pressable>
                                  </View>
                                );
                              })}
                            </ScrollView>
                          ) : null}

                          <Pressable
                            onPress={() => {
                              const next = toggleSkipAll(binDiff.rows, skipBinRows);
                              const wasRestoreAll = next.size === 0;
                              setSkipBinRows(next);
                              if (!wasRestoreAll) setReplaceConfirmed(false);
                            }}
                            style={[styles.skipAllBtn, { borderColor: colors.warning }]}
                          >
                            <Text style={[styles.skipAllBtnText, { color: colors.warning }]}>
                              {binDiff.rows.filter((r, i) => r.status === "replace" && skipBinRows.has(i)).length === binDiff.willReplaceBins
                                ? "↩ Restore all bin replacements"
                                : "⏭ Skip all bin replacements (keep existing)"}
                            </Text>
                          </Pressable>

                          {/* Explicit confirmation checkbox */}
                          {activeReplacementCount(binDiff.willReplaceBins, skipBinRows, binDiff.rows) > 0 ? (
                            <Pressable
                              onPress={() => setReplaceConfirmed(v => !v)}
                              style={styles.confirmRow}
                            >
                              <View style={[styles.checkbox, { borderColor: replaceConfirmed ? colors.primary : colors.warning, backgroundColor: replaceConfirmed ? colors.primary : "transparent" }]}>
                                {replaceConfirmed ? <Text style={{ color: colors.primaryForeground, fontSize: 11, fontFamily: "Inter_700Bold" }}>✓</Text> : null}
                              </View>
                              <Text style={[styles.confirmLabel, { color: colors.foreground }]}>
                                I understand{" "}
                                {activeReplacementCount(binDiff.willReplaceBins, skipBinRows, binDiff.rows)}{" "}
                                existing bin assignment{activeReplacementCount(binDiff.willReplaceBins, skipBinRows, binDiff.rows) !== 1 ? "s" : ""} will be overwritten
                              </Text>
                            </Pressable>
                          ) : null}
                        </View>
                      ) : null}
                    </>
                  ) : null}

                  {/* Preview failed — hard block with retry hint */}
                  {binDiffFailed ? (
                    <View style={[styles.diffCard, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "44", borderWidth: 1, marginTop: 10 }]}>
                      <Text style={[styles.diffText, { color: colors.destructive }]}>
                        ⚠ Could not check for bin conflicts. Upload is disabled until the check succeeds. Please re-select the file, re-paste, or re-authenticate and try again.
                      </Text>
                    </View>
                  ) : null}

                  {/* Upload button — gated on confirmation when replacements exist,
                      and blocked entirely until preview has been successfully loaded */}
                  {(() => {
                    const pendingReplacements = binDiff
                      ? activeReplacementCount(binDiff.willReplaceBins, skipBinRows, binDiff.rows)
                      : 0;
                    const needsConfirm = pendingReplacements > 0 && !replaceConfirmed;
                    const hasConflicts = binDiff ? binDiff.willBarcodeConflicts > 0 : false;
                    // Block upload if preview hasn't been fetched yet (pending or failed)
                    const previewRequired = binDiffPending || binDiffFailed || binDiff === null;
                    const isDisabled = uploadPending || previewRequired || needsConfirm || hasConflicts;
                    const btnLabel = binDiffPending
                      ? "Checking conflicts…"
                      : hasConflicts
                        ? `✕ Fix ${binDiff!.willBarcodeConflicts} barcode conflict${binDiff!.willBarcodeConflicts !== 1 ? "s" : ""} to upload`
                        : needsConfirm
                          ? "✓ Confirm replacement to upload"
                          : `⬆️ Upload ${parsedRows.length} Items`;
                    return (
                      <Pressable
                        onPress={handleUpload}
                        disabled={isDisabled}
                        style={[styles.uploadBtn, { backgroundColor: hasConflicts ? colors.destructive + "22" : isDisabled ? colors.muted : colors.primary }]}
                      >
                        {uploadPending ? (
                          <ActivityIndicator color={colors.primaryForeground} />
                        ) : (
                          <Text style={[styles.uploadBtnText, { color: hasConflicts ? colors.destructive : isDisabled ? colors.mutedForeground : colors.primaryForeground }]}>
                            {btnLabel}
                          </Text>
                        )}
                      </Pressable>
                    );
                  })()}
                </View>
              ) : null}

              {/* AI Status card */}
              <View style={[styles.uploadCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.aiStatusHeader}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>🤖 AI Status</Text>
                  <Pressable
                    onPress={aiStatusProbing ? undefined : triggerAiProbe}
                    disabled={aiStatusProbing}
                    style={[
                      styles.aiProbeBtn,
                      { borderColor: aiStatusProbing ? colors.border : colors.primary },
                    ]}
                  >
                    {aiStatusProbing ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Text style={[styles.aiProbeBtnText, { color: colors.primary }]}>Re-run probe</Text>
                    )}
                  </Pressable>
                </View>

                {aiStatusLoading && Object.keys(aiStatusBots).length === 0 ? (
                  <ActivityIndicator size="small" color={colors.primary} style={{ alignSelf: "flex-start" }} />
                ) : aiStatusError ? (
                  <Text style={[styles.aiStatusError, { color: colors.destructive }]}>⚠ {aiStatusError}</Text>
                ) : Object.keys(aiStatusBots).length === 0 ? (
                  <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                    No probe results yet. Tap "Re-run probe" to check bot health.
                  </Text>
                ) : (
                  <View style={styles.aiStatusBotList}>
                    {Object.entries(aiStatusBots).map(([name, botStatus]) => {
                      const dotColor =
                        botStatus === "ok"
                          ? "#10b981"
                          : botStatus === "timeout"
                          ? "#f59e0b"
                          : "#ef4444";
                      return (
                        <View
                          key={name}
                          style={[
                            styles.aiStatusBotRow,
                            { borderBottomColor: colors.border },
                          ]}
                        >
                          <Text
                            style={[styles.aiStatusBotName, { color: colors.foreground }]}
                            numberOfLines={1}
                          >
                            {name}
                          </Text>
                          <View
                            style={[
                              styles.aiStatusBadge,
                              { backgroundColor: dotColor + "20", borderColor: dotColor },
                            ]}
                          >
                            <Text style={[styles.aiStatusBadgeDot, { color: dotColor }]}>●</Text>
                            <Text style={[styles.aiStatusBadgeText, { color: dotColor }]}>
                              {botStatus}
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>

            </ScrollView>
          ) : tab === "enrichment" ? (
            <View style={{ flex: 1 }}>
              <FlatList
                data={inventory}
                keyExtractor={item => String(item.id)}
                renderItem={({ item }) => (
                  <InventoryRow item={item} colors={colors} onEditBins={setBinEditorItem} />
                )}
                contentContainerStyle={{ paddingBottom: 120 }}
                ListHeaderComponent={
                  <View style={{ padding: 16 }}>
                    {/* PDF Catalog Import */}
                    <CatalogPdfUpload
                      adminToken={adminToken}
                      onSessionExpired={() => {
                        logoutAdmin();
                        setUploadError("Admin session expired. Please unlock again.");
                      }}
                    />

                    {/* Floor Plan Upload */}
                    <View style={[styles.uploadCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <Text style={[styles.cardTitle, { color: colors.foreground }]}>🗺 Floor Plan</Text>
                      <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                        Upload an updated warehouse floor plan (SVG). The app fetches the new plan on next launch — no app update required.
                      </Text>
                      <Pressable onPress={handlePickFloorPlan} style={[styles.pickBtn, { borderColor: colors.primary }]}>
                        <Text style={[styles.pickBtnText, { color: colors.primary }]}>
                          {floorPlanFile ? `📄 ${floorPlanFile.name}` : "Choose SVG File"}
                        </Text>
                      </Pressable>
                      {floorPlanFile ? (
                        <Pressable
                          onPress={handleUploadFloorPlan}
                          disabled={floorPlanUploading}
                          style={[
                            styles.pickBtn,
                            { backgroundColor: floorPlanUploading ? colors.muted : colors.primary, borderColor: "transparent" },
                          ]}
                        >
                          {floorPlanUploading ? (
                            <ActivityIndicator size="small" color={colors.primaryForeground} />
                          ) : (
                            <Text style={[styles.pickBtnText, { color: colors.primaryForeground }]}>Upload Floor Plan</Text>
                          )}
                        </Pressable>
                      ) : null}
                      {floorPlanResult ? (
                        <View style={[styles.uploadCard, {
                          backgroundColor: floorPlanResult.success ? "#10b98115" : colors.destructive + "15",
                          borderColor: floorPlanResult.success ? "#10b98155" : colors.destructive + "55",
                          marginBottom: 0,
                        }]}>
                          <Text style={{ color: floorPlanResult.success ? "#059669" : colors.destructive, fontSize: 13, fontFamily: "Inter_500Medium" }}>
                            {floorPlanResult.success ? "✓ " : "⚠ "}{floorPlanResult.message}
                          </Text>
                        </View>
                      ) : null}
                    </View>

                    {/* Bulk Enrichment Coverage */}
                    <View style={[styles.enrichCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <Text style={[styles.cardTitle, { color: colors.foreground }]}>📊 Enrichment Coverage</Text>
                      <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                        AI generates searchable keywords for each part and saves them to the database permanently.
                      </Text>

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
                          {enrichSummary.total > 0 ? (
                            <View style={[styles.progressBar, { backgroundColor: colors.muted }]}>
                              <View
                                style={[styles.progressFill, { backgroundColor: colors.success, width: `${Math.round((enrichSummary.enriched / enrichSummary.total) * 100)}%` }]}
                              />
                            </View>
                          ) : null}
                        </>
                      ) : (
                        <ActivityIndicator size="small" color={colors.primary} />
                      )}
                      {bulkEnrichPending && !bulkJobStatus?.running ? (
                        <View style={[styles.aiWorkingBanner, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "40" }]}>
                          <ActivityIndicator size="small" color={colors.primary} />
                          <Text style={[styles.aiWorkingText, { color: colors.primary }]}>
                            Starting AI enrichment…
                          </Text>
                        </View>
                      ) : null}
                      {bulkJobStatus?.running ? (
                        <View style={[styles.aiWorkingBanner, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "40", flexDirection: "column", alignItems: "stretch" }]}>
                          <View style={[styles.bulkStatusRow]}>
                            <ActivityIndicator size="small" color={colors.primary} />
                            <Text style={[styles.aiWorkingText, { color: colors.primary, marginLeft: 8, flex: 1 }]}>
                              {bulkJobStatus.stopRequested ? "Stopping after current batch…" : "AI enrichment is running…"}
                            </Text>
                            <Pressable
                              onPress={handleStopBulkEnrich}
                              disabled={bulkStopPending || bulkJobStatus.stopRequested}
                              style={[styles.stopBtn, { borderColor: (bulkStopPending || bulkJobStatus.stopRequested) ? colors.border : colors.destructive }]}
                            >
                              {bulkStopPending ? (
                                <ActivityIndicator size="small" color={colors.destructive} />
                              ) : (
                                <Text style={[styles.stopBtnText, { color: bulkJobStatus.stopRequested ? colors.mutedForeground : colors.destructive }]}>
                                  {bulkJobStatus.stopRequested ? "Stopping…" : "Stop"}
                                </Text>
                              )}
                            </Pressable>
                          </View>
                          {bulkJobStatus.total != null && bulkJobStatus.total > 0 ? (
                            <>
                              <View style={[styles.progressBar, { backgroundColor: colors.muted }]}>
                                <View style={[styles.progressFill, { backgroundColor: colors.primary, width: `${Math.round((bulkJobStatus.processed / bulkJobStatus.total) * 100)}%` }]} />
                              </View>
                              <Text style={[styles.progressText, { color: colors.mutedForeground, fontSize: 12 }]}>
                                {bulkJobStatus.processed.toLocaleString()} / {bulkJobStatus.total.toLocaleString()} processed
                                {bulkJobStatus.errors > 0 ? ` · ${bulkJobStatus.errors} errors` : ""}
                              </Text>
                            </>
                          ) : null}
                          {bulkJobStatus.model ? (
                            <Text style={[styles.progressText, { color: colors.mutedForeground, fontSize: 12 }]}>
                              Model: {bulkJobStatus.model}
                            </Text>
                          ) : null}
                        </View>
                      ) : null}
                      {bulkJobStatus && !bulkJobStatus.running && bulkJobStatus.finishedAt ? (
                        <View style={[styles.doneCard, { backgroundColor: colors.success + "11" }]}>
                          <Text style={[styles.doneText, { color: colors.success }]}>
                            ✓ Last run: {bulkJobStatus.processed.toLocaleString()} processed
                            {bulkJobStatus.errors > 0 ? `, ${bulkJobStatus.errors} errors` : ""}
                          </Text>
                        </View>
                      ) : null}
                      {(bulkJobStatus?.lastError || bulkEnrichError) ? (
                        <View style={[styles.doneCard, { backgroundColor: colors.destructive + "11" }]}>
                          <Text style={[styles.doneText, { color: colors.destructive }]}>
                            ⚠ {bulkEnrichError ?? bulkJobStatus?.lastError}
                          </Text>
                        </View>
                      ) : null}
                      <Pressable
                        onPress={() => handleStartBulkEnrich(false)}
                        disabled={bulkJobStatus?.running || bulkEnrichPending}
                        style={[styles.enrichBtn, { backgroundColor: (bulkJobStatus?.running || bulkEnrichPending) ? colors.muted : colors.primary }]}
                      >
                        {bulkEnrichPending && !bulkJobStatus?.force ? (
                          <ActivityIndicator color={colors.primaryForeground} />
                        ) : (
                          <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                            {bulkJobStatus?.running && !bulkJobStatus.force ? "⏳ Enrichment Running…" : "🚀 Start Bulk Enrichment"}
                          </Text>
                        )}
                      </Pressable>
                      <Pressable
                        onPress={() => handleStartBulkEnrich(true)}
                        disabled={bulkJobStatus?.running || bulkEnrichPending}
                        style={[styles.enrichBtn, { marginTop: 8, backgroundColor: (bulkJobStatus?.running || bulkEnrichPending) ? colors.muted : colors.warning }]}
                      >
                        {bulkEnrichPending && bulkJobStatus?.force ? (
                          <ActivityIndicator color={colors.primaryForeground} />
                        ) : (
                          <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                            {bulkJobStatus?.running && bulkJobStatus.force ? "⏳ Re-enriching All…" : "🔄 Re-enrich All (force)"}
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
                                <View style={[styles.progressFill, { backgroundColor: colors.primary, width: `${Math.round((measureJobStatus.processed / measureJobStatus.total) * 100)}%` }]} />
                              </View>
                              <Text style={[styles.progressText, { color: colors.mutedForeground, fontSize: 12 }]}>
                                {measureJobStatus.processed.toLocaleString()} / {measureJobStatus.total.toLocaleString()} processed
                                {measureJobStatus.updated > 0 ? ` · ${measureJobStatus.updated} updated` : ""}
                              </Text>
                            </>
                          ) : null}
                        </View>
                      ) : null}
                      {measureJobStatus && !measureJobStatus.running && measureJobStatus.finishedAt ? (
                        <View style={[styles.doneCard, { backgroundColor: colors.success + "11" }]}>
                          <Text style={[styles.doneText, { color: colors.success }]}>
                            ✓ Last run: {measureJobStatus.processed.toLocaleString()} processed
                            {measureJobStatus.updated > 0 ? `, ${measureJobStatus.updated} updated` : ""}
                          </Text>
                        </View>
                      ) : null}
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
                        style={[styles.enrichBtn, { backgroundColor: (measureJobStatus?.running || measureEnrichPending) ? colors.muted : colors.primary }]}
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

                    {/* Measure Tool — LiDAR + admin only */}
                    {lidarSupported && isAdmin ? (
                      <View style={[styles.uploadCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                        <Text style={[styles.cardTitle, { color: colors.foreground }]}>📐 Measure Tool</Text>
                        <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                          Use LiDAR to scan a part's bounding-box dimensions, then search by size or pre-fill an item's dimension fields.
                        </Text>
                        <Pressable
                          onPress={() => router.push("/measure")}
                          style={[styles.enrichBtn, { backgroundColor: colors.primary }]}
                        >
                          <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>📐 Open Measure Tool</Text>
                        </Pressable>
                      </View>
                    ) : null}

                    {/* AI Log & Inbox */}
                    <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                      <Pressable
                        onPress={() => router.push("/ai-log")}
                        style={[styles.exportCsvBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
                      >
                        <Text style={[styles.exportCsvText, { color: colors.mutedForeground }]}>🤖 AI Log</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => router.push("/admin-inbox")}
                        style={[styles.exportCsvBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
                      >
                        <Text style={[styles.exportCsvText, { color: colors.mutedForeground }]}>📬 Inbox</Text>
                      </Pressable>
                    </View>

                    {/* Quick Enrich */}
                    <View style={[styles.enrichCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <Text style={[styles.cardTitle, { color: colors.foreground }]}>🤖 Quick Enrich</Text>
                      <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                        Enrich a small batch immediately with live progress. Useful for newly imported items.
                      </Text>
                      {enrichProgress && !enrichProgress.done ? (
                        <View style={styles.progressContainer}>
                          <View style={[styles.progressBar, { backgroundColor: colors.muted }]}>
                            <View
                              style={[styles.progressFill, { backgroundColor: colors.primary, width: enrichProgress.total > 0 ? `${Math.round((enrichProgress.progress / enrichProgress.total) * 100)}%` : "0%" }]}
                            />
                          </View>
                          <Text style={[styles.progressText, { color: colors.foreground }]}>
                            {enrichProgress.progress} / {enrichProgress.total} items
                            {enrichProgress.batchSize ? ` (batch of ${enrichProgress.batchSize})` : ""}
                          </Text>
                          {enrichProgress.etaSeconds != null && enrichProgress.etaSeconds > 0 ? (
                            <Text style={[styles.progressText, { color: colors.mutedForeground, fontSize: 12 }]}>
                              ETA: ~{enrichProgress.etaSeconds < 60 ? `${enrichProgress.etaSeconds}s` : `${Math.ceil(enrichProgress.etaSeconds / 60)}m`}
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
                        style={[styles.enrichBtn, { backgroundColor: (enrichProgress && !enrichProgress.done) ? colors.muted : colors.primary }]}
                      >
                        <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                          {enrichProgress && !enrichProgress.done ? "Enriching…" : "🤖 Quick Enrich Pending"}
                        </Text>
                      </Pressable>
                    </View>

                    {/* Expand Descriptions */}
                    <View style={[styles.enrichCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                      <Text style={[styles.cardTitle, { color: colors.foreground }]}>🔤 Expand Descriptions</Text>
                      <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                        AI expands up to 50 abbreviated part descriptions at a time into plain English. Review and save each result individually.
                      </Text>

                      {/* "AI is working" banner — initial connecting phase */}
                      {expandDescRunning && !expandDescProgress ? (
                        <View style={[styles.aiWorkingBanner, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "40" }]}>
                          <ActivityIndicator size="small" color={colors.primary} />
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.aiWorkingText, { color: colors.primary }]}>
                              AI is analyzing descriptions…
                            </Text>
                            {expandDescModel ? (
                              <Text style={[styles.aiWorkingSubtext, { color: colors.primary }]}>
                                Model: {expandDescModel}
                              </Text>
                            ) : null}
                          </View>
                        </View>
                      ) : null}

                      {/* Progress bar while streaming */}
                      {expandDescRunning && expandDescProgress ? (
                        <View style={[styles.aiWorkingBanner, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "40" }]}>
                          <ActivityIndicator size="small" color={colors.primary} />
                          <View style={{ flex: 1, gap: 6 }}>
                            <Text style={[styles.aiWorkingText, { color: colors.primary }]}>
                              AI is working — {expandDescProgress.done} / {expandDescProgress.total} expanded
                            </Text>
                            <View style={[styles.progressBar, { backgroundColor: colors.primary + "30" }]}>
                              <View
                                style={[styles.progressFill, {
                                  backgroundColor: colors.primary,
                                  width: expandDescProgress.total > 0 ? `${Math.round((expandDescProgress.done / expandDescProgress.total) * 100)}%` : "0%",
                                }]}
                              />
                            </View>
                            {expandDescModel ? (
                              <Text style={[styles.aiWorkingSubtext, { color: colors.primary }]}>
                                Model: {expandDescModel}
                              </Text>
                            ) : null}
                          </View>
                        </View>
                      ) : null}

                      {/* Error state */}
                      {expandDescError ? (
                        <View style={[styles.doneCard, { backgroundColor: colors.destructive + "18" }]}>
                          <Text style={[styles.doneText, { color: colors.destructive }]}>{expandDescError}</Text>
                        </View>
                      ) : null}

                      {/* Done summary */}
                      {expandDescStreamDone && !expandDescRunning ? (() => {
                        const savedCount = expandDescResults.filter(r => r.savedStatus === "saved").length;
                        const discardedCount = expandDescResults.filter(r => r.savedStatus === "discarded").length;
                        const pendingCount = expandDescResults.filter(r => r.savedStatus === "pending").length;
                        return (
                          <View style={[styles.doneCard, { backgroundColor: colors.success + "11" }]}>
                            <Text style={[styles.doneText, { color: colors.success }]}>
                              ✓ Batch complete — {savedCount} saved, {discardedCount} discarded
                              {pendingCount > 0 ? `, ${pendingCount} pending review` : ""}
                              {expandDescRemaining != null ? `. ${expandDescRemaining} parts still need expansion.` : "."}
                            </Text>
                          </View>
                        );
                      })() : null}

                      {/* Draft restored banner */}
                      {expandDescDraftSavedAt !== null && !expandDescRunning && expandDescResults.some(r => r.savedStatus === "pending") ? (
                        <View style={[styles.draftBanner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "44" }]}>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.draftBannerTitle, { color: colors.warning }]}>
                              📋 Resumed from last session
                            </Text>
                            <Text style={[styles.draftBannerSub, { color: colors.warning }]}>
                              {expandDescResults.filter(r => r.savedStatus === "pending").length} results waiting for review
                            </Text>
                          </View>
                          <Pressable
                            onPress={handleClearExpandDescDraft}
                            style={[styles.draftClearBtn, { borderColor: colors.warning + "66" }]}
                          >
                            <Text style={[styles.draftClearBtnText, { color: colors.warning }]}>Clear</Text>
                          </Pressable>
                        </View>
                      ) : null}

                      {/* Bulk actions */}
                      {expandDescResults.some(r => r.savedStatus === "pending" && !r.error) ? (
                        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                          <Pressable
                            onPress={handleSaveAll}
                            disabled={expandDescRunning || expandDescResults.some(r => r.savedStatus === "saving")}
                            style={[
                              styles.enrichBtn,
                              {
                                flex: 1,
                                paddingVertical: 10,
                                backgroundColor:
                                  expandDescRunning || expandDescResults.some(r => r.savedStatus === "saving")
                                    ? colors.muted
                                    : colors.primary,
                              },
                            ]}
                          >
                            <Text style={[styles.enrichBtnText, {
                              color: expandDescRunning || expandDescResults.some(r => r.savedStatus === "saving")
                                ? colors.mutedForeground
                                : colors.primaryForeground,
                              fontSize: 14,
                            }]}>
                              Save All
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={handleDiscardAll}
                            disabled={expandDescRunning}
                            style={[
                              styles.enrichBtn,
                              {
                                flex: 1,
                                paddingVertical: 10,
                                backgroundColor: expandDescRunning ? colors.muted : colors.muted,
                                borderWidth: 1,
                                borderColor: colors.border,
                              },
                            ]}
                          >
                            <Text style={[styles.enrichBtnText, {
                              color: expandDescRunning ? colors.mutedForeground : colors.foreground,
                              fontSize: 14,
                            }]}>
                              Discard All
                            </Text>
                          </Pressable>
                        </View>
                      ) : null}

                      {/* Per-result cards */}
                      <FlatList
                        data={expandDescResults}
                        keyExtractor={r => String(r.id)}
                        scrollEnabled={false}
                        renderItem={({ item }) => (
                          <ExpandDescResultCard
                            result={item}
                            onSave={handleSaveExpandResult}
                            onDiscard={handleDiscardExpandResult}
                            onTextBlur={handleTextBlur}
                          />
                        )}
                      />

                      <Pressable
                        onPress={() => handleStartExpandDescriptions()}
                        disabled={expandDescRunning}
                        style={[styles.enrichBtn, { backgroundColor: expandDescRunning ? colors.muted : colors.primary, marginTop: 10 }]}
                      >
                        {expandDescRunning ? (
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <ActivityIndicator size="small" color={colors.primaryForeground} />
                            <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>Expanding…</Text>
                          </View>
                        ) : (
                          <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                            {expandDescStreamDone ? "🔤 Run Again (next 50)" : "🔤 Expand Descriptions"}
                          </Text>
                        )}
                      </Pressable>
                    </View>

                    {/* Inventory section header */}
                    {inventoryQuery.isLoading ? (
                      <View style={styles.loadingContainer}>
                        <ActivityIndicator size="large" color={colors.primary} />
                        <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Loading inventory…</Text>
                      </View>
                    ) : (
                      <View style={styles.inventoryHeader}>
                        <Text style={[styles.inventoryCount, { color: colors.foreground }]}>
                          {inventoryTotal} items total
                        </Text>
                        <View style={styles.inventoryHeaderActions}>
                          <Pressable
                            onPress={handleExportCsv}
                            disabled={exportPending}
                            style={[styles.exportCsvBtn, { borderColor: colors.border, backgroundColor: colors.card, opacity: exportPending ? 0.6 : 1 }]}
                          >
                            {exportPending ? (
                              <ActivityIndicator size="small" color={colors.primary} />
                            ) : (
                              <Text style={[styles.exportCsvText, { color: colors.primary }]}>⬇ Export CSV</Text>
                            )}
                          </Pressable>
                          <Pressable
                            onPress={() => handleEnrich()}
                            style={[styles.enrichSmallBtn, { backgroundColor: colors.primary }]}
                          >
                            <Text style={[styles.enrichSmallText, { color: colors.primaryForeground }]}>🤖 Enrich All</Text>
                          </Pressable>
                        </View>
                      </View>
                    )}
                    {exportError ? (
                      <View style={[styles.exportErrorBanner, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "55" }]}>
                        <Text style={[styles.exportErrorText, { color: colors.destructive }]}>⚠ Export failed: {exportError}</Text>
                        <Pressable onPress={() => setExportError(null)}>
                          <Text style={{ color: colors.destructive, fontSize: 14 }}>✕</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                }
                ListEmptyComponent={!inventoryQuery.isLoading ? (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyEmoji}>📦</Text>
                    <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Inventory</Text>
                    <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                      Upload a CSV or Excel file to add inventory items.
                    </Text>
                    <Pressable
                      onPress={() => setTab("import")}
                      style={[styles.goUploadBtn, { backgroundColor: colors.primary }]}
                    >
                      <Text style={[styles.goUploadText, { color: colors.primaryForeground }]}>Go to Import</Text>
                    </Pressable>
                  </View>
                ) : null}
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
            </View>
          ) : tab === "addpart" ? (
            <ScrollView
              contentContainerStyle={{ paddingBottom: 100 }}
              scrollEventThrottle={100}
              onScroll={(e) => setAddpartScrollY(e.nativeEvent.contentOffset.y)}
            >
              <Pressable
                onPress={() => setShelfEntryOpen(true)}
                style={[styles.shelfEntryBanner, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "55" }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.shelfEntryTitle, { color: colors.primary }]}>📦 Shelf Catalog Entry</Text>
                  <Text style={[styles.shelfEntryHint, { color: colors.mutedForeground }]}>
                    Rapid per-shelf mode — set prefix once, auto-increment position, optional photo per item.
                  </Text>
                </View>
                <Feather name="chevron-right" size={20} color={colors.primary} />
              </Pressable>
              <Pressable
                onPress={() => setBulkShelfOpen(true)}
                style={[styles.shelfEntryBanner, { backgroundColor: colors.success + "12", borderColor: colors.success + "55", marginTop: 10 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.shelfEntryTitle, { color: colors.success }]}>🔖 Bulk Assign by Shelf</Text>
                  <Text style={[styles.shelfEntryHint, { color: colors.mutedForeground }]}>
                    Load all items on a shelf, then scan barcodes to assign them one at a time.
                  </Text>
                </View>
                <Feather name="chevron-right" size={20} color={colors.success} />
              </Pressable>
              {isAdmin && adminToken && Platform.OS === "ios" ? (
                <Pressable
                  onPress={() => setMeasureVisible(true)}
                  style={[styles.shelfEntryBanner, { backgroundColor: colors.foreground + "0D", borderColor: colors.foreground + "33", marginTop: 10 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.shelfEntryTitle, { color: colors.foreground }]}>📐 Measure Part</Text>
                    <Text style={[styles.shelfEntryHint, { color: colors.mutedForeground }]}>
                      Use LiDAR or AI photo estimation to capture part dimensions.
                    </Text>
                  </View>
                  <Feather name="maximize" size={20} color={colors.foreground} />
                </Pressable>
              ) : null}
              <BarcodeAddPart scrollY={addpartScrollY} />
              <AddPartForm
                adminToken={adminToken}
                onSuccess={() => { inventoryQuery.refetch(); setMeasuredDims(null); }}
                initialDimensions={measuredDims}
              />
            </ScrollView>
          ) : tab === "query" ? (
            /* ── Query tab ───────────────────────────────────────────── */
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
              <View style={[styles.queryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>🔍 SQL Query</Text>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  Run a read-only SELECT against the live database. INSERT, UPDATE, DELETE, and DDL are blocked. Results capped at 500 rows.
                </Text>

                {/* Help / examples toggle */}
                <Pressable
                  onPress={() => setQueryHelpOpen(v => !v)}
                  style={[styles.queryHelpToggle, { borderColor: colors.border }]}
                >
                  <Text style={[styles.queryHelpToggleText, { color: colors.primary }]}>
                    {queryHelpOpen ? "▲ Hide examples" : "▼ Examples & table reference"}
                  </Text>
                </Pressable>

                {queryHelpOpen && (
                  <View style={[styles.queryHelpPanel, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                    {/* Table reference */}
                    <Text style={[styles.queryHelpHeading, { color: colors.foreground }]}>Key tables</Text>
                    {[
                      ["inventory", "vendor, catalog, description, bin_locations[], barcodes[], ai_keywords[], enriched_at, dimensions (jsonb), created_at"],
                      ["warehouse_zone", "aisle_id, section_num, is_inventory, svg_x, svg_y, svg_width, svg_height"],
                      ["catalog_pdf_job", "vendor, filename, status, matched_parts, total_pages, processed_pages, started_at, finished_at"],
                    ].map(([table, cols]) => (
                      <View key={table} style={styles.queryHelpTableRow}>
                        <Text style={[styles.queryHelpTableName, { color: colors.foreground }]}>{table}</Text>
                        <Text style={[styles.queryHelpTableCols, { color: colors.mutedForeground }]}>{cols}</Text>
                      </View>
                    ))}

                    {/* Example queries grouped */}
                    <Text style={[styles.queryHelpHeading, { color: colors.foreground, marginTop: 12 }]}>Tap an example to load it</Text>
                    {(() => {
                      const groups = Array.from(new Set(SQL_EXAMPLES.map(e => e.group)));
                      return groups.map(group => (
                        <View key={group}>
                          <Text style={[styles.queryHelpGroupLabel, { color: colors.mutedForeground }]}>{group}</Text>
                          {SQL_EXAMPLES.filter(e => e.group === group).map(ex => (
                            <Pressable
                              key={ex.label}
                              onPress={() => {
                                setQueryText(ex.sql);
                                setQueryError(null);
                                setQueryResult(null);
                                setQueryHelpOpen(false);
                              }}
                              style={({ pressed }) => [
                                styles.queryHelpExample,
                                { backgroundColor: pressed ? colors.primary + "18" : colors.card, borderColor: colors.border },
                              ]}
                            >
                              <Text style={[styles.queryHelpExampleLabel, { color: colors.foreground }]}>{ex.label}</Text>
                              <Text style={[styles.queryHelpExampleSql, { color: colors.mutedForeground }]} numberOfLines={2}>{ex.sql}</Text>
                            </Pressable>
                          ))}
                        </View>
                      ));
                    })()}
                  </View>
                )}

                <KeyboardDoneInput
                  value={queryText}
                  onChangeText={text => {
                    setQueryText(text);
                    setQueryError(null);
                    setQueryResult(null);
                  }}
                  multiline
                  scrollEnabled
                  autoCorrect={false}
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="SELECT * FROM inventory LIMIT 20"
                  placeholderTextColor={colors.mutedForeground}
                  style={[styles.queryInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                  textAlignVertical="top"
                />

                {/\b(DELETE|DROP|TRUNCATE|UPDATE|INSERT)\b/i.test(queryText) ? (
                  <View style={[styles.queryWriteWarning, { backgroundColor: "#f59e0b18", borderColor: "#f59e0b44" }]}>
                    <Text style={[styles.queryWriteWarningText, { color: "#b45309" }]}>
                      ⚠ This query contains a write operation. Make sure you intend to modify data.
                    </Text>
                  </View>
                ) : null}

                <Pressable
                  onPress={async () => {
                    if (!adminToken || queryRunning) return;
                    setQueryRunning(true);
                    setQueryError(null);
                    setQueryResult(null);
                    try {
                      const res = await fetch(`${API_BASE}/admin/query`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
                        body: JSON.stringify({ sql: queryText }),
                      });
                      if (res.status === 401) {
                        logoutAdmin();
                        setQueryError("Admin session expired. Please unlock again.");
                        return;
                      }
                      const qParsed = QueryResultSchema.safeParse(await res.json());
                      if (!qParsed.success) { console.warn("[upload] query result unexpected shape:", qParsed.error.message); setQueryError("Unexpected response from server — query failed."); return; }
                      const data = qParsed.data;
                      if (!res.ok || data.error) {
                        setQueryError(data.error ?? "Query failed");
                        return;
                      }
                      setQueryResult({ columns: data.columns ?? [], rows: data.rows ?? [], rowCount: data.rowCount ?? 0 });
                    } catch {
                      setQueryError("Network error — could not reach the server.");
                    } finally {
                      setQueryRunning(false);
                    }
                  }}
                  disabled={queryRunning || !queryText.trim()}
                  style={[styles.queryRunBtn, { backgroundColor: (queryRunning || !queryText.trim()) ? colors.muted : colors.primary }]}
                >
                  {queryRunning ? (
                    <ActivityIndicator color={colors.primaryForeground} />
                  ) : (
                    <Text style={[styles.queryRunBtnText, { color: colors.primaryForeground }]}>▶ Run</Text>
                  )}
                </Pressable>

                {queryError ? (
                  <View style={[styles.queryErrorBox, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "55" }]}>
                    <Text style={[styles.queryErrorText, { color: colors.destructive }]}>⚠ {queryError}</Text>
                  </View>
                ) : null}

                {queryResult && !queryError ? (
                  queryResult.rowCount === 0 ? (
                    <View style={[styles.queryEmptyBox, { backgroundColor: colors.muted }]}>
                      <Text style={[styles.queryEmptyText, { color: colors.mutedForeground }]}>No rows returned</Text>
                    </View>
                  ) : (
                    <View style={styles.queryResultsWrapper}>
                      <Text style={[styles.queryRowCount, { color: colors.mutedForeground }]}>
                        {queryResult.rowCount} row{queryResult.rowCount !== 1 ? "s" : ""}
                      </Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator>
                        <View>
                          {/* Column headers */}
                          <View style={[styles.queryHeaderRow, { backgroundColor: colors.muted }]}>
                            {queryResult.columns.map(col => (
                              <Text key={col} style={[styles.queryHeaderCell, { color: colors.foreground, minWidth: 110 }]} numberOfLines={1}>
                                {col}
                              </Text>
                            ))}
                          </View>
                          {/* Data rows */}
                          {queryResult.rows.map((row, ri) => (
                            <View
                              key={ri}
                              style={[
                                styles.queryDataRow,
                                { backgroundColor: ri % 2 === 0 ? colors.background : colors.muted + "66", borderBottomColor: colors.border },
                              ]}
                            >
                              {queryResult.columns.map(col => {
                                const val = row[col];
                                const display = val === null || val === undefined ? "" : Array.isArray(val) ? val.join(", ") : String(val);
                                return (
                                  <Text key={col} style={[styles.queryDataCell, { color: colors.foreground, minWidth: 110 }]} numberOfLines={2}>
                                    {display}
                                  </Text>
                                );
                              })}
                            </View>
                          ))}
                        </View>
                      </ScrollView>
                      {/* Export buttons */}
                      <View style={styles.queryExportRow}>
                        <Pressable
                          onPress={() => handleQueryExport("csv")}
                          disabled={queryExportPending !== null}
                          style={[
                            styles.queryExportBtn,
                            { borderColor: colors.border, backgroundColor: queryExportPending === "csv" ? colors.muted : colors.card },
                          ]}
                        >
                          {queryExportPending === "csv" ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                          ) : (
                            <Text style={[styles.queryExportBtnText, { color: colors.primary }]}>↓ Download CSV</Text>
                          )}
                        </Pressable>
                        <Pressable
                          onPress={() => handleQueryExport("xlsx")}
                          disabled={queryExportPending !== null}
                          style={[
                            styles.queryExportBtn,
                            { borderColor: colors.border, backgroundColor: queryExportPending === "xlsx" ? colors.muted : colors.card },
                          ]}
                        >
                          {queryExportPending === "xlsx" ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                          ) : (
                            <Text style={[styles.queryExportBtnText, { color: colors.primary }]}>↓ Download Excel</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  )
                ) : null}
              </View>
            </ScrollView>
          ) : (
            /* ── Users tab ───────────────────────────────────────────── */
            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
              <View style={[styles.queryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>👥 User Management</Text>
                  <Pressable
                    onPress={fetchUsers}
                    disabled={usersLoading}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border }}
                  >
                    <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_600SemiBold" }}>
                      {usersLoading ? "Loading…" : "Refresh"}
                    </Text>
                  </Pressable>
                </View>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  Approve, ban, and manage admin access for users who have signed up via the app.
                </Text>

                {usersError ? (
                  <View style={{ backgroundColor: colors.destructive + "15", borderRadius: 8, padding: 12, marginTop: 8 }}>
                    <Text style={{ color: colors.destructive, fontFamily: "Inter_400Regular", fontSize: 13 }}>⚠ {usersError}</Text>
                  </View>
                ) : null}

                {usersLoading && usersData.length === 0 ? (
                  <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 24 }} />
                ) : usersData.length === 0 ? (
                  <Text style={{ color: colors.mutedForeground, fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 16, textAlign: "center" }}>
                    No users yet. Tap Refresh to load.
                  </Text>
                ) : (
                  usersData.map((user) => {
                    const statusColor =
                      user.status === "approved" ? "#10b981" :
                      user.status === "banned"   ? colors.destructive :
                      colors.mutedForeground;
                    const isAdminRole = user.role === "admin";
                    const roleColor = isAdminRole ? colors.primary : colors.mutedForeground;
                    const roleLabel = isAdminRole ? "Admin" : "Member";
                    const isPending = userActionPending === user.clerkUserId;
                    return (
                      <View
                        key={user.clerkUserId}
                        style={{
                          marginTop: 10,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: colors.border,
                          padding: 12,
                          gap: 6,
                        }}
                      >
                        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                          <Text style={{ fontFamily: "Inter_600SemiBold", fontSize: 14, color: colors.foreground, flexShrink: 1, marginRight: 8 }}>
                            {user.email || "(no email)"}
                          </Text>
                          <View style={{ flexDirection: "row", gap: 6, flexShrink: 0 }}>
                            <View style={{ backgroundColor: roleColor + "22", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: roleColor + "44" }}>
                              <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: roleColor }}>
                                {roleLabel}
                              </Text>
                            </View>
                            <View style={{ backgroundColor: statusColor + "22", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: statusColor + "44" }}>
                              <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: statusColor, textTransform: "capitalize" }}>
                                {user.status}
                              </Text>
                            </View>
                          </View>
                        </View>
                        <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: colors.mutedForeground }}>
                          ID: {user.clerkUserId}
                        </Text>
                        {user.role === "admin" ? (
                          <View style={{ alignSelf: "flex-start", backgroundColor: colors.primary + "22", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3, borderWidth: 1, borderColor: colors.primary + "44" }}>
                            <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: colors.primary }}>Admin</Text>
                          </View>
                        ) : null}
                        <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                          {user.status !== "approved" ? (
                            <Pressable
                              onPress={() => handleUserAction(user.clerkUserId, "approve")}
                              disabled={!!userActionPending}
                              style={{
                                flex: 1, borderRadius: 6, paddingVertical: 8, alignItems: "center",
                                backgroundColor: "#10b98115", borderWidth: 1, borderColor: "#10b98144",
                                opacity: userActionPending ? 0.6 : 1,
                              }}
                            >
                              {isPending ? (
                                <ActivityIndicator size="small" color="#10b981" />
                              ) : (
                                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#10b981" }}>✓ Approve</Text>
                              )}
                            </Pressable>
                          ) : null}
                          {user.status !== "banned" ? (
                            <Pressable
                              onPress={() => handleUserAction(user.clerkUserId, "ban")}
                              disabled={!!userActionPending}
                              style={{
                                flex: 1, borderRadius: 6, paddingVertical: 8, alignItems: "center",
                                backgroundColor: colors.destructive + "15", borderWidth: 1, borderColor: colors.destructive + "44",
                                opacity: userActionPending ? 0.6 : 1,
                              }}
                            >
                              {isPending ? (
                                <ActivityIndicator size="small" color={colors.destructive} />
                              ) : (
                                <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: colors.destructive }}>✕ Ban</Text>
                              )}
                            </Pressable>
                          ) : null}
                        </View>
                        {/* Admin role controls — only approved users may be promoted */}
                        <UserAdminButtonRow
                          user={user}
                          userActionPending={userActionPending}
                          onPromote={() => handleUserAction(user.clerkUserId, "promote")}
                          onDemote={() => handleUserAction(user.clerkUserId, "demote")}
                        />
                      </View>
                    );
                  })
                )}
              </View>
            </ScrollView>
          )}
        </>
      )}

      <ReferenceModal />

      <BinEditor
        item={binEditorItem}
        onClose={() => setBinEditorItem(null)}
        // BinEditor already invalidates the listInventory query by URL prefix,
        // so we don't need to do anything else to refresh the visible rows.
      />

      <ShelfCatalogEntry
        visible={shelfEntryOpen}
        adminToken={adminToken}
        onClose={() => { setShelfEntryOpen(false); inventoryQuery.refetch(); }}
      />

      <BulkShelfAssign
        visible={bulkShelfOpen}
        onClose={() => setBulkShelfOpen(false)}
      />

      {isAdmin && adminToken ? (
        <MeasurePartScreen
          visible={measureVisible}
          onClose={() => setMeasureVisible(false)}
          onConfirm={(dims: PartDimensions) => {
            setMeasureVisible(false);
            setMeasuredDims(dims);
          }}
          adminToken={adminToken}
        />
      ) : null}
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
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, maxWidth: "58%" },
  apiStatusPill: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5 },
  apiStatusPillText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: "#ffffff" },
  botStatusRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" },
  botStatusChip: { flexDirection: "row", alignItems: "center", borderRadius: 10, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, gap: 3 },
  botStatusDot: { fontSize: 8 },
  botStatusText: { fontSize: 10, fontFamily: "Inter_500Medium", maxWidth: 100 },
  botStatusBadge: { width: 12, height: 12, borderRadius: 6 },
  botStatusBadgeActive: { width: 14, height: 14, borderRadius: 7, opacity: 0.85 },
  botStatusPopover: { marginTop: 4, padding: 8, borderRadius: 8, borderWidth: 1, alignSelf: "flex-end", maxWidth: 180, gap: 2 },
  botStatusPopoverName: { fontSize: 11, fontFamily: "Inter_500Medium", flexShrink: 1 },
  botStatusPopoverStatus: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
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
  previewRow: { flexDirection: "row", paddingHorizontal: 6, paddingVertical: 7, borderBottomWidth: 1, alignItems: "center" },
  previewCell: { fontSize: 12, fontFamily: "Inter_400Regular", paddingRight: 4 },
  moreRows: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 8 },
  skipToggle: { width: 34, height: 28, borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center", marginLeft: 5 },
  diffCard: { flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 8, marginTop: 10 },
  diffText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  diffSummaryRow: { flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" },
  diffChip: { flex: 1, minWidth: 90, alignItems: "center", paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, gap: 2 },
  diffChipCount: { fontSize: 20, fontFamily: "Inter_700Bold" },
  diffChipLabel: { fontSize: 11, fontFamily: "Inter_500Medium", textAlign: "center" },
  replaceWarning: { marginTop: 12, padding: 14, borderRadius: 10, borderWidth: 1, gap: 8 },
  replaceWarningTitle: { fontSize: 14, fontFamily: "Inter_700Bold" },
  replaceWarningHint: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  reviewToggleBtn: { borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, alignItems: "center" },
  reviewToggleBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  replaceList: { borderWidth: 1, borderRadius: 8, maxHeight: 280 },
  replaceListRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, gap: 10 },
  replaceListCatalog: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  replaceListVendor: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.4, marginTop: 1 },
  replaceListBins: { fontSize: 11, fontFamily: "SpaceMono_400Regular", marginTop: 2 },
  skipAllBtn: { borderWidth: 1, borderRadius: 8, paddingVertical: 9, alignItems: "center" },
  skipAllBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  confirmRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 4 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  confirmLabel: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1, lineHeight: 18 },
  uploadBtn: { marginTop: 12, borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  uploadBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  enrichCard: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 12, marginBottom: 14 },
  draftBanner: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 10, borderWidth: 1, marginTop: 10 },
  draftBannerTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  draftBannerSub: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2, opacity: 0.85 },
  draftClearBtn: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  draftClearBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  aiWorkingBanner: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 10, borderWidth: 1 },
  aiWorkingText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  aiWorkingSubtext: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2, opacity: 0.8 },
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
  inventoryHeaderActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  exportCsvBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, minWidth: 36, alignItems: "center", justifyContent: "center" },
  exportCsvText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  exportErrorBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, marginBottom: 10 },
  exportErrorText: { fontSize: 12, fontFamily: "Inter_500Medium", flex: 1, lineHeight: 17 },
  enrichSmallBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  enrichSmallText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  loadMoreBtn: { ...secondaryBtnBase, padding: 12, alignItems: "center", marginTop: 8 },
  loadMoreText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  pasteDivider: { alignItems: "center", position: "relative", height: 22, justifyContent: "center", marginTop: 4 },
  pasteDividerLine: { position: "absolute", left: 0, right: 0, height: 1 },
  pasteDividerLabel: { paddingHorizontal: 10, fontSize: 12, fontFamily: "Inter_400Regular" },
  pasteLabel: { fontSize: 13, fontFamily: "Inter_500Medium" },
  pasteInputWrapper: { position: "relative" },
  pasteInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 12, fontFamily: "SpaceMono_400Regular", height: 148, lineHeight: 18 },
  pasteClearBtn: { position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  pasteClearBtnText: { fontSize: 11, fontFamily: "Inter_600SemiBold", lineHeight: 14 },
  inlineBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1 },
  errorBanner: {},
  successBanner: {},
  inlineBannerText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1, lineHeight: 18 },
  bannerClose: { paddingLeft: 10 },
  queryCard: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 12 },
  queryHelpToggle: { borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, alignItems: "center" },
  queryHelpToggleText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  queryHelpPanel: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 6 },
  queryHelpHeading: { fontSize: 12, fontFamily: "Inter_700Bold", letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 2 },
  queryHelpTableRow: { gap: 1, marginBottom: 6 },
  queryHelpTableName: { fontSize: 12, fontFamily: "SpaceMono_400Regular" },
  queryHelpTableCols: { fontSize: 11, fontFamily: "Inter_400Regular", lineHeight: 16 },
  queryHelpGroupLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.3, textTransform: "uppercase", marginTop: 6, marginBottom: 3 },
  queryHelpExample: { borderWidth: 1, borderRadius: 6, padding: 10, marginBottom: 4 },
  queryHelpExampleLabel: { fontSize: 13, fontFamily: "Inter_500Medium", marginBottom: 3 },
  queryHelpExampleSql: { fontSize: 11, fontFamily: "SpaceMono_400Regular", lineHeight: 16 },
  queryInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, fontFamily: "SpaceMono_400Regular", height: 160, lineHeight: 20 },
  queryRunBtn: { borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  queryRunBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  queryErrorBox: { borderWidth: 1, borderRadius: 8, padding: 12 },
  queryErrorText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  queryWriteWarning: { borderWidth: 1, borderRadius: 8, padding: 12, marginBottom: 8 },
  queryWriteWarningText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  queryEmptyBox: { borderRadius: 8, padding: 14, alignItems: "center" },
  queryEmptyText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  queryResultsWrapper: { gap: 8 },
  queryRowCount: { fontSize: 12, fontFamily: "Inter_500Medium" },
  queryHeaderRow: { flexDirection: "row", paddingHorizontal: 8, paddingVertical: 8, borderRadius: 4 },
  queryHeaderCell: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.3, paddingRight: 12 },
  queryDataRow: { flexDirection: "row", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1 },
  queryDataCell: { fontSize: 12, fontFamily: "Inter_400Regular", paddingRight: 12 },
  queryExportRow: { flexDirection: "row", gap: 8, paddingTop: 4 },
  queryExportBtn: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 10, alignItems: "center", justifyContent: "center", minHeight: 40 },
  queryExportBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  aiStatusHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  aiProbeBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, minWidth: 44, alignItems: "center" },
  aiProbeBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  aiStatusError: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  aiStatusBotList: { gap: 0 },
  aiStatusBotRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  aiStatusBotName: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", marginRight: 10 },
  aiStatusBadge: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  aiStatusBadgeDot: { fontSize: 8 },
  aiStatusBadgeText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  shelfEntryBanner: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    margin: 16,
    marginBottom: 0,
    gap: 10,
  },
  shelfEntryTitle: { fontSize: 15, fontFamily: "Inter_700Bold", marginBottom: 2 },
  shelfEntryHint: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
});
