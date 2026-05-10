/**
 * ClassificationReviewSection — admin card shown in the inventory tab enrichment panel.
 *
 * Fetches low-confidence AI classification assignments from the review queue
 * and lets admins Confirm (keep), Reclassify (pick a new type), or Skip
 * (defer to end of queue) each item. Paginated 50 per page via "Load more".
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  listClassificationReview,
  confirmClassificationReview,
  reclassifyReviewItem,
  skipClassificationReview,
  ApiError,
} from '@workspace/api-client-react';
import type {
  ReviewQueueItem,
  ReviewQueueResponse,
  ReviewActionResponse,
} from '@workspace/api-client-react';

const PAGE_SIZE = 50;

interface TypeNode {
  id: number;
  name: string;
  path: string;
}

interface Props {
  apiBase: string;
  adminHeaders: Record<string, string>;
  onExpiredSession: () => void;
  expandTrigger?: number;
  /** Called after any confirm / reclassify / skip action completes successfully. */
  onReviewAction?: () => void;
}

export default function ClassificationReviewSection({
  apiBase,
  adminHeaders,
  onExpiredSession,
  expandTrigger,
  onReviewAction,
}: Props) {
  const colors = useColors();

  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<number | null>(null);

  // Reclassify modal
  const [reclassifyTarget, setReclassifyTarget] = useState<ReviewQueueItem | null>(null);
  const [typeNodes, setTypeNodes] = useState<TypeNode[]>([]);
  const [typeNodesLoading, setTypeNodesLoading] = useState(false);
  const [reclassifySearch, setReclassifySearch] = useState('');

  // ── Fetch review queue ─────────────────────────────────────────────────────
  const fetchQueue = useCallback(
    async (targetPage: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const data = await listClassificationReview(
          { page: targetPage, limit: PAGE_SIZE },
          { headers: adminHeaders }
        );
        setPendingCount(data.total);
        setHasMore(data.items.length === PAGE_SIZE && targetPage * PAGE_SIZE < data.total);
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setPage(targetPage);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onExpiredSession();
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Network error loading review queue');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [adminHeaders, onExpiredSession]
  );

  // Fetch just the count on mount (without expanding) so the badge is visible.
  useEffect(() => {
    if (pendingCount !== null) return;
    (async () => {
      try {
        const data = await listClassificationReview(
          { page: 1, limit: 1 },
          { headers: adminHeaders }
        );
        setPendingCount(data.total);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onExpiredSession();
        // Other errors are silently ignored — badge stays hidden
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the parent increments expandTrigger (e.g. chip tap), expand and load.
  // Using a counter means every tap fires the effect even if the section was
  // manually collapsed between taps.
  useEffect(() => {
    if (!expandTrigger) return;
    if (!expanded) {
      setExpanded(true);
      void fetchQueue(1, false);
    }
    // fetchQueue is stable (useCallback); expanded is intentionally omitted so
    // repeated taps when already expanded are a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandTrigger]);

  const handleToggle = () => {
    if (!expanded) {
      setExpanded(true);
      void fetchQueue(1, false);
    } else {
      setExpanded(false);
    }
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  const removeItem = (inventoryId: ReviewQueueItem['inventoryId']) => {
    setItems((prev) => prev.filter((it) => it.inventoryId !== inventoryId));
    setPendingCount((prev) => (prev != null && prev > 0 ? prev - 1 : prev));
  };

  const postAction = useCallback(
    async (inventoryId: number, action: 'confirm' | 'skip') => {
      setActingId(inventoryId);
      try {
        const requestOptions = { headers: adminHeaders };
        if (action === 'confirm') {
          await confirmClassificationReview(inventoryId, requestOptions);
          removeItem(inventoryId);
        } else {
          await skipClassificationReview(inventoryId, requestOptions);
          // Re-fetch from page 1: skipped item moved to end of queue.
          void fetchQueue(1, false);
        }
        onReviewAction?.();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onExpiredSession();
          return;
        }
        setError(err instanceof ApiError ? err.message : `Network error during ${action}`);
      } finally {
        setActingId(null);
      }
    },
    [adminHeaders, onExpiredSession, fetchQueue, onReviewAction]
  );

  const handleConfirm = (id: number) => void postAction(id, 'confirm');
  const handleSkip = (id: number) => void postAction(id, 'skip');

  // ── Reclassify ─────────────────────────────────────────────────────────────
  const openReclassify = async (item: ReviewQueueItem) => {
    setReclassifyTarget(item);
    setReclassifySearch('');
    if (typeNodes.length > 0) return;
    setTypeNodesLoading(true);
    try {
      const res = await fetch(`${apiBase}/categories/tree`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        tree: {
          id: number;
          name: string;
          children: { id: number; name: string; children: { id: number; name: string }[] }[];
        }[];
      };
      const flat: TypeNode[] = [];
      for (const cat of data.tree) {
        for (const sub of cat.children ?? []) {
          for (const type of sub.children ?? []) {
            flat.push({
              id: type.id,
              name: type.name,
              path: `${cat.name} › ${sub.name} › ${type.name}`,
            });
          }
        }
      }
      setTypeNodes(flat.sort((a, b) => a.path.localeCompare(b.path)));
    } catch {
      /* silent */
    } finally {
      setTypeNodesLoading(false);
    }
  };

  const handleReclassify = async (categoryNodeId: number) => {
    if (!reclassifyTarget) return;
    const inventoryId = reclassifyTarget.inventoryId;
    setReclassifyTarget(null);
    setActingId(inventoryId);
    try {
      await reclassifyReviewItem(inventoryId, { categoryNodeId }, { headers: adminHeaders });
      removeItem(inventoryId);
      onReviewAction?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onExpiredSession();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Network error during reclassify');
    } finally {
      setActingId(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const filteredTypes = reclassifySearch.trim()
    ? typeNodes.filter((n) => n.path.toLowerCase().includes(reclassifySearch.toLowerCase()))
    : typeNodes;

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Collapsible header */}
      <Pressable
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityLabel={
          expanded ? 'Collapse classification review' : 'Expand classification review'
        }
        style={s.headerRow}
      >
        <View style={s.headerLeft}>
          <Text style={[s.title, { color: colors.foreground }]}>Classification Review</Text>
          {pendingCount != null ? (
            <View style={[s.badge, { backgroundColor: pendingCount > 0 ? '#ef4444' : '#10b981' }]}>
              <Text style={s.badgeText}>{pendingCount}</Text>
            </View>
          ) : (
            <ActivityIndicator
              size="small"
              color={colors.mutedForeground}
              style={{ marginLeft: 4 }}
            />
          )}
        </View>
        <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded ? (
        <>
          <Text style={[s.hint, { color: colors.mutedForeground }]}>
            AI classifications below 70% confidence. Confirm to accept, Reclassify to reassign, or
            Skip to defer.
          </Text>

          {error ? (
            <View style={[s.errorBanner, { backgroundColor: '#ef444422', borderColor: '#ef4444' }]}>
              <Text
                style={{ color: '#ef4444', fontSize: 13, fontFamily: 'Inter_500Medium', flex: 1 }}
              >
                {error}
              </Text>
              <Pressable onPress={() => setError(null)} style={{ paddingLeft: 8 }}>
                <Text style={{ color: '#ef4444', fontSize: 16 }}>✕</Text>
              </Pressable>
            </View>
          ) : null}

          {loading ? (
            <View style={s.center}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : items.length === 0 ? (
            <View style={[s.emptyBox, { backgroundColor: colors.muted }]}>
              <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
                {pendingCount === 0
                  ? 'Queue is empty — all AI classifications reviewed.'
                  : 'No items loaded.'}
              </Text>
            </View>
          ) : (
            items.map((item) => {
              const isActing = actingId === item.inventoryId;
              const confColor = item.confidencePct >= 60 ? '#f59e0b' : '#ef4444';
              return (
                <View
                  key={item.inventoryId}
                  style={[
                    s.row,
                    { backgroundColor: colors.background, borderColor: colors.border },
                  ]}
                >
                  <View style={s.rowTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.catalog, { color: colors.foreground }]} numberOfLines={1}>
                        {item.catalog}
                      </Text>
                      <Text style={[s.vendor, { color: colors.mutedForeground }]} numberOfLines={1}>
                        {item.vendor}
                      </Text>
                    </View>
                    <View style={[s.confBadge, { backgroundColor: confColor + '22' }]}>
                      <Text style={[s.confText, { color: confColor }]}>
                        {item.confidencePct.toFixed(0)}%
                      </Text>
                    </View>
                  </View>

                  {item.description ? (
                    <Text style={[s.desc, { color: colors.mutedForeground }]} numberOfLines={2}>
                      {item.description}
                    </Text>
                  ) : null}

                  <View style={[s.pathRow, { backgroundColor: colors.muted }]}>
                    <Text style={[s.pathText, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {item.categoryPath || 'Uncategorized'}
                    </Text>
                  </View>

                  <View style={s.actionRow}>
                    {isActing ? (
                      <ActivityIndicator size="small" color={colors.primary} style={{ flex: 1 }} />
                    ) : (
                      <>
                        <Pressable
                          onPress={() => handleConfirm(item.inventoryId)}
                          style={[s.actionBtn, { backgroundColor: '#10b981' }]}
                          accessibilityRole="button"
                          accessibilityLabel="Confirm classification"
                        >
                          <Text style={s.actionBtnText}>✓ Confirm</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => void openReclassify(item)}
                          style={[s.actionBtn, { backgroundColor: colors.primary }]}
                          accessibilityRole="button"
                          accessibilityLabel="Reclassify this item"
                        >
                          <Text style={s.actionBtnText}>Reclassify</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => handleSkip(item.inventoryId)}
                          style={[s.actionBtnOutline, { borderColor: colors.border }]}
                          accessibilityRole="button"
                          accessibilityLabel="Skip — defer to end of queue"
                        >
                          <Text style={[s.actionBtnOutlineText, { color: colors.mutedForeground }]}>
                            Skip
                          </Text>
                        </Pressable>
                      </>
                    )}
                  </View>
                </View>
              );
            })
          )}

          {hasMore && !loading ? (
            <Pressable
              onPress={() => void fetchQueue(page + 1, true)}
              disabled={loadingMore}
              style={[s.loadMoreBtn, { borderColor: colors.border }]}
            >
              {loadingMore ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={[s.loadMoreText, { color: colors.primary }]}>Load more</Text>
              )}
            </Pressable>
          ) : null}
        </>
      ) : null}

      {/* Reclassify bottom-sheet modal */}
      <Modal
        visible={reclassifyTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setReclassifyTarget(null)}
      >
        <View style={s.modalOverlay}>
          <View
            style={[s.modalSheet, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={[s.modalHeader, { borderBottomColor: colors.border }]}>
              <Text style={[s.modalTitle, { color: colors.foreground }]}>Choose Category</Text>
              <Pressable
                onPress={() => setReclassifyTarget(null)}
                style={[s.modalClose, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Text style={[s.modalCloseText, { color: colors.foreground }]}>✕</Text>
              </Pressable>
            </View>

            {reclassifyTarget ? (
              <Text
                style={[s.reclassifySubtitle, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {reclassifyTarget.catalog} · {reclassifyTarget.vendor}
              </Text>
            ) : null}

            <View
              style={[s.searchBox, { borderColor: colors.border, backgroundColor: colors.muted }]}
            >
              <Feather
                name="search"
                size={14}
                color={colors.mutedForeground}
                style={{ marginRight: 6 }}
              />
              <TextInput
                value={reclassifySearch}
                onChangeText={setReclassifySearch}
                placeholder="Search categories…"
                placeholderTextColor={colors.mutedForeground}
                style={[s.searchInput, { color: colors.foreground }]}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {typeNodesLoading ? (
              <View style={s.center}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
              <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
                {filteredTypes.map((node) => (
                  <Pressable
                    key={node.id}
                    onPress={() => void handleReclassify(node.id)}
                    style={({ pressed }) => [
                      s.typeRow,
                      {
                        borderBottomColor: colors.border,
                        backgroundColor: pressed ? colors.muted : 'transparent',
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Assign to ${node.path}`}
                  >
                    <Text style={[s.typeRowText, { color: colors.foreground }]}>{node.name}</Text>
                    <Text
                      style={[s.typeRowPath, { color: colors.mutedForeground }]}
                      numberOfLines={1}
                    >
                      {node.path}
                    </Text>
                  </Pressable>
                ))}
                {filteredTypes.length === 0 && !typeNodesLoading ? (
                  <Text
                    style={[
                      s.emptyText,
                      { color: colors.mutedForeground, textAlign: 'center', marginTop: 24 },
                    ]}
                  >
                    No categories match "{reclassifySearch}"
                  </Text>
                ) : null}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 12, marginBottom: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    minWidth: 24,
    alignItems: 'center',
  },
  badgeText: { fontSize: 12, fontFamily: 'Inter_700Bold', color: '#fff' },
  hint: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19 },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  emptyBox: { borderRadius: 8, padding: 16, alignItems: 'center' },
  emptyText: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19 },

  row: { borderRadius: 8, borderWidth: 1, padding: 12, gap: 8 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  catalog: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  vendor: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  confBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-start' },
  confText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  desc: { fontSize: 12, fontFamily: 'Inter_400Regular', lineHeight: 17 },
  pathRow: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  pathText: { fontSize: 11, fontFamily: 'Inter_500Medium' },

  actionRow: { flexDirection: 'row', gap: 6, marginTop: 4 },
  actionBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6, alignItems: 'center' },
  actionBtnText: { fontSize: 12, fontFamily: 'Inter_700Bold', color: '#fff' },
  actionBtnOutline: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
  },
  actionBtnOutlineText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },

  loadMoreBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 4,
  },
  loadMoreText: { fontSize: 14, fontFamily: 'Inter_500Medium' },

  // Reclassify modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: {
    maxHeight: '88%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
  },
  modalTitle: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  modalClose: {
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  reclassifySubtitle: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular', padding: 0 },
  typeRow: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  typeRowText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  typeRowPath: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
});
