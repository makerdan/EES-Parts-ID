import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";

import type { FilterValues } from "@/components/FilterPanel";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useColors } from "@/hooks/useColors";
import { API_BASE } from "@/utils/apiBase";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface ItemTypeNode {
  slug: string;
  label: string;
  count: number;
}

interface SubcategoryNode {
  slug: string;
  label: string;
  count: number;
  itemTypes: Array<ItemTypeNode>;
}

interface CategoryNode {
  slug: string;
  label: string;
  color: string;
  count: number;
  subcategories: Array<SubcategoryNode>;
}

interface CategoriesResponse {
  categories: Array<CategoryNode>;
}

type Level = "categories" | "subcategories" | "itemTypes";

type DimFilters = Pick<
  FilterValues,
  "minWidth" | "maxWidth" | "minHeight" | "maxHeight" | "minDiameter" | "maxDiameter"
>;

interface BrowseByCategoryProps {
  onSelectCategory: (slug: string, label: string) => void;
  onClose: () => void;
  fontScale?: number;
  dimFilters: DimFilters;
  onDimFilterChange: (key: keyof DimFilters, value: string) => void;
}

export function BrowseByCategory({
  onSelectCategory,
  onClose,
  fontScale = 1.0,
  dimFilters,
  onDimFilterChange,
}: BrowseByCategoryProps) {
  "use no memo";
  const colors = useColors();
  const [data, setData] = useState<CategoriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [level, setLevel] = useState<Level>("categories");
  const [selectedCategory, setSelectedCategory] = useState<CategoryNode | null>(null);
  const [selectedSubcategory, setSelectedSubcategory] = useState<SubcategoryNode | null>(null);

  // ── Dimension filter collapse state ──────────────────────────────────────
  const [dimCollapsed, setDimCollapsed] = useState(true);
  const dimChevronAnim = useRef(new Animated.Value(0)).current;

  const toggleDimensions = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const toCollapsed = !dimCollapsed;
    setDimCollapsed(toCollapsed);
    Animated.timing(dimChevronAnim, {
      toValue: toCollapsed ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  const dimChevronRotate = dimChevronAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "180deg"],
  });

  const activeDimCount =
    (dimFilters.minWidth.trim() !== "" || dimFilters.maxWidth.trim() !== "" ? 1 : 0) +
    (dimFilters.minHeight.trim() !== "" || dimFilters.maxHeight.trim() !== "" ? 1 : 0) +
    (dimFilters.minDiameter.trim() !== "" || dimFilters.maxDiameter.trim() !== "" ? 1 : 0);

  const clearAllDims = () => {
    onDimFilterChange("minWidth", "");
    onDimFilterChange("maxWidth", "");
    onDimFilterChange("minHeight", "");
    onDimFilterChange("maxHeight", "");
    onDimFilterChange("minDiameter", "");
    onDimFilterChange("maxDiameter", "");
  };

  // Debounce dim filters so we don't fire a new request on every keystroke.
  // We stringify the active values into a single key; when it stabilises after
  // 400 ms of inactivity we trigger a fresh fetch.
  const dimKey = [
    dimFilters.minWidth, dimFilters.maxWidth,
    dimFilters.minHeight, dimFilters.maxHeight,
    dimFilters.minDiameter, dimFilters.maxDiameter,
  ].join("|");

  const [debouncedDimKey, setDebouncedDimKey] = useState(dimKey);
  const dimFiltersRef = useRef(dimFilters);
  dimFiltersRef.current = dimFilters;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedDimKey(dimKey), 400);
    return () => clearTimeout(timer);
  }, [dimKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Build URL — append any active dimension filters as query params so the
    // server can narrow counts to items that match the current size filter.
    const params = new URLSearchParams();
    const f = dimFiltersRef.current;
    if (f.minWidth.trim())    params.set("minWidth",    f.minWidth.trim());
    if (f.maxWidth.trim())    params.set("maxWidth",    f.maxWidth.trim());
    if (f.minHeight.trim())   params.set("minHeight",   f.minHeight.trim());
    if (f.maxHeight.trim())   params.set("maxHeight",   f.maxHeight.trim());
    if (f.minDiameter.trim()) params.set("minDiameter", f.minDiameter.trim());
    if (f.maxDiameter.trim()) params.set("maxDiameter", f.maxDiameter.trim());
    const qs = params.toString();
    const url = qs
      ? `${API_BASE}/inventory/categories?${qs}`
      : `${API_BASE}/inventory/categories`;

    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CategoriesResponse>;
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedDimKey]);

  function handleBack() {
    if (level === "itemTypes") {
      setLevel("subcategories");
      setSelectedSubcategory(null);
    } else if (level === "subcategories") {
      setLevel("categories");
      setSelectedCategory(null);
    } else {
      onClose();
    }
  }

  function breadcrumbTitle(): string {
    if (level === "categories") return "Browse by Category";
    if (level === "subcategories" && selectedCategory) return selectedCategory.label;
    if (level === "itemTypes" && selectedSubcategory) return selectedSubcategory.label;
    return "Browse by Category";
  }

  const accentColor = selectedCategory?.color ?? colors.primary;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.card }]}>
        <Pressable onPress={handleBack} style={styles.backBtn} hitSlop={8}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          {level !== "categories" && selectedCategory ? (
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]} numberOfLines={1}>
              {level === "itemTypes" && selectedCategory ? selectedCategory.label : "Browse by Category"}
            </Text>
          ) : null}
          <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
            {breadcrumbTitle()}
          </Text>
        </View>
        <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
          <Feather name="x" size={20} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {/* ── Dimension filter panel ── */}
      <View style={[styles.dimPanel, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Pressable
          style={styles.dimPanelHeader}
          onPress={toggleDimensions}
          hitSlop={4}
        >
          <Feather name="maximize-2" size={14} color={activeDimCount > 0 ? colors.primary : colors.mutedForeground} />
          <Text style={[styles.dimPanelTitle, { color: activeDimCount > 0 ? colors.primary : colors.mutedForeground }]}>
            Filter by Size (mm)
          </Text>
          {activeDimCount > 0 && (
            <View style={[styles.dimBadge, { backgroundColor: colors.primary }]}>
              <Text style={[styles.dimBadgeText, { color: colors.primaryForeground }]}>
                {activeDimCount} active
              </Text>
            </View>
          )}
          <View style={{ flex: 1 }} />
          {activeDimCount > 0 && (
            <Pressable onPress={clearAllDims} hitSlop={8} style={{ marginRight: 8 }}>
              <Text style={[styles.clearBtn, { color: colors.primary }]}>Clear all</Text>
            </Pressable>
          )}
          <Animated.View style={{ transform: [{ rotate: dimChevronRotate }] }}>
            <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
          </Animated.View>
        </Pressable>

        {!dimCollapsed && (
          <View style={styles.dimInputsContainer}>
            {/* Width */}
            <View style={styles.dimRow}>
              <View style={[styles.dimSectionLabel, { borderLeftColor: colors.primary }]}>
                <Text style={[styles.dimSectionLabelText, { color: colors.mutedForeground }]}>WIDTH</Text>
              </View>
              <View style={styles.dimRangeRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Min</Text>
                  <KeyboardDoneInput
                    value={dimFilters.minWidth}
                    onChangeText={v => onDimFilterChange("minWidth", v.replace(/[^0-9.]/g, ""))}
                    placeholder="e.g. 20"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="numeric"
                    style={[styles.dimInput, {
                      backgroundColor: colors.muted,
                      borderColor: dimFilters.minWidth ? colors.primary : colors.border,
                      color: colors.foreground,
                    }]}
                  />
                </View>
                <Text style={[styles.dimDash, { color: colors.mutedForeground }]}>–</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Max</Text>
                  <KeyboardDoneInput
                    value={dimFilters.maxWidth}
                    onChangeText={v => onDimFilterChange("maxWidth", v.replace(/[^0-9.]/g, ""))}
                    placeholder="e.g. 50"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="numeric"
                    style={[styles.dimInput, {
                      backgroundColor: colors.muted,
                      borderColor: dimFilters.maxWidth ? colors.primary : colors.border,
                      color: colors.foreground,
                    }]}
                  />
                </View>
              </View>
            </View>

            {/* Height */}
            <View style={styles.dimRow}>
              <View style={[styles.dimSectionLabel, { borderLeftColor: colors.primary }]}>
                <Text style={[styles.dimSectionLabelText, { color: colors.mutedForeground }]}>HEIGHT</Text>
              </View>
              <View style={styles.dimRangeRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Min</Text>
                  <KeyboardDoneInput
                    value={dimFilters.minHeight}
                    onChangeText={v => onDimFilterChange("minHeight", v.replace(/[^0-9.]/g, ""))}
                    placeholder="e.g. 15"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="numeric"
                    style={[styles.dimInput, {
                      backgroundColor: colors.muted,
                      borderColor: dimFilters.minHeight ? colors.primary : colors.border,
                      color: colors.foreground,
                    }]}
                  />
                </View>
                <Text style={[styles.dimDash, { color: colors.mutedForeground }]}>–</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Max</Text>
                  <KeyboardDoneInput
                    value={dimFilters.maxHeight}
                    onChangeText={v => onDimFilterChange("maxHeight", v.replace(/[^0-9.]/g, ""))}
                    placeholder="e.g. 40"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="numeric"
                    style={[styles.dimInput, {
                      backgroundColor: colors.muted,
                      borderColor: dimFilters.maxHeight ? colors.primary : colors.border,
                      color: colors.foreground,
                    }]}
                  />
                </View>
              </View>
            </View>

            {/* Diameter */}
            <View style={[styles.dimRow, { marginBottom: 0 }]}>
              <View style={[styles.dimSectionLabel, { borderLeftColor: colors.primary }]}>
                <Text style={[styles.dimSectionLabelText, { color: colors.mutedForeground }]}>DIAM.</Text>
              </View>
              <View style={styles.dimRangeRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Min</Text>
                  <KeyboardDoneInput
                    value={dimFilters.minDiameter}
                    onChangeText={v => onDimFilterChange("minDiameter", v.replace(/[^0-9.]/g, ""))}
                    placeholder="e.g. 10"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="numeric"
                    style={[styles.dimInput, {
                      backgroundColor: colors.muted,
                      borderColor: dimFilters.minDiameter ? colors.primary : colors.border,
                      color: colors.foreground,
                    }]}
                  />
                </View>
                <Text style={[styles.dimDash, { color: colors.mutedForeground }]}>–</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.dimLabel, { color: colors.mutedForeground }]}>Max</Text>
                  <KeyboardDoneInput
                    value={dimFilters.maxDiameter}
                    onChangeText={v => onDimFilterChange("maxDiameter", v.replace(/[^0-9.]/g, ""))}
                    placeholder="e.g. 25"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="numeric"
                    style={[styles.dimInput, {
                      backgroundColor: colors.muted,
                      borderColor: dimFilters.maxDiameter ? colors.primary : colors.border,
                      color: colors.foreground,
                    }]}
                  />
                </View>
              </View>
            </View>
          </View>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.hintText, { color: colors.mutedForeground, marginTop: 12 }]}>
            Loading categories…
          </Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>
            Could not load categories. Check your connection.
          </Text>
        </View>
      ) : !data ? null : level === "categories" ? (
        <CategoryGrid
          categories={data.categories}
          colors={colors}
          fontScale={fontScale}
          onSelect={(cat) => {
            setSelectedCategory(cat);
            setLevel("subcategories");
          }}
        />
      ) : level === "subcategories" && selectedCategory ? (
        <SubcategoryList
          subcategories={selectedCategory.subcategories}
          accentColor={accentColor}
          colors={colors}
          fontScale={fontScale}
          onSelect={(sub) => {
            if (sub.itemTypes.length === 0) {
              onSelectCategory(sub.slug, sub.label);
            } else {
              setSelectedSubcategory(sub);
              setLevel("itemTypes");
            }
          }}
          onSelectAll={() => {
            onSelectCategory(selectedCategory.slug, selectedCategory.label);
          }}
          parentLabel={selectedCategory.label}
          parentCount={selectedCategory.count}
        />
      ) : level === "itemTypes" && selectedSubcategory ? (
        <ItemTypeList
          itemTypes={selectedSubcategory.itemTypes}
          accentColor={accentColor}
          colors={colors}
          fontScale={fontScale}
          onSelect={(it) => {
            onSelectCategory(it.slug, it.label);
          }}
          onSelectAll={() => {
            onSelectCategory(selectedSubcategory.slug, selectedSubcategory.label);
          }}
          parentLabel={selectedSubcategory.label}
          parentCount={selectedSubcategory.count}
        />
      ) : null}
    </View>
  );
}

interface ColorMap {
  background: string;
  card: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  muted: string;
  primary: string;
  primaryForeground: string;
  destructive: string;
}

function CountBadge({ count, color, fontScale = 1.0 }: { count: number; color: string; fontScale?: number }) {
  return (
    <View style={[styles.countBadge, { backgroundColor: count > 0 ? color + "22" : "#9CA3AF22" }]}>
      <Text style={[styles.countBadgeText, { color: count > 0 ? color : "#9CA3AF", fontSize: Math.round(11 * fontScale) }]}>
        {count > 0 ? count : "0 items"}
      </Text>
    </View>
  );
}

function CategoryGrid({
  categories,
  colors,
  onSelect,
  fontScale = 1.0,
}: {
  categories: Array<CategoryNode>;
  colors: ColorMap;
  onSelect: (cat: CategoryNode) => void;
  fontScale?: number;
}) {
  return (
    <FlatList
      data={categories}
      keyExtractor={item => item.slug}
      numColumns={2}
      contentContainerStyle={styles.gridContent}
      columnWrapperStyle={styles.gridRow}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => {
        const isEmpty = item.count === 0;
        return (
          <Pressable
            style={[styles.categoryTile, {
              backgroundColor: colors.card,
              borderColor: item.color + (isEmpty ? "22" : "44"),
              borderLeftColor: isEmpty ? item.color + "55" : item.color,
              opacity: isEmpty ? 0.5 : 1,
            }]}
            onPress={() => onSelect(item)}
          >
            <View style={[styles.categoryTileAccent, { backgroundColor: item.color }]} />
            <Text
              style={[styles.categoryTileLabel, {
                color: isEmpty ? colors.mutedForeground : colors.foreground,
                fontSize: Math.round(13 * fontScale),
              }]}
              numberOfLines={2}
            >
              {item.label}
            </Text>
            <CountBadge count={item.count} color={item.color} fontScale={fontScale} />
          </Pressable>
        );
      }}
    />
  );
}

function SubcategoryList({
  subcategories,
  accentColor,
  colors,
  onSelect,
  onSelectAll,
  parentLabel,
  parentCount,
  fontScale = 1.0,
}: {
  subcategories: Array<SubcategoryNode>;
  accentColor: string;
  colors: ColorMap;
  onSelect: (sub: SubcategoryNode) => void;
  onSelectAll: () => void;
  parentLabel: string;
  parentCount: number;
  fontScale?: number;
}) {
  return (
    <FlatList
      data={subcategories}
      keyExtractor={item => item.slug}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={() => (
        <Pressable
          style={[styles.listRow, styles.allRow, {
            backgroundColor: accentColor + "11",
            borderColor: accentColor + "55",
          }]}
          onPress={onSelectAll}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.listRowLabel, { color: accentColor, fontFamily: "Inter_700Bold", fontSize: Math.round(14 * fontScale) }]}>
              All {parentLabel}
            </Text>
            <Text style={[styles.listRowSub, { color: colors.mutedForeground, fontSize: Math.round(12 * fontScale) }]}>
              Show all {parentCount} items in this category
            </Text>
          </View>
          <Feather name="search" size={16} color={accentColor} />
        </Pressable>
      )}
      renderItem={({ item }) => (
        <Pressable
          style={[styles.listRow, {
            backgroundColor: colors.card,
            borderColor: colors.border,
            opacity: item.count === 0 ? 0.5 : 1,
          }]}
          onPress={() => onSelect(item)}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.listRowLabel, { color: colors.foreground, fontSize: Math.round(14 * fontScale) }]}>{item.label}</Text>
            <Text style={[styles.listRowSub, { color: colors.mutedForeground, fontSize: Math.round(12 * fontScale) }]}>
              {item.itemTypes.length} type{item.itemTypes.length !== 1 ? "s" : ""}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <CountBadge count={item.count} color={accentColor} fontScale={fontScale} />
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </View>
        </Pressable>
      )}
    />
  );
}

function ItemTypeList({
  itemTypes,
  accentColor,
  colors,
  onSelect,
  onSelectAll,
  parentLabel,
  parentCount,
  fontScale = 1.0,
}: {
  itemTypes: Array<ItemTypeNode>;
  accentColor: string;
  colors: ColorMap;
  onSelect: (it: ItemTypeNode) => void;
  onSelectAll: () => void;
  parentLabel: string;
  parentCount: number;
  fontScale?: number;
}) {
  return (
    <FlatList
      data={itemTypes}
      keyExtractor={item => item.slug}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={() => (
        <Pressable
          style={[styles.listRow, styles.allRow, {
            backgroundColor: accentColor + "11",
            borderColor: accentColor + "55",
          }]}
          onPress={onSelectAll}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.listRowLabel, { color: accentColor, fontFamily: "Inter_700Bold", fontSize: Math.round(14 * fontScale) }]}>
              All {parentLabel}
            </Text>
            <Text style={[styles.listRowSub, { color: colors.mutedForeground, fontSize: Math.round(12 * fontScale) }]}>
              Show all {parentCount} items
            </Text>
          </View>
          <Feather name="search" size={16} color={accentColor} />
        </Pressable>
      )}
      renderItem={({ item }) => (
        <Pressable
          style={[styles.listRow, {
            backgroundColor: colors.card,
            borderColor: colors.border,
            opacity: item.count === 0 ? 0.5 : 1,
          }]}
          onPress={() => onSelect(item)}
        >
          <View style={{ flex: 1 }}>
            <Text style={[styles.listRowLabel, { color: colors.foreground, fontSize: Math.round(14 * fontScale) }]}>{item.label}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <CountBadge count={item.count} color={accentColor} fontScale={fontScale} />
            <Feather name="search" size={16} color={colors.mutedForeground} />
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  headerTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 11, fontFamily: "Inter_400Regular", marginBottom: 1 },
  backBtn: { padding: 4 },
  closeBtn: { padding: 4 },
  // ── Dimension filter panel ──
  dimPanel: {
    borderBottomWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
  },
  dimPanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dimPanelTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.3,
  },
  dimBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  dimBadgeText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
  },
  clearBtn: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  dimInputsContainer: {
    marginTop: 10,
    gap: 8,
  },
  dimRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    marginBottom: 8,
  },
  dimSectionLabel: {
    width: 40,
    paddingLeft: 6,
    borderLeftWidth: 2,
    paddingBottom: 8,
  },
  dimSectionLabelText: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
  },
  dimRangeRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
  },
  dimDash: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    paddingBottom: 8,
  },
  dimLabel: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    marginBottom: 4,
    letterSpacing: 0.2,
  },
  dimInput: {
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  // ── Category list/grid ──
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  hintText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium", textAlign: "center" },
  gridContent: { padding: 12, paddingBottom: 400 },
  gridRow: { gap: 10, marginBottom: 10 },
  categoryTile: {
    flex: 1,
    minHeight: 90,
    borderRadius: 12,
    borderWidth: 1,
    borderLeftWidth: 4,
    padding: 14,
    gap: 8,
    overflow: "hidden",
  },
  categoryTileAccent: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    opacity: 0.5,
  },
  categoryTileLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", lineHeight: 18 },
  countBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
  },
  countBadgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  listContent: { padding: 12, gap: 8 },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    gap: 12,
  },
  allRow: { marginBottom: 4 },
  listRowLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 2 },
  listRowSub: { fontSize: 12, fontFamily: "Inter_400Regular" },
});
