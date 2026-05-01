import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSearchInventory } from "@workspace/api-client-react";
import type { InventoryItem, SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { FilterPanel, type FilterValues } from "@/components/FilterPanel";
import { ResultCard } from "@/components/ResultCard";
import { ReferenceModal } from "@/components/ReferenceModal";
import { KeywordEditor } from "@/components/KeywordEditor";

const DEFAULT_FILTERS: FilterValues = {
  keywords: "",
  catalog: "",
  vendor: "",
  color: "",
  size: "",
  material: "",
  textNumbers: "",
  confidenceThreshold: 0.5,
};

export default function SearchScreen() {
  const colors = useColors();
  const [filters, setFilters] = useState<FilterValues>(DEFAULT_FILTERS);
  const [searchBody, setSearchBody] = useState<FilterValues | null>(null);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [showFilters, setShowFilters] = useState(true);

  const searchMutation = useSearchInventory({
    mutation: {
      onSuccess: () => setShowFilters(false),
    },
  });

  const handleChange = (key: keyof FilterValues, value: string | number) => {
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const handleSearch = () => {
    setSearchBody(filters);
    searchMutation.mutate({ data: filters });
  };

  const handleClear = () => {
    setFilters(DEFAULT_FILTERS);
    setSearchBody(null);
    searchMutation.reset();
    setShowFilters(true);
  };

  const results = searchMutation.data?.results ?? [];
  const totalMatches = searchMutation.data?.totalMatches ?? 0;
  const belowThreshold = searchMutation.data?.belowThreshold ?? 0;

  const hasQuery =
    !!filters.keywords || !!filters.catalog || !!filters.vendor ||
    !!filters.color || !!filters.size || !!filters.material || !!filters.textNumbers;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>⚡ Parts ID</Text>
          <Text style={[styles.headerSubtitle, { color: colors.mutedForeground }]}>
            Electrical Inventory Lookup
          </Text>
        </View>
        <Pressable
          onPress={() => setShowFilters(!showFilters)}
          style={[styles.filterToggle, {
            backgroundColor: showFilters ? colors.primary : colors.muted,
            borderColor: colors.border,
          }]}
        >
          <Text style={[styles.filterToggleText, { color: showFilters ? colors.primaryForeground : colors.foreground }]}>
            {showFilters ? "▼ Filters" : "▲ Filters"}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={results}
        keyExtractor={(item) => String(item.item.id)}
        ListHeaderComponent={() => (
          <View>
            {/* Filter panel */}
            {showFilters ? (
              <View style={[styles.filterCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <FilterPanel
                  values={filters}
                  onChange={handleChange}
                  onSearch={handleSearch}
                  onClear={handleClear}
                  isLoading={searchMutation.isPending}
                />
              </View>
            ) : null}

            {/* Results header */}
            {searchMutation.isSuccess ? (
              <View style={styles.resultsHeader}>
                <View style={styles.resultsHeaderLeft}>
                  <Text style={[styles.resultsCount, { color: colors.foreground }]}>
                    {results.length} matches found
                  </Text>
                  {belowThreshold > 0 ? (
                    <Text style={[styles.belowThreshold, { color: colors.mutedForeground }]}>
                      +{belowThreshold} below threshold
                    </Text>
                  ) : null}
                </View>
                {!showFilters ? (
                  <Pressable
                    onPress={handleClear}
                    style={[styles.newSearchBtn, { borderColor: colors.border }]}
                  >
                    <Text style={[styles.newSearchText, { color: colors.primary }]}>New Search</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {/* Loading */}
            {searchMutation.isPending ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
                  Searching dictionaries…
                </Text>
              </View>
            ) : null}

            {/* Error */}
            {searchMutation.isError ? (
              <View style={[styles.errorCard, { backgroundColor: colors.destructive + "11", borderColor: colors.destructive + "44" }]}>
                <Text style={[styles.errorText, { color: colors.destructive }]}>
                  Search failed. Check your connection and try again.
                </Text>
              </View>
            ) : null}

            {/* Empty state */}
            {searchMutation.isSuccess && results.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyEmoji}>🔍</Text>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No Results Found</Text>
                <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                  Try broader search terms, check spelling, or lower the confidence threshold.
                </Text>
                {belowThreshold > 0 ? (
                  <Text style={[styles.belowHint, { color: colors.warning }]}>
                    {belowThreshold} items matched below threshold — try "Any 30%"
                  </Text>
                ) : null}
              </View>
            ) : null}

            {/* Welcome state */}
            {!searchMutation.isSuccess && !searchMutation.isPending ? (
              <View style={styles.welcomeContainer}>
                <Text style={styles.welcomeEmoji}>⚡</Text>
                <Text style={[styles.welcomeTitle, { color: colors.foreground }]}>
                  Search Electrical Parts
                </Text>
                <Text style={[styles.welcomeHint, { color: colors.mutedForeground }]}>
                  Search by keywords, catalog number, vendor, size, color, or material. Supports abbreviations and common misspellings.
                </Text>
                <View style={[styles.tipCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.tipTitle, { color: colors.foreground }]}>💡 Quick Tips</Text>
                  {[
                    "Type '20a duplex white' for white 20A outlet",
                    "Type 'BR120' for Eaton BR 20A breaker",
                    "Type '3/4 emt' for 3/4\" EMT conduit",
                    "Use Photo ID tab for camera identification",
                  ].map((tip, i) => (
                    <Text key={i} style={[styles.tipText, { color: colors.mutedForeground }]}>
                      • {tip}
                    </Text>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        )}
        renderItem={({ item: result, index }) => (
          <View style={styles.resultItem}>
            <ResultCard
              result={result}
              onEditKeywords={setEditItem}
              rank={index}
            />
          </View>
        )}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />

      {/* Floating reference button */}
      <ReferenceModal />

      {/* Keyword editor modal */}
      <KeywordEditor item={editItem} onClose={() => setEditItem(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  headerSubtitle: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  filterToggle: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  filterToggleText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  filterCard: {
    margin: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  resultsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  resultsHeaderLeft: {},
  resultsCount: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  belowThreshold: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  newSearchBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  newSearchText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  loadingContainer: { alignItems: "center", padding: 40, gap: 12 },
  loadingText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  errorCard: { margin: 16, padding: 16, borderRadius: 8, borderWidth: 1 },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  emptyContainer: { alignItems: "center", padding: 40 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_700Bold", marginBottom: 8 },
  emptyHint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 8 },
  belowHint: { fontSize: 13, fontFamily: "Inter_500Medium", textAlign: "center" },
  welcomeContainer: { padding: 24, alignItems: "center" },
  welcomeEmoji: { fontSize: 48, marginBottom: 12 },
  welcomeTitle: { fontSize: 20, fontFamily: "Inter_700Bold", marginBottom: 8 },
  welcomeHint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 20 },
  tipCard: { width: "100%", padding: 16, borderRadius: 8, borderWidth: 1 },
  tipTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 8 },
  tipText: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 4, lineHeight: 18 },
  resultItem: { paddingHorizontal: 12 },
  listContent: { paddingBottom: 120 },
});
