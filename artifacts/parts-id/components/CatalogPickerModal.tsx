import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useColors } from "@/hooks/useColors";
import {
  useSearchInventory,
  useUpsertInventoryBatch,
  getListInventoryQueryKey,
} from "@workspace/api-client-react";
import type { InventoryItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export function CatalogPickerModal({
  visible,
  barcodeCode,
  shelfPrefix,
  initialQuery,
  initialShowCreateForm,
  onAssign,
  onCancel,
}: {
  visible: boolean;
  barcodeCode: string;
  shelfPrefix?: string;
  initialQuery?: string;
  initialShowCreateForm?: boolean;
  onAssign: (item: InventoryItem) => void;
  onCancel: () => void;
}) {
  "use no memo";
  const colors = useColors();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery ?? "");
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(initialShowCreateForm ?? false);
  const [newVendor, setNewVendor] = useState("");
  const [newBinLocation, setNewBinLocation] = useState("");
  const [vendorError, setVendorError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchMutation = useSearchInventory();
  const searchMutationRef = useRef(searchMutation);
  useEffect(() => { searchMutationRef.current = searchMutation; }, [searchMutation]);
  const createMutation = useUpsertInventoryBatch();
  const lookupMutation = useSearchInventory();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  useEffect(() => {
    if (!visible) {
      setQuery(""); setDebouncedQuery(""); setCreateError(null);
      setShowCreateForm(false); setNewVendor(""); setNewBinLocation(""); setVendorError(null);
      return;
    }
    if (initialQuery) {
      setQuery(initialQuery);
      setDebouncedQuery(initialQuery);
    }
    if (initialShowCreateForm) {
      setShowCreateForm(true);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible || !debouncedQuery.trim()) return;
    searchMutationRef.current.mutate({ data: { keywords: debouncedQuery, confidenceThreshold: 20 } });
  }, [debouncedQuery, visible]);

  const handleOpenCreateForm = useCallback(() => {
    setShowCreateForm(true);
    setNewVendor("");
    setNewBinLocation("");
    setVendorError(null);
    setCreateError(null);
  }, []);

  const handleCancelCreateForm = useCallback(() => {
    setShowCreateForm(false);
    setVendorError(null);
    setCreateError(null);
  }, []);

  const handleConfirmCreate = useCallback(async () => {
    const catalogCode = query.trim();
    const vendorCode = newVendor.trim();
    if (!catalogCode) return;
    if (!vendorCode) { setVendorError("Vendor code is required"); return; }
    setVendorError(null);
    setCreateError(null);
    const bins = newBinLocation.trim() ? [newBinLocation.trim()] : [];
    try {
      await createMutation.mutateAsync({
        data: { items: [{ catalog: catalogCode, vendor: vendorCode, binLocations: bins }] },
      });
      queryClient.invalidateQueries({ queryKey: getListInventoryQueryKey() });
      const result = await lookupMutation.mutateAsync({
        data: { keywords: catalogCode, catalog: catalogCode, confidenceThreshold: 0 },
      });
      const created = result.results.find(
        (r) => r.item.catalog.toLowerCase() === catalogCode.toLowerCase(),
      );
      if (created) {
        onAssign(created.item);
      } else {
        setCreateError("Item created but could not be retrieved. Search for it manually.");
      }
    } catch {
      setCreateError("Failed to create item. Please try again.");
    }
  }, [query, newVendor, newBinLocation, createMutation, lookupMutation, queryClient, onAssign]);

  const isCreating = createMutation.isPending || lookupMutation.isPending;

  const prefix = shelfPrefix?.trim().toLowerCase() ?? "";
  const allResults = searchMutation.data?.results ?? [];
  const shelfFiltered = prefix
    ? allResults.filter(r =>
        r.item.binLocations.some(b => b.toLowerCase().startsWith(prefix))
      )
    : allResults;
  const results = shelfFiltered.length > 0 ? shelfFiltered : allResults;
  const isFiltered = prefix && shelfFiltered.length > 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[pickerStyles.container, { backgroundColor: colors.background }]}
      >
        <View style={[pickerStyles.header, { borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[pickerStyles.title, { color: colors.foreground }]}>Assign Barcode</Text>
            <Text style={[pickerStyles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
              Code: {barcodeCode}
            </Text>
            {isFiltered ? (
              <Text style={[pickerStyles.sub, { color: colors.primary, marginTop: 2 }]} numberOfLines={1}>
                Filtered to shelf: {shelfPrefix}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={onCancel} style={[pickerStyles.closeBtn, { backgroundColor: colors.muted }]}>
            <Text style={{ color: colors.foreground, fontSize: 14 }}>✕</Text>
          </Pressable>
        </View>

        <View style={{ padding: 12 }}>
          <KeyboardDoneInput
            value={query}
            onChangeText={setQuery}
            placeholder={prefix ? `Search parts on shelf ${shelfPrefix}…` : "Search or enter new catalog #…"}
            placeholderTextColor={colors.mutedForeground}
            autoFocus
            style={[pickerStyles.searchInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
            autoCorrect={false}
            autoCapitalize="characters"
          />
        </View>

        {showCreateForm ? (
          <View style={[pickerStyles.createForm, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={[pickerStyles.createFormTitle, { color: colors.foreground }]}>
              New item — catalog: <Text style={{ color: colors.primary }}>{query.trim()}</Text>
            </Text>

            <Text style={[pickerStyles.createFormLabel, { color: colors.mutedForeground }]}>
              Vendor code <Text style={{ color: colors.destructive }}>*</Text>
            </Text>
            <KeyboardDoneInput
              value={newVendor}
              onChangeText={(t) => { setNewVendor(t); setVendorError(null); }}
              placeholder="e.g. HUBBELL"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="characters"
              autoCorrect={false}
              style={[pickerStyles.createFormInput, {
                backgroundColor: colors.background,
                borderColor: vendorError ? colors.destructive : colors.border,
                color: colors.foreground,
              }]}
            />
            {vendorError ? (
              <Text style={{ color: colors.destructive, fontSize: 11, marginBottom: 6, fontFamily: "Inter_400Regular" }}>{vendorError}</Text>
            ) : null}

            <Text style={[pickerStyles.createFormLabel, { color: colors.mutedForeground }]}>
              Primary bin location <Text style={{ color: colors.mutedForeground }}>(optional)</Text>
            </Text>
            <KeyboardDoneInput
              value={newBinLocation}
              onChangeText={setNewBinLocation}
              placeholder="e.g. A-12-3"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="characters"
              autoCorrect={false}
              style={[pickerStyles.createFormInput, {
                backgroundColor: colors.background,
                borderColor: colors.border,
                color: colors.foreground,
              }]}
            />

            {createError ? (
              <Text style={{ color: colors.destructive, fontSize: 12, marginBottom: 6, fontFamily: "Inter_400Regular" }}>{createError}</Text>
            ) : null}

            {isCreating ? (
              <View style={{ alignItems: "center", paddingVertical: 12 }}>
                <ActivityIndicator color={colors.primary} />
                <Text style={{ color: colors.mutedForeground, fontSize: 13, marginTop: 8, fontFamily: "Inter_400Regular" }}>
                  Creating new item…
                </Text>
              </View>
            ) : (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                <Pressable
                  onPress={handleCancelCreateForm}
                  style={[pickerStyles.createFormBtn, { backgroundColor: colors.background, borderColor: colors.border, flex: 1 }]}
                >
                  <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Inter_500Medium" }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleConfirmCreate}
                  style={[pickerStyles.createFormBtn, { backgroundColor: colors.primary, borderColor: colors.primary, flex: 2 }]}
                >
                  <Text style={{ color: colors.primaryForeground, fontSize: 13, fontFamily: "Inter_500Medium" }}>Create & assign</Text>
                </Pressable>
              </View>
            )}
          </View>
        ) : null}

        {!showCreateForm && createError ? (
          <Text style={[pickerStyles.errorText, { color: colors.destructive }]}>{createError}</Text>
        ) : null}

        {isCreating && !showCreateForm ? (
          <View style={{ padding: 24, alignItems: "center" }}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[{ color: colors.mutedForeground, fontSize: 13, marginTop: 8, fontFamily: "Inter_400Regular" }]}>
              Creating new item…
            </Text>
          </View>
        ) : !showCreateForm && searchMutation.isPending ? (
          <View style={{ padding: 24, alignItems: "center" }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : !showCreateForm ? (
          <FlatList
            data={results}
            keyExtractor={(r) => String(r.item.id)}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              debouncedQuery.trim() ? (
                <Pressable
                  onPress={handleOpenCreateForm}
                  style={[pickerStyles.createRow, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "44" }]}
                >
                  <Text style={[pickerStyles.createIcon, { color: colors.primary }]}>＋</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[pickerStyles.createLabel, { color: colors.primary }]}>
                      Add as new item
                    </Text>
                    <Text style={[pickerStyles.createCatalog, { color: colors.foreground }]} numberOfLines={1}>
                      {debouncedQuery.trim()}
                    </Text>
                  </View>
                </Pressable>
              ) : null
            }
            renderItem={({ item: r }) => (
              <Pressable
                onPress={() => onAssign(r.item)}
                style={[pickerStyles.resultRow, { borderBottomColor: colors.border }]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={[pickerStyles.resultCatalog, { color: colors.foreground, flex: 1 }]}>
                    {r.item.catalog}
                  </Text>
                  {prefix && r.item.binLocations.some(b => b.toLowerCase().startsWith(prefix)) ? (
                    <View style={[pickerStyles.shelfBadge, { backgroundColor: colors.primary + "22" }]}>
                      <Text style={[pickerStyles.shelfBadgeText, { color: colors.primary }]}>
                        {r.item.binLocations.find(b => b.toLowerCase().startsWith(prefix))}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[pickerStyles.resultVendor, { color: colors.mutedForeground }]}>
                  {r.item.vendor}
                </Text>
                {r.item.description ? (
                  <Text style={[pickerStyles.resultDesc, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {r.item.description}
                  </Text>
                ) : null}
              </Pressable>
            )}
            ListEmptyComponent={
              debouncedQuery.trim() && !searchMutation.isPending ? (
                <Text style={[pickerStyles.emptyText, { color: colors.mutedForeground }]}>
                  No existing items match — use "Add as new item" above.
                </Text>
              ) : !debouncedQuery.trim() ? (
                <Text style={[pickerStyles.emptyText, { color: colors.mutedForeground }]}>
                  Type a catalog # to search or add a new item…
                </Text>
              ) : null
            }
          />
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

export const pickerStyles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    paddingTop: 20,
    borderBottomWidth: 1,
    gap: 8,
  },
  title: { fontSize: 18, fontFamily: "Inter_700Bold" },
  sub: { fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  searchInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  resultRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  resultCatalog: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  resultVendor: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  resultDesc: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  emptyText: { padding: 24, textAlign: "center", fontSize: 13, fontFamily: "Inter_400Regular" },
  shelfBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    flexShrink: 1,
  },
  shelfBadgeText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  createRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  createIcon: { fontSize: 22, lineHeight: 26 },
  createLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.4, textTransform: "uppercase" },
  createCatalog: { fontSize: 14, fontFamily: "Inter_700Bold", marginTop: 2 },
  errorText: { fontSize: 12, fontFamily: "Inter_400Regular", paddingHorizontal: 16, paddingBottom: 4 },
  createForm: {
    margin: 12,
    marginTop: 4,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  createFormTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 12,
  },
  createFormLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  createFormInput: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginBottom: 10,
  },
  createFormBtn: {
    borderWidth: 1,
    borderRadius: 7,
    paddingVertical: 10,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
});
