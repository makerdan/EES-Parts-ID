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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { ErrorBanner } from '@/components/ErrorBanner';
import { nodeAtPath, visibleChildren, type CategoryTreeNode } from '@/lib/taxonomy';

const BROWSE_TREE_CACHE_KEY = 'parts_id_browse_tree_v1';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : 'http://localhost:8080/api';

export type { CategoryTreeNode } from '@/lib/taxonomy';
export { nodeAtPath, visibleChildren } from '@/lib/taxonomy';

interface BrowseTaxonomyProps {
  /** Called whenever the active drill path changes (e.g. user taps a leaf type). */
  onSelectNode: (node: CategoryTreeNode | null) => void;
  /**
   * Called whenever the top-level category in the drill path changes.
   * Receives the category name (e.g. "Breaker") or null when at the root.
   * Use this to drive category-aware UI outside the taxonomy (e.g. hiding
   * irrelevant filter chips when browsing a specific category).
   */
  onBrowseCategoryChange?: (categoryName: string | null) => void;
  /** Optional pre-supplied tree (e.g. for tests). */
  initialTree?: CategoryTreeNode[];
  /** Increment this to pop the current path up one level (e.g. Back from results). */
  popTrigger?: number;
  /**
   * Called when Android hardware back is pressed at the taxonomy root.
   * Parent should switch back to Search mode. When omitted, the back press
   * bubbles to the navigator (current default behaviour).
   */
  onExitBrowse?: () => void;
}

export default function BrowseTaxonomy({
  onSelectNode,
  onBrowseCategoryChange,
  initialTree,
  popTrigger = 0,
  onExitBrowse,
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
        const cachedTreeRaw = await AsyncStorage.getItem(BROWSE_TREE_CACHE_KEY);
        if (cachedTreeRaw && mounted && !initialTree) {
          try {
            const parsed = JSON.parse(cachedTreeRaw) as CategoryTreeNode[];
            setTree(parsed);
            setUsingCache(true);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

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
        AsyncStorage.setItem(BROWSE_TREE_CACHE_KEY, JSON.stringify(data.tree)).catch(
          () => undefined
        );
      } catch (err) {
        if (!mounted) return;
        // Keep cached tree if we have one — only surface the error otherwise.
        setError(String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [initialTree]);

  // ── Persist drill path ───────────────────────────────────────────────────
  // Guard: don't call onSelectNode during the initial path/tree restore.
  // BrowseTaxonomy is conditionally rendered, so this ref resets to false
  // every time the user enters Browse mode — ensuring the component always
  // starts with the taxonomy visible and results only load after an explicit
  // tap, even when a previous path is cached in AsyncStorage.
  const userHasNavigated = useRef(false);
  const crumbsScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!userHasNavigated.current) return;
    onSelectNode(nodeAtPath(tree, path));
  }, [path, tree, onSelectNode]);

  // Pop one level when the parent signals Back from the results screen.
  const prevPopTrigger = useRef(popTrigger);
  useEffect(() => {
    if (popTrigger === prevPopTrigger.current) return;
    prevPopTrigger.current = popTrigger;
    userHasNavigated.current = true;
    setPath((prev) => prev.slice(0, -1));
  }, [popTrigger]);

  useEffect(() => {
    if (path.length > 0) {
      crumbsScrollRef.current?.scrollToEnd({ animated: true });
    }
  }, [path]);

  const children = useMemo(() => visibleChildren(tree, path), [tree, path]);
  const breadcrumbs = useMemo(() => {
    const out: { slug: string; name: string }[] = [];
    let level = tree;
    for (const slug of path) {
      const found = level.find((n) => n.slug === slug);
      if (!found) break;
      out.push({ slug: found.slug, name: found.name });
      level = found.children;
    }
    return out;
  }, [tree, path]);

  // Notify the parent whenever the top-level category in the drill path
  // changes so it can drive category-aware UI (e.g. hiding irrelevant chips).
  useEffect(() => {
    onBrowseCategoryChange?.(breadcrumbs[0]?.name ?? null);
  }, [breadcrumbs, onBrowseCategoryChange]);

  const drillInto = useCallback((slug: string) => {
    userHasNavigated.current = true;
    setPath((prev) => [...prev, slug]);
  }, []);
  const popTo = useCallback((depth: number) => {
    userHasNavigated.current = true;
    setPath((prev) => prev.slice(0, depth));
  }, []);

  // ── Android hardware back gesture ────────────────────────────────────────
  // When drilled into a category level, the back press pops one level up.
  // At the root (path.length === 0): if the parent supplied `onExitBrowse`
  // we invoke it (and consume the event) so the user lands back in Search
  // mode instead of exiting the tab. Without that callback we return false
  // and let the event bubble to the navigator (legacy default).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (path.length > 0) {
        popTo(path.length - 1);
        return true;
      }
      if (onExitBrowse) {
        onExitBrowse();
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [path.length, popTo, onExitBrowse]);

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading && tree.length === 0) {
    return (
      <View
        style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <ActivityIndicator color={colors.primary} />
        <Text style={[styles.muted, { color: colors.mutedForeground, marginTop: 8 }]}>
          Loading categories…
        </Text>
      </View>
    );
  }
  if (tree.length === 0 && error) {
    return (
      <View
        style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <ErrorBanner message="Categories unavailable — connect to the network and try again." />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Back button — shown whenever drilled into a level */}
      {path.length > 0 ? (
        <Pressable onPress={() => popTo(path.length - 1)} hitSlop={8} style={styles.backBtn}>
          <Feather name="chevron-left" size={18} color={colors.foreground} />
          <Text style={[styles.backLabel, { color: colors.foreground }]}>Back</Text>
        </Pressable>
      ) : null}
      {/* Breadcrumbs */}
      <ScrollView
        ref={crumbsScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.crumbs}
      >
        <Pressable onPress={() => popTo(0)} hitSlop={8}>
          <Text
            style={[
              styles.crumb,
              { color: path.length === 0 ? colors.foreground : colors.primary },
            ]}
          >
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

      {/* Children list — plain mapped View; FlatList with scrollEnabled={false}
          disables virtualization anyway and adds unnecessary overhead here
          since this list lives inside a parent ScrollView. */}
      <View>
        {children.length === 0 ? (
          <Text style={[styles.muted, { color: colors.mutedForeground, padding: 12 }]}>
            No items in this category yet.
          </Text>
        ) : (
          children.map((item, idx) => (
            <React.Fragment key={item.slug}>
              {idx > 0 ? <View style={[styles.sep, { backgroundColor: colors.border }]} /> : null}
              <Pressable
                onPress={() =>
                  item.children.length > 0
                    ? drillInto(item.slug)
                    : setPath((prev) => [...prev, item.slug])
                }
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed ? colors.muted : 'transparent' },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowName, { color: colors.foreground }]}>{item.name}</Text>
                  <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                    {item.itemCount} item{item.itemCount === 1 ? '' : 's'}
                    {item.children.length > 0 ? ` · ${item.children.length} sub-categories` : ''}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </Pressable>
            </React.Fragment>
          ))
        )}
      </View>
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
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginBottom: 8,
  },
  backLabel: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  crumbs: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 8,
    gap: 4,
  },
  crumbRow: { flexDirection: 'row', alignItems: 'center' },
  crumb: { fontSize: 13, fontWeight: '600' },
  crumbSep: { marginHorizontal: 6, fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 6,
  },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12, marginTop: 2 },
  sep: { height: StyleSheet.hairlineWidth },
  muted: { fontSize: 12, textAlign: 'center' },
});
