import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
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

const API_BASE =
  process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "";


type ParsedRow = {
  vendor: string;
  catalog: string;
  description: string;
  binLocation: string;
};

type EnrichProgress = {
  progress: number;
  total: number;
  batchSize?: number;
  etaSeconds?: number | null;
  done?: boolean;
  error?: string;
  item?: { id: number; keywords: string[] };
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
function parseCSV(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0]!.split(",").map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
  const vendorCol = findCol(headers, VENDOR_ALIASES);
  const catalogCol = findCol(headers, CATALOG_ALIASES);
  const descCol = findCol(headers, DESC_ALIASES);
  const binCol = findCol(headers, BIN_ALIASES);

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i]!);
    const vendor = vendorCol >= 0 ? cells[vendorCol]?.trim() ?? "" : "";
    const catalog = catalogCol >= 0 ? cells[catalogCol]?.trim() ?? "" : "";
    if (!vendor && !catalog) continue;
    rows.push({
      vendor: vendor || "UNKNOWN",
      catalog: catalog || "UNKNOWN",
      description: descCol >= 0 ? cells[descCol]?.trim() ?? "" : "",
      binLocation: binCol >= 0 ? cells[binCol]?.trim() ?? "" : "",
    });
  }
  return rows;
}

function splitCSVLine(line: string): string[] {
  const cells: string[] = [];
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
    rows.push({
      vendor: vendor || "UNKNOWN",
      catalog: catalog || "UNKNOWN",
      description: descCol >= 0 ? cells[descCol] ?? "" : "",
      binLocation: binCol >= 0 ? cells[binCol] ?? "" : "",
    });
  }
  return rows;
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
        {item.binLocation ? (
          <Text style={[rowStyles.bin, { color: colors.primary }]}>{item.binLocation}</Text>
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
  bin: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
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
  const [uploadSuccess, setUploadSuccess] = useState<{ inserted: number; updated: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [inventoryPage, setInventoryPage] = useState(1);

  const inventoryQuery = useListInventory({ page: inventoryPage, limit: 50 });

  // Build admin auth headers for protected API calls
  const adminHeaders: Record<string, string> = adminToken
    ? { "Authorization": `Bearer ${adminToken}` }
    : {};

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
        const text = await response.text();
        rows = parseCSV(text);
        setFileType("csv");
      } else if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) {
        rows = await parseXlsx(asset.uri);
        setFileType("xlsx");
      } else {
        try {
          const response = await fetch(asset.uri);
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

  const handleUpload = async () => {
    if (!parsedRows.length) return;
    setUploadError(null);
    setUploadSuccess(null);
    setUploadPending(true);
    try {
      const response = await fetch(`${API_BASE}/inventory/upsert-batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeaders,
        },
        body: JSON.stringify({ items: parsedRows }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (response.status === 401) {
          logoutAdmin();
          setUploadError("Admin session expired. Please unlock again.");
        } else {
          setUploadError(body.error ?? "Upload failed — could not save inventory items. Please try again.");
        }
        return;
      }

      const result = await response.json() as { inserted: number; updated: number; total: number };
      setUploadSuccess({ inserted: result.inserted, updated: result.updated, total: result.total });
      setParsedRows([]);
      setFileName(null);
      setFileType(null);
      await inventoryQuery.refetch();
    } catch {
      setUploadError("Upload failed — could not save inventory items. Please try again.");
    } finally {
      setUploadPending(false);
    }
  };

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
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data: EnrichProgress = JSON.parse(line.slice(6));
              setEnrichProgress(data);
              if (data.done) await inventoryQuery.refetch();
            } catch {}
          }
        }
      }
    } catch {
      setUploadError("AI enrichment failed — please check your connection and try again.");
      setEnrichProgress(null);
    }
  };

  const inventory = inventoryQuery.data?.items ?? [];
  const inventoryTotal = inventoryQuery.data?.total ?? 0;
  const enrichedCount = inventory.filter(i => i.enrichedAt).length;
  const unEnrichedCount = inventory.filter(i => !i.enrichedAt).length;

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
                Upload complete — inserted {uploadSuccess.inserted}, updated {uploadSuccess.updated} ({uploadSuccess.total} total)
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
                  {t === "upload" ? "Upload File" : `Inventory (${inventoryTotal})`}
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
                        {row.binLocation}
                      </Text>
                    </View>
                  ))}

                  {parsedRows.length > 8 ? (
                    <Text style={[styles.moreRows, { color: colors.mutedForeground }]}>
                      +{parsedRows.length - 8} more rows
                    </Text>
                  ) : null}

                  <Pressable
                    onPress={handleUpload}
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

              {/* AI Enrichment */}
              <View style={[styles.enrichCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>🤖 AI Enrichment</Text>
                <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
                  AI analyzes each part and generates searchable keywords saved permanently to the database.
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
                      ✓ Enrichment complete! {enrichProgress.progress} items processed.
                    </Text>
                  </View>
                ) : null}

                <View style={styles.enrichStats}>
                  <View style={[styles.statChip, { backgroundColor: colors.success + "11" }]}>
                    <Text style={[styles.statValue, { color: colors.success }]}>{enrichedCount}</Text>
                    <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Enriched</Text>
                  </View>
                  <View style={[styles.statChip, { backgroundColor: colors.warning + "11" }]}>
                    <Text style={[styles.statValue, { color: colors.warning }]}>{unEnrichedCount}</Text>
                    <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Pending</Text>
                  </View>
                </View>

                <Pressable
                  onPress={() => handleEnrich()}
                  disabled={!!enrichProgress && !enrichProgress.done}
                  style={[
                    styles.enrichBtn,
                    { backgroundColor: (enrichProgress && !enrichProgress.done) ? colors.muted : colors.primary },
                  ]}
                >
                  <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                    {enrichProgress && !enrichProgress.done ? "Enriching…" : "🤖 Enrich All Pending"}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  lockBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
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
  enrichCard: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 12 },
  progressContainer: { gap: 8 },
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
  loadMoreBtn: { borderWidth: 1, borderRadius: 8, padding: 12, alignItems: "center", marginTop: 8 },
  loadMoreText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  inlineBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1 },
  errorBanner: {},
  successBanner: {},
  inlineBannerText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1, lineHeight: 18 },
  bannerClose: { paddingLeft: 10 },
});
