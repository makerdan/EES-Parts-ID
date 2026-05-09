/**
 * RecordEditModal
 *
 * Bottom-sheet modal that lets an admin edit any field on an inventory record:
 *   • vendor code (trimmed, uppercased on send)
 *   • catalog number
 *   • description (free text)
 *   • binLocations (comma-separated string → string[])
 *   • aiKeywords (tag list — add/remove chips)
 *   • tradeSize (free text, nullable)
 *
 * Saves via PATCH /api/inventory/{id}.  On success the caller receives the
 * updated item so it can do an optimistic in-place list update.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import type { InventoryItem } from '@workspace/api-client-react';
import { useSuggestItemDescription } from '@workspace/api-client-react';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : '';

interface SeriesResult {
  id: number;
  name: string;
  vendor: string;
}

interface Props {
  item: InventoryItem | null;
  adminHeaders: Record<string, string>;
  onClose: () => void;
  onSaved: (updated: InventoryItem) => void;
}

export function RecordEditModal({ item, adminHeaders, onClose, onSaved }: Props) {
  const colors = useColors();

  const [vendor, setVendor] = useState('');
  const [catalog, setCatalog] = useState('');
  const [description, setDescription] = useState('');
  const [binText, setBinText] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [tradeSize, setTradeSize] = useState('');

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // ── Series state ─────────────────────────────────────────────────────────
  const [seriesEnabled, setSeriesEnabled] = useState(false);
  const [seriesId, setSeriesId] = useState<number | null>(null);
  const [seriesRenameText, setSeriesRenameText] = useState('');
  const [seriesSearchQuery, setSeriesSearchQuery] = useState('');
  const [seriesSearchResults, setSeriesSearchResults] = useState<SeriesResult[]>([]);
  const [seriesSearchLoading, setSeriesSearchLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const seriesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originalSeriesIdRef = useRef<number | null>(null);
  const originalSeriesNameRef = useRef<string>('');

  const suggestMutation = useSuggestItemDescription();
  const isSuggesting = suggestMutation.isPending;

  useEffect(() => {
    if (!item) return;
    setVendor(item.vendor ?? '');
    setCatalog(item.catalog ?? '');
    setDescription(item.description ?? '');
    setBinText((item.binLocations ?? []).join(', '));
    setKeywords([...(item.aiKeywords ?? [])]);
    setTradeSize(item.tradeSize ?? '');
    setToast(null);
    setNewKeyword('');
    setSuggestion(null);
    setSuggestError(null);
    // Series — seriesId is present in API responses but not in the generated TS type
    const rawId = (item as unknown as Record<string, unknown>).seriesId;
    const initSeriesId = typeof rawId === 'number' ? rawId : null;
    const initSeriesName = item.seriesName ?? '';
    setSeriesEnabled(!!initSeriesName);
    setSeriesId(initSeriesId);
    setSeriesRenameText(initSeriesName);
    setSeriesSearchQuery('');
    setSeriesSearchResults([]);
    setSeriesError(null);
    originalSeriesIdRef.current = initSeriesId;
    originalSeriesNameRef.current = initSeriesName;
  }, [item]);

  const addKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw || keywords.includes(kw)) {
      setNewKeyword('');
      return;
    }
    setKeywords((prev) => [...prev, kw]);
    setNewKeyword('');
  };

  const removeKeyword = (kw: string) => {
    setKeywords((prev) => prev.filter((k) => k !== kw));
  };

  const handleSuggest = async () => {
    if (!item) return;
    setSuggestError(null);
    setSuggestion(null);
    try {
      const res = await suggestMutation.mutateAsync({ id: item.id });
      setSuggestion(res.description);
    } catch {
      setSuggestError("Couldn't generate a suggestion. Please try again.");
    }
  };

  const handleUseSuggestion = () => {
    if (!suggestion) return;
    setDescription(suggestion);
    setSuggestion(null);
    setSuggestError(null);
  };

  const handleDismissSuggestion = () => {
    setSuggestion(null);
    setSuggestError(null);
  };

  // ── Series handlers ────────────────────────────────────────────────────────
  const handleSeriesToggle = (val: boolean) => {
    setSeriesEnabled(val);
    if (!val) {
      if (seriesTimerRef.current) clearTimeout(seriesTimerRef.current);
      setSeriesSearchQuery('');
      setSeriesSearchResults([]);
      setSeriesError(null);
    }
  };

  const handleSeriesSearchChange = useCallback(
    (q: string) => {
      setSeriesSearchQuery(q);
      setSeriesError(null);
      if (seriesTimerRef.current) clearTimeout(seriesTimerRef.current);
      if (!q.trim()) {
        setSeriesSearchResults([]);
        return;
      }
      seriesTimerRef.current = setTimeout(() => {
        seriesTimerRef.current = null;
        setSeriesSearchLoading(true);
        fetch(`${API_BASE}/series/search?q=${encodeURIComponent(q.trim())}`, {
          headers: adminHeaders,
        })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { series: SeriesResult[] };
            setSeriesSearchResults(data.series);
          })
          .catch(() => {
            setSeriesError("Couldn't load series list.");
          })
          .finally(() => {
            setSeriesSearchLoading(false);
          });
      }, 400);
    },
    [adminHeaders]
  );

  const selectSeries = (sr: SeriesResult) => {
    setSeriesId(sr.id);
    setSeriesRenameText(sr.name);
    setSeriesSearchQuery('');
    setSeriesSearchResults([]);
  };

  const createAndSelectSeries = async () => {
    if (!item || !seriesSearchQuery.trim()) return;
    setSeriesSearchLoading(true);
    setSeriesError(null);
    try {
      const res = await fetch(`${API_BASE}/series`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({ name: seriesSearchQuery.trim(), vendor: item.vendor }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      const { series } = (await res.json()) as { series: { id: number; name: string } };
      setSeriesId(series.id);
      setSeriesRenameText(series.name);
      setSeriesSearchQuery('');
      setSeriesSearchResults([]);
    } catch (e) {
      setSeriesError(e instanceof Error ? e.message : 'Failed to create series.');
    } finally {
      setSeriesSearchLoading(false);
    }
  };

  const handleSave = async () => {
    if (!item) return;
    if (!vendor.trim()) {
      setToast({ msg: 'Vendor code cannot be blank.', ok: false });
      return;
    }
    if (!catalog.trim()) {
      setToast({ msg: 'Catalog number cannot be blank.', ok: false });
      return;
    }

    setSaving(true);
    setToast(null);
    try {
      const binLocations = binText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const body: Record<string, unknown> = {
        vendor: vendor.trim(),
        catalog: catalog.trim(),
        description,
        keywords,
        binLocations,
        tradeSize: tradeSize.trim() || null,
      };

      const res = await fetch(`${API_BASE}/inventory/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        setToast({ msg: 'Admin session expired — please unlock again.', ok: false });
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setToast({ msg: data.error ?? 'Save failed — please try again.', ok: false });
        return;
      }

      const updated = (await res.json()) as InventoryItem;

      // ── Series: rename if staged ─────────────────────────────────────────
      const renameText = seriesRenameText.trim();
      if (
        seriesEnabled &&
        seriesId !== null &&
        renameText &&
        renameText !== originalSeriesNameRef.current
      ) {
        const renameRes = await fetch(`${API_BASE}/series/${seriesId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...adminHeaders },
          body: JSON.stringify({ name: renameText }),
        });
        if (!renameRes.ok) {
          const d = (await renameRes.json().catch(() => ({}))) as { error?: string };
          setToast({ msg: d.error ?? 'Series rename failed — record saved.', ok: false });
          return;
        }
      }

      // ── Series: update assignment if changed ────────────────────────────
      const newSeriesId = seriesEnabled ? seriesId : null;
      if (newSeriesId !== originalSeriesIdRef.current) {
        const seriesRes = await fetch(`${API_BASE}/inventory/${item.id}/series`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...adminHeaders },
          body: JSON.stringify({ seriesId: newSeriesId }),
        });
        if (!seriesRes.ok) {
          const d = (await seriesRes.json().catch(() => ({}))) as { error?: string };
          setToast({ msg: d.error ?? 'Series update failed — record saved.', ok: false });
          return;
        }
      }

      setToast({ msg: 'Saved successfully.', ok: true });
      onSaved(updated);
      setTimeout(() => {
        setToast(null);
        onClose();
      }, 900);
    } catch (err) {
      setToast({
        msg: err instanceof Error ? err.message : 'Network error — please try again.',
        ok: false,
      });
    } finally {
      setSaving(false);
    }
  };

  if (!item) return null;

  return (
    <Modal visible={item !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable
          style={[s.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => {}}
        >
          {/* Header */}
          <View style={[s.header, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
                Edit Record
              </Text>
              <Text style={[s.headerSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                ID #{item.id}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              style={[s.closeBtn, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={[s.closeBtnText, { color: colors.foreground }]}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={s.body}
          >
            {/* Toast */}
            {toast ? (
              <View
                style={[
                  s.toast,
                  {
                    backgroundColor: toast.ok ? colors.success + '22' : '#ef444422',
                    borderColor: toast.ok ? colors.success : '#ef4444',
                  },
                ]}
              >
                <Text style={[s.toastText, { color: toast.ok ? colors.success : '#ef4444' }]}>
                  {toast.msg}
                </Text>
              </View>
            ) : null}

            {/* Vendor */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>VENDOR CODE</Text>
            <TextInput
              value={vendor}
              onChangeText={setVendor}
              placeholder="e.g. ETN, SQD, HBL"
              placeholderTextColor={colors.mutedForeground}
              style={[
                s.input,
                {
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              autoCapitalize="characters"
              autoCorrect={false}
            />

            {/* Catalog */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>CATALOG NUMBER</Text>
            <TextInput
              value={catalog}
              onChangeText={setCatalog}
              placeholder="e.g. BR120"
              placeholderTextColor={colors.mutedForeground}
              style={[
                s.input,
                {
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              autoCapitalize="characters"
              autoCorrect={false}
            />

            {/* Description */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={3}
              placeholder="Enter description…"
              placeholderTextColor={colors.mutedForeground}
              style={[
                s.textArea,
                {
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              autoCorrect={false}
            />

            {/* Suggest description */}
            <Pressable
              onPress={() => {
                void handleSuggest();
              }}
              disabled={isSuggesting}
              style={[
                s.suggestBtn,
                {
                  borderColor: colors.primary + '55',
                  backgroundColor: isSuggesting ? colors.muted : colors.accent,
                  opacity: isSuggesting ? 0.7 : 1,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Suggest improved description"
            >
              {isSuggesting ? (
                <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 6 }} />
              ) : null}
              <Text style={[s.suggestBtnText, { color: colors.primary }]}>
                {isSuggesting ? 'Generating…' : '✨ Suggest improved description'}
              </Text>
            </Pressable>

            {suggestError ? (
              <Text style={[s.suggestError, { color: '#ef4444' }]}>{suggestError}</Text>
            ) : null}

            {suggestion ? (
              <View
                style={[
                  s.suggestionBlock,
                  { borderColor: colors.primary + '55', backgroundColor: colors.accent },
                ]}
              >
                <Text style={[s.suggestionLabel, { color: colors.mutedForeground }]}>
                  AI SUGGESTION
                </Text>
                <Text style={[s.suggestionText, { color: colors.foreground }]}>{suggestion}</Text>
                <View style={s.suggestionActions}>
                  <Pressable
                    onPress={handleUseSuggestion}
                    style={[s.suggestionUse, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[s.suggestionUseText, { color: colors.primaryForeground }]}>
                      Use this
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={handleDismissSuggestion}
                    style={[s.suggestionDismiss, { borderColor: colors.border }]}
                  >
                    <Text style={[s.suggestionDismissText, { color: colors.foreground }]}>
                      Dismiss
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {/* Bin Locations */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>BIN LOCATIONS</Text>
            <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>
              Comma-separated (e.g. A1, B3, C12)
            </Text>
            <TextInput
              value={binText}
              onChangeText={setBinText}
              placeholder="e.g. A1, B3, C12"
              placeholderTextColor={colors.mutedForeground}
              style={[
                s.input,
                {
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              autoCapitalize="characters"
              autoCorrect={false}
            />

            {/* Trade Size */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>TRADE SIZE</Text>
            <TextInput
              value={tradeSize}
              onChangeText={setTradeSize}
              placeholder={`e.g. 1/2", 3/4" — leave blank to clear`}
              placeholderTextColor={colors.mutedForeground}
              style={[
                s.input,
                {
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              autoCorrect={false}
            />

            {/* Product Series */}
            <View style={s.seriesHeader}>
              <Text style={[s.label, { color: colors.mutedForeground, marginTop: 12, marginBottom: 0 }]}>
                PRODUCT SERIES
              </Text>
              <Switch
                value={seriesEnabled}
                onValueChange={handleSeriesToggle}
                trackColor={{ false: colors.border, true: colors.primary + 'aa' }}
                thumbColor={seriesEnabled ? colors.primary : colors.mutedForeground}
                accessibilityRole="switch"
                accessibilityLabel="Toggle series membership"
              />
            </View>

            {!seriesEnabled ? (
              <Text style={[s.seriesHint, { color: colors.mutedForeground }]}>
                This part is not assigned to any product series.
              </Text>
            ) : (
              <>
                {seriesId !== null ? (
                  <>
                    <Text style={[s.label, { color: colors.mutedForeground }]}>SERIES NAME</Text>
                    <TextInput
                      value={seriesRenameText}
                      onChangeText={setSeriesRenameText}
                      placeholder="Series name…"
                      placeholderTextColor={colors.mutedForeground}
                      style={[
                        s.input,
                        { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                      ]}
                      autoCorrect={false}
                    />
                    <Text style={[s.seriesHint, { color: colors.mutedForeground }]}>
                      Renaming this will update the name for all parts in this series.
                    </Text>
                    <Pressable
                      onPress={() => {
                        setSeriesId(null);
                        setSeriesRenameText('');
                      }}
                      style={[s.seriesRemoveBtn, { borderColor: '#ef444466' }]}
                      accessibilityRole="button"
                      accessibilityLabel="Remove from series"
                    >
                      <Text style={[s.seriesRemoveText, { color: '#ef4444' }]}>
                        Remove from series
                      </Text>
                    </Pressable>
                  </>
                ) : (
                  <Text style={[s.seriesHint, { color: colors.mutedForeground }]}>
                    Search for an existing series or create a new one.
                  </Text>
                )}

                <View style={[s.seriesSearchRow, { marginTop: 10 }]}>
                  <TextInput
                    value={seriesSearchQuery}
                    onChangeText={handleSeriesSearchChange}
                    placeholder={seriesId !== null ? 'Search to change series…' : 'Search series by name…'}
                    placeholderTextColor={colors.mutedForeground}
                    style={[
                      s.kwInput,
                      { flex: 1, backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
                    ]}
                    autoCorrect={false}
                    autoCapitalize="none"
                  />
                  {seriesSearchLoading ? (
                    <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 8 }} />
                  ) : null}
                </View>

                {seriesSearchResults.length > 0 ? (
                  <View style={[s.seriesResultList, { borderColor: colors.border }]}>
                    {seriesSearchResults.map((sr, idx) => (
                      <Pressable
                        key={sr.id}
                        onPress={() => selectSeries(sr)}
                        style={[
                          s.seriesResultRow,
                          idx < seriesSearchResults.length - 1 && {
                            borderBottomWidth: StyleSheet.hairlineWidth,
                            borderBottomColor: colors.border,
                          },
                          { backgroundColor: colors.muted },
                        ]}
                      >
                        <Text style={[s.seriesResultName, { color: colors.foreground }]}>
                          {sr.name}
                        </Text>
                        <Text style={[s.seriesResultVendor, { color: colors.mutedForeground }]}>
                          {sr.vendor}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

                {seriesSearchQuery.trim() &&
                !seriesSearchLoading &&
                seriesSearchResults.every(
                  (r) => r.name.toLowerCase() !== seriesSearchQuery.trim().toLowerCase()
                ) ? (
                  <Pressable
                    onPress={() => {
                      void createAndSelectSeries();
                    }}
                    style={[
                      s.seriesCreateBtn,
                      { borderColor: colors.primary + '55', backgroundColor: colors.accent },
                    ]}
                    accessibilityRole="button"
                  >
                    <Text style={[s.seriesCreateText, { color: colors.primary }]}>
                      + Create "{seriesSearchQuery.trim()}" series
                    </Text>
                  </Pressable>
                ) : null}

                {seriesError ? (
                  <Text style={[s.suggestError, { color: '#ef4444' }]}>{seriesError}</Text>
                ) : null}
              </>
            )}

            {/* AI Keywords */}
            <Text style={[s.label, { color: colors.mutedForeground }]}>AI KEYWORDS</Text>
            <View style={s.tagRow}>
              {keywords.map((kw) => (
                <Pressable
                  key={kw}
                  onPress={() => removeKeyword(kw)}
                  style={[
                    s.tag,
                    { backgroundColor: colors.primary + '1a', borderColor: colors.primary + '44' },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove keyword ${kw}`}
                >
                  <Text style={[s.tagText, { color: colors.primary }]}>{kw}</Text>
                  <Text style={[s.tagRemove, { color: colors.primary }]}>×</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.kwInputRow}>
              <TextInput
                value={newKeyword}
                onChangeText={setNewKeyword}
                placeholder="Add keyword…"
                placeholderTextColor={colors.mutedForeground}
                style={[
                  s.kwInput,
                  {
                    backgroundColor: colors.muted,
                    borderColor: colors.border,
                    color: colors.foreground,
                  },
                ]}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={addKeyword}
                blurOnSubmit={false}
              />
              <Pressable
                onPress={addKeyword}
                style={[s.kwAddBtn, { backgroundColor: colors.primary }]}
                accessibilityRole="button"
                accessibilityLabel="Add keyword"
              >
                <Text style={[s.kwAddBtnText, { color: colors.primaryForeground }]}>Add</Text>
              </Pressable>
            </View>
          </ScrollView>

          {/* Footer */}
          <View style={[s.footer, { borderTopColor: colors.border }]}>
            <Pressable onPress={onClose} style={[s.cancelBtn, { borderColor: colors.border }]}>
              <Text style={[s.cancelBtnText, { color: colors.foreground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void handleSave();
              }}
              disabled={saving}
              style={[s.saveBtn, { backgroundColor: saving ? colors.muted : colors.primary }]}
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={[s.saveBtnText, { color: colors.primaryForeground }]}>
                  Save Changes
                </Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '92%',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerTitle: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  headerSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 1 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  body: { padding: 16, gap: 4, paddingBottom: 8 },
  toast: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
  },
  toastText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  label: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.6,
    marginTop: 12,
    marginBottom: 4,
  },
  fieldHint: { fontSize: 11, fontFamily: 'Inter_400Regular', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    minHeight: 72,
    textAlignVertical: 'top',
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    gap: 4,
  },
  tagText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  tagRemove: { fontSize: 14, fontFamily: 'Inter_700Bold', marginTop: -1 },
  kwInputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  kwInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  kwAddBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  kwAddBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    borderTopWidth: 1,
  },
  cancelBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
  },
  cancelBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  saveBtn: {
    flex: 2,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
  },
  saveBtnText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  suggestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 10,
  },
  suggestBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  suggestError: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 8,
    lineHeight: 18,
  },
  suggestionBlock: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  suggestionLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  suggestionText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 19,
    marginBottom: 10,
  },
  suggestionActions: { flexDirection: 'row', gap: 8 },
  suggestionUse: { borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
  suggestionUseText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  suggestionDismiss: {
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
  },
  suggestionDismissText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  seriesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  seriesHint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    marginTop: 4,
    marginBottom: 4,
    lineHeight: 16,
  },
  seriesSearchRow: { flexDirection: 'row', alignItems: 'center' },
  seriesResultList: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    marginTop: 8,
    overflow: 'hidden',
  },
  seriesResultRow: { paddingHorizontal: 12, paddingVertical: 10 },
  seriesResultName: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  seriesResultVendor: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 2 },
  seriesCreateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 8,
  },
  seriesCreateText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  seriesRemoveBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  seriesRemoveText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
});
