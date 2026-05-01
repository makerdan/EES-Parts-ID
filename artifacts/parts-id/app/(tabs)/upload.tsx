import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { useUpsertInventoryBatch, useListInventory } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { ReferenceModal } from "@/components/ReferenceModal";
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
  done?: boolean;
  error?: string;
  item?: { id: number; keywords: string[] };
};

function parseCSV(text: string): ParsedRow[] {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0]!.split(",").map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));
  const findCol = (...names: string[]) =>
    names.map((n) => headers.indexOf(n)).find((i) => i >= 0) ?? -1;

  const vendorCol = findCol("vendor", "mfr", "manufacturer", "brand");
  const catalogCol = findCol("catalog", "catalog#", "cat#", "part", "part#", "partno", "item", "itemno");
  const descCol = findCol("description", "desc", "name", "product", "productname");
  const binCol = findCol("bin", "bin location", "binlocation", "location", "loc", "shelf");

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
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

export default function UploadScreen() {
  const colors = useColors();
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [enrichProgress, setEnrichProgress] = useState<EnrichProgress | null>(null);
  const [tab, setTab] = useState<"upload" | "inventory">("upload");
  const [inventoryPage, setInventoryPage] = useState(1);

  const upsertMutation = useUpsertInventoryBatch();
  const inventoryQuery = useListInventory({
    page: inventoryPage,
    limit: 50,
  });

  const handlePickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["text/csv", "text/comma-separated-values", "text/plain", "application/octet-stream"],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setFileName(asset.name);

      const response = await fetch(asset.uri);
      const text = await response.text();
      const rows = parseCSV(text);

      if (rows.length === 0) {
        Alert.alert(
          "Parse Error",
          "No data rows found. Ensure columns are: vendor, catalog, description, binLocation",
        );
        return;
      }
      setParsedRows(rows);
    } catch {
      Alert.alert("Error", "Failed to read file.");
    }
  };

  const handleUpload = async () => {
    if (!parsedRows.length) return;
    try {
      const result = await upsertMutation.mutateAsync({
        data: { items: parsedRows },
      });
      Alert.alert(
        "Upload Complete",
        `Inserted: ${result.inserted} | Updated: ${result.updated} | Total: ${result.total}`,
        [
          { text: "View Inventory", onPress: () => setTab("inventory") },
          { text: "OK" },
        ],
      );
      setParsedRows([]);
      setFileName(null);
    } catch {
      Alert.alert("Upload Failed", "Could not upload inventory items.");
    }
  };

  const handleEnrich = async (idsToEnrich?: number[]) => {
    setEnrichProgress({ progress: 0, total: 0 });
    try {
      const body = idsToEnrich?.length ? { ids: idsToEnrich } : {};
      const response = await fetch(`${API_BASE}/inventory/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data: EnrichProgress = JSON.parse(line.slice(6));
              setEnrichProgress(data);
              if (data.done) {
                await inventoryQuery.refetch();
              }
            } catch {}
          }
        }
      }
    } catch {
      Alert.alert("Enrichment Error", "Failed to start AI enrichment.");
      setEnrichProgress(null);
    }
  };

  const inventory = inventoryQuery.data?.items ?? [];
  const inventoryTotal = inventoryQuery.data?.total ?? 0;
  const enrichedCount = inventory.filter((i) => i.enrichedAt).length;
  const unEnrichedCount = inventory.filter((i) => !i.enrichedAt).length;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>📤 Inventory</Text>
        <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
          Upload & AI Enrich
        </Text>
      </View>

      {/* Tab bar */}
      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {(["upload", "inventory"] as const).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={[
              styles.tabItem,
              { borderBottomColor: tab === t ? colors.primary : "transparent" },
            ]}
          >
            <Text
              style={[
                styles.tabLabel,
                { color: tab === t ? colors.primary : colors.mutedForeground },
              ]}
            >
              {t === "upload" ? "Upload CSV" : `Inventory (${inventoryTotal})`}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "upload" ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}>
          {/* CSV upload card */}
          <View style={[styles.uploadCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>
              📁 Import CSV File
            </Text>
            <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
              Required columns: vendor, catalog{"\n"}
              Optional: description, binLocation (or bin)
            </Text>

            <Pressable
              onPress={handlePickFile}
              style={[styles.pickBtn, { borderColor: colors.primary }]}
            >
              <Text style={[styles.pickBtnText, { color: colors.primary }]}>
                📂 Choose CSV File
              </Text>
            </Pressable>

            {fileName ? (
              <View style={[styles.fileChip, { backgroundColor: colors.muted }]}>
                <Text style={[styles.fileChipText, { color: colors.foreground }]}>📄 {fileName}</Text>
              </View>
            ) : null}
          </View>

          {/* Preview */}
          {parsedRows.length > 0 ? (
            <View style={[styles.previewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>
                Preview ({parsedRows.length} rows)
              </Text>

              {/* Header row */}
              <View style={[styles.previewHeaderRow, { backgroundColor: colors.muted }]}>
                {["VENDOR", "CATALOG", "DESCRIPTION", "BIN"].map((h) => (
                  <Text key={h} style={[styles.previewHeaderCell, { color: colors.mutedForeground, flex: h === "DESCRIPTION" ? 2 : 1 }]}>
                    {h}
                  </Text>
                ))}
              </View>

              {parsedRows.slice(0, 8).map((row, i) => (
                <View
                  key={i}
                  style={[styles.previewRow, { borderBottomColor: colors.border }]}
                >
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
                disabled={upsertMutation.isPending}
                style={[styles.uploadBtn, { backgroundColor: upsertMutation.isPending ? colors.muted : colors.primary }]}
              >
                {upsertMutation.isPending ? (
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
                  {enrichProgress.progress} / {enrichProgress.total} items enriched
                </Text>
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

            <View style={styles.enrichBtnRow}>
              <Pressable
                onPress={() => handleEnrich()}
                disabled={!!enrichProgress && !enrichProgress.done}
                style={[
                  styles.enrichBtn,
                  {
                    backgroundColor: (enrichProgress && !enrichProgress.done) ? colors.muted : colors.primary,
                    flex: 2,
                  },
                ]}
              >
                <Text style={[styles.enrichBtnText, { color: colors.primaryForeground }]}>
                  {enrichProgress && !enrichProgress.done ? "Enriching…" : "🤖 Enrich All Pending"}
                </Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      ) : (
        /* Inventory list tab */
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
                Upload a CSV file to add inventory items.
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
              keyExtractor={(item) => String(item.id)}
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
                    <Text style={[styles.enrichSmallText, { color: colors.primaryForeground }]}>
                      🤖 Enrich All
                    </Text>
                  </Pressable>
                </View>
              )}
              ListFooterComponent={() =>
                inventoryQuery.data && inventoryPage * 50 < inventoryTotal ? (
                  <Pressable
                    onPress={() => setInventoryPage((p) => p + 1)}
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

      <ReferenceModal />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  tabBar: { flexDirection: "row", borderBottomWidth: 1 },
  tabItem: { flex: 1, alignItems: "center", paddingVertical: 12, borderBottomWidth: 2 },
  tabLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  uploadCard: { borderRadius: 12, padding: 16, borderWidth: 1, marginBottom: 14, gap: 10 },
  cardTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  cardHint: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  pickBtn: { borderWidth: 2, borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  pickBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  fileChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, alignSelf: "flex-start" },
  fileChipText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  previewCard: { borderRadius: 12, padding: 14, borderWidth: 1, marginBottom: 14, gap: 0 },
  previewHeaderRow: { flexDirection: "row", paddingHorizontal: 6, paddingVertical: 6, borderRadius: 4, marginBottom: 2 },
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
  enrichBtnRow: { flexDirection: "row", gap: 10 },
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
});
