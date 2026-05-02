/**
 * BrowseTaxonomy — three-level drill-down (Category → Subcategory → Type).
 *
 * Behaviour:
 *  • Fetches /categories/tree on mount; caches it under BROWSE_TREE_CACHE_KEY
 *    so the panel still renders when offline.
 *  • Persists the current drill `path` (array of slugs) to AsyncStorage so
 *    re-opening the app drops the user back where they were.
 *  • Empty branches (`itemCount === 0`) are still shown — taxonomy roots
 *    that classified zero items are usually a hint the rule is missing.
 *  • Calls `onSelectNode(node)` whenever the user taps a node — the parent
 *    screen decides whether to drill or to load items.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import {
  nodeAtPath,
  visibleChildren,
  type CategoryTreeNode,
} from "@/lib/taxonomy";

const BROWSE_TREE_CACHE_KEY = "parts_id_browse_tree_v1";
const BROWSE_PATH_KEY = "parts_id_browse_path_v1";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

export type { CategoryTreeNode } from "@/lib/taxonomy";
export { nodeAtPath, visibleChildren } from "@/lib/taxonomy";

interface BrowseTaxonomyProps {
  /** Called whenever the active drill path changes (e.g. user taps a leaf type). */
  onSelectNode: (node: CategoryTreeNode | null) => void;
  /** Optional pre-supplied tree (e.g. for tests). */
  initialTree?: CategoryTreeNode[];
}

export default function BrowseTaxonomy({
  onSelectNode,
  initialTree,
}: BrowseTaxonomyProps): React.JSX.Element {
  const colors = useColors();
  const [tree, setTree] = useState<CategoryTreeNode[]>(initialTree ?? []);
  const [path, setPath] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(!initialTree);
  const [error, setError] = useState<string | null>(null);
  const [usingCache, setUsingCache] = useState(false);

  // ── Load cached path + tree on mount ────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [cachedTreeRaw, cachedPathRaw] = await Promise.all([
          AsyncStorage.getItem(BROWSE_TREE_CACHE_KEY),
          AsyncStorage.getItem(BROWSE_PATH_KEY),
        ]);
        if (cachedTreeRaw && mounted && !initialTree) {
          try {
            const parsed = JSON.parse(cachedTreeRaw) as CategoryTreeNode[];
            setTree(parsed);
            setUsingCache(true);
          } catch { /* ignore */ }
        }
        if (cachedPathRaw && mounted) {
          try {
            const parsed = JSON.parse(cachedPathRaw) as string[];
            if (Array.isArray(parsed)) setPath(parsed);
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }

      if (initialTree) return;

      // ── Network fetch (fresh) ──────────────────────────────────────────
      try {
        const res = await fetch(`${API_BASE}/categories/tree`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { tree: CategoryTreeNode[] };
        if (!mounted) return;
        setTree(data.tree);
        setUsingCache(false);
        setError(null);
        AsyncStorage.setItem(BROWSE_TREE_CACHE_KEY, JSON.stringify(data.tree)).catch(() => undefined);
      } catch (err) {
        if (!mounted) return;
        // Keep cached tree if we have one — only surface the error otherwise.
        setError(String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [initialTree]);

  // ── Persist drill path ───────────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.setItem(BROWSE_PATH_KEY, JSON.stringify(path)).catch(() => undefined);
    onSelectNode(nodeAtPath(tree, path));
  }, [path, tree, onSelectNode]);

  const children = useMemo(() => visibleChildren(tree, path), [tree, path]);
  const breadcrumbs = useMemo(() => {
    const out: { slug: string; name: string }[] = [];
    let level = tree;
    for (const slug of path) {
      const found = level.find(n => n.slug === slug);
      if (!found) break;
      out.push({ slug: found.slug, name: found.name });
      level = found.children;
    }
    return out;
  }, [tree, path]);

  const drillInto = useCallback((slug: string) => {
    setPath(prev => [...prev, slug]);
  }, []);
  const popTo = useCallback((depth: number) => {
    setPath(prev => prev.slice(0, depth));
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading && tree.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[styles.muted, { color: colors.mutedForeground, marginTop: 8 }]}>Loading categories…</Text>
      </View>
    );
  }
  if (tree.length === 0 && error) {
    return (
      <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.errorText, { color: colors.destructive }]}>Could not load categories.</Text>
        <Text style={[styles.muted, { color: colors.mutedForeground, marginTop: 4 }]}>
          Connect to the network and try again.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Breadcrumbs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.crumbs}
      >
        <Pressable onPress={() => popTo(0)} hitSlop={8}>
          <Text style={[styles.crumb, { color: path.length === 0 ? colors.foreground : colors.primary }]}>
            All Categories
          </Text>
        </Pressable>
        {breadcrumbs.map((c, idx) => (
          <View key={c.slug} style={styles.crumbRow}>
            <Text style={[styles.crumbSep, { color: colors.mutedForeground }]}>›</Text>
            <Pressable onPress={() => popTo(idx + 1)} hitSlop={8}>
              <Text
                style={[
                  styles.crumb,
                  { color: idx === breadcrumbs.length - 1 ? colors.foreground : colors.primary },
                ]}
              >
                {c.name}
              </Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>

      {usingCache ? (
        <Text style={[styles.muted, { color: colors.mutedForeground, marginBottom: 4 }]}>
          Using cached taxonomy (offline).
        </Text>
      ) : null}

      {/* Children list */}
      <FlatList
        data={children}
        keyExtractor={n => n.slug}
        scrollEnabled={false}
        ItemSeparatorComponent={() => (
          <View style={[styles.sep, { backgroundColor: colors.border }]} />
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              item.children.length > 0 ? drillInto(item.slug) : setPath(prev => [...prev, item.slug])
            }
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? colors.muted : "transparent" },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowName, { color: colors.foreground }]}>{item.name}</Text>
              <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                {item.itemCount} item{item.itemCount === 1 ? "" : "s"}
                {item.children.length > 0 ? ` · ${item.children.length} sub-categories` : ""}
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
          </Pressable>
        )}
        ListEmptyComponent={() => (
          <Text style={[styles.muted, { color: colors.mutedForeground, padding: 12 }]}>
            No items in this category yet.
          </Text>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginHorizontal: 12,
    marginBottom: 8,
  },
  crumbs: {
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: 8,
    gap: 4,
  },
  crumbRow: { flexDirection: "row", alignItems: "center" },
  crumb: { fontSize: 13, fontWeight: "600" },
  crumbSep: { marginHorizontal: 6, fontSize: 13 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 6,
  },
  rowName: { fontSize: 15, fontWeight: "600" },
  rowMeta: { fontSize: 12, marginTop: 2 },
  sep: { height: StyleSheet.hairlineWidth },
  muted: { fontSize: 12, textAlign: "center" },
  errorText: { fontSize: 14, textAlign: "center" },
});
