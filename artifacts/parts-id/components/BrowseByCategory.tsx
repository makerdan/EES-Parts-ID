import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

interface ItemTypeNode {
  slug: string;
  label: string;
  count: number;
}

interface SubcategoryNode {
  slug: string;
  label: string;
  count: number;
  itemTypes: ItemTypeNode[];
}

interface CategoryNode {
  slug: string;
  label: string;
  color: string;
  count: number;
  subcategories: SubcategoryNode[];
}

interface CategoriesResponse {
  categories: CategoryNode[];
}

type Level = "categories" | "subcategories" | "itemTypes";

interface BrowseByCategoryProps {
  onSelectCategory: (slug: string, label: string) => void;
  onClose: () => void;
  fontScale?: number;
}

export function BrowseByCategory({ onSelectCategory, onClose, fontScale = 1.0 }: BrowseByCategoryProps) {
  const colors = useColors();
  const [data, setData] = useState<CategoriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [level, setLevel] = useState<Level>("categories");
  const [selectedCategory, setSelectedCategory] = useState<CategoryNode | null>(null);
  const [selectedSubcategory, setSelectedSubcategory] = useState<SubcategoryNode | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/inventory/categories`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CategoriesResponse>;
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

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
  categories: CategoryNode[];
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
  subcategories: SubcategoryNode[];
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
  itemTypes: ItemTypeNode[];
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  hintText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium", textAlign: "center" },
  gridContent: { padding: 12 },
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
