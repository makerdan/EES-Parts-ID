/**
 * PhotoEventsModal — drill-down view of individual Photo ID scan events.
 *
 * Opened from PhotoIdStatsSection when the admin taps "View events".
 * Fetches GET /photo/events with filter chips (match type, confirmed status,
 * parse result) and renders a paginated scrollable list of raw scan rows.
 *
 * Each row shows:
 *   - Relative timestamp
 *   - Match-type badge (color-coded)
 *   - Parse-fail warning when parseOk = false
 *   - AI guess: catalog / vendor extracted from the vision response
 *   - Top result shown to worker (from inventory join)
 *   - Worker-confirmed result (from inventory join), if any
 *   - Latency in ms
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { listPhotoEvents, ApiError } from '@workspace/api-client-react';
import type { PhotoEventItem, PhotoEventsResponse } from '@workspace/api-client-react';

interface Props {
  visible: boolean;
  onClose: () => void;
  adminHeaders: Record<string, string>;
  onExpiredSession: () => void;
  windowHours: number;
}

type MatchTypeFilter = 'catalog_exact' | 'attribute_match' | 'descriptive' | undefined;
type ConfirmedFilter = 'yes' | 'no' | undefined;
type ParseOkFilter = true | false | undefined;

const MATCH_TYPE_CHIPS: { label: string; value: MatchTypeFilter }[] = [
  { label: 'All types', value: undefined },
  { label: 'Catalog', value: 'catalog_exact' },
  { label: 'Attribute', value: 'attribute_match' },
  { label: 'Descriptive', value: 'descriptive' },
];

const CONFIRMED_CHIPS: { label: string; value: ConfirmedFilter }[] = [
  { label: 'Any', value: undefined },
  { label: 'Confirmed', value: 'yes' },
  { label: 'Unconfirmed', value: 'no' },
];

const PARSE_OK_CHIPS: { label: string; value: ParseOkFilter }[] = [
  { label: 'All', value: undefined },
  { label: 'Parsed OK', value: true },
  { label: 'Parse fail', value: false },
];

const PAGE_LIMIT = 20;

function matchTypeColor(mt: string | null | undefined): string {
  if (mt === 'catalog_exact') return '#10b981';
  if (mt === 'attribute_match') return '#3b82f6';
  if (mt === 'descriptive') return '#f59e0b';
  return '#6b7280';
}

function matchTypeLabel(mt: string | null | undefined): string {
  if (mt === 'catalog_exact') return 'Catalog';
  if (mt === 'attribute_match') return 'Attribute';
  if (mt === 'descriptive') return 'Descriptive';
  return 'No match';
}

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function PhotoEventsModal({
  visible,
  onClose,
  adminHeaders,
  onExpiredSession,
  windowHours,
}: Props) {
  const colors = useColors();

  const [matchType, setMatchType] = useState<MatchTypeFilter>(undefined);
  const [confirmed, setConfirmed] = useState<ConfirmedFilter>(undefined);
  const [parseOk, setParseOk] = useState<ParseOkFilter>(undefined);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PhotoEventsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (opts: {
      matchType: MatchTypeFilter;
      confirmed: ConfirmedFilter;
      parseOk: ParseOkFilter;
      page: number;
    }) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listPhotoEvents(
          {
            windowHours,
            matchType: opts.matchType,
            confirmed: opts.confirmed,
            parseOk: opts.parseOk,
            page: opts.page,
            limit: PAGE_LIMIT,
          },
          { headers: adminHeaders }
        );
        setData(result);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onExpiredSession();
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Network error loading events');
      } finally {
        setLoading(false);
      }
    },
    [windowHours, adminHeaders, onExpiredSession]
  );

  useEffect(() => {
    if (!visible) return;
    void fetchPage({ matchType, confirmed, parseOk, page });
  }, [visible, matchType, confirmed, parseOk, page, fetchPage]);

  const applyFilter = <T,>(setter: (v: T) => void, value: T) => {
    setter(value);
    setPage(1);
    setData(null);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_LIMIT)) : 1;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[s.container, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[s.header, { borderBottomColor: colors.border }]}>
          <Text style={[s.title, { color: colors.foreground }]}>Photo ID Events</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close events list"
            style={[s.closeBtn, { backgroundColor: colors.muted }]}
          >
            <Text style={[s.closeBtnText, { color: colors.mutedForeground }]}>✕</Text>
          </Pressable>
        </View>

        {/* Subtitle */}
        <Text style={[s.subtitle, { color: colors.mutedForeground }]}>
          Last {windowHours >= 720 ? '30d' : windowHours >= 168 ? '7d' : '24h'} ·{' '}
          {data != null ? `${data.total.toLocaleString()} events` : '…'}
        </Text>

        {/* Filter rows */}
        <View style={[s.filtersSection, { borderBottomColor: colors.border }]}>
          <FilterRow label="Match type" colors={colors}>
            {MATCH_TYPE_CHIPS.map((chip) => (
              <FilterChip
                key={String(chip.value)}
                label={chip.label}
                active={matchType === chip.value}
                onPress={() => applyFilter(setMatchType, chip.value)}
                colors={colors}
              />
            ))}
          </FilterRow>
          <FilterRow label="Confirmed" colors={colors}>
            {CONFIRMED_CHIPS.map((chip) => (
              <FilterChip
                key={String(chip.value)}
                label={chip.label}
                active={confirmed === chip.value}
                onPress={() => applyFilter(setConfirmed, chip.value)}
                colors={colors}
              />
            ))}
          </FilterRow>
          <FilterRow label="Parse" colors={colors}>
            {PARSE_OK_CHIPS.map((chip) => (
              <FilterChip
                key={String(chip.value)}
                label={chip.label}
                active={parseOk === chip.value}
                onPress={() => applyFilter(setParseOk, chip.value)}
                colors={colors}
              />
            ))}
          </FilterRow>
        </View>

        {/* Event list */}
        {error ? (
          <View style={[s.errorBanner, { backgroundColor: '#ef444422', borderColor: '#ef4444' }]}>
            <Text style={{ color: '#ef4444', fontSize: 13, fontFamily: 'Inter_500Medium' }}>
              {error}
            </Text>
          </View>
        ) : null}

        {loading && data == null ? (
          <View style={s.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : data?.items.length === 0 ? (
          <View style={[s.emptyBox, { backgroundColor: colors.muted }]}>
            <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
              No events match the selected filters in this window.
            </Text>
          </View>
        ) : (
          <ScrollView
            style={s.list}
            contentContainerStyle={s.listContent}
            showsVerticalScrollIndicator={false}
          >
            {(data?.items ?? []).map((event) => (
              <EventRow key={event.id} event={event} colors={colors} />
            ))}

            {/* Pagination */}
            {data && data.total > PAGE_LIMIT ? (
              <View style={s.pagination}>
                <Pressable
                  onPress={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  accessibilityRole="button"
                  accessibilityLabel="Previous page"
                  style={[
                    s.pageBtn,
                    {
                      borderColor: colors.border,
                      opacity: page <= 1 ? 0.35 : 1,
                    },
                  ]}
                >
                  <Text style={[s.pageBtnText, { color: colors.foreground }]}>← Prev</Text>
                </Pressable>
                <Text style={[s.pageInfo, { color: colors.mutedForeground }]}>
                  {page} / {totalPages}
                </Text>
                <Pressable
                  onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  accessibilityRole="button"
                  accessibilityLabel="Next page"
                  style={[
                    s.pageBtn,
                    {
                      borderColor: colors.border,
                      opacity: page >= totalPages ? 0.35 : 1,
                    },
                  ]}
                >
                  <Text style={[s.pageBtnText, { color: colors.foreground }]}>Next →</Text>
                </Pressable>
              </View>
            ) : null}
          </ScrollView>
        )}

        {loading && data != null ? (
          <View style={[s.loadingOverlay]}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function EventRow({
  event,
  colors,
}: {
  event: PhotoEventItem;
  colors: ReturnType<typeof useColors>;
}) {
  const badgeColor = matchTypeColor(event.matchType);
  return (
    <View style={[s.eventCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Top row: time + match badge + parse fail */}
      <View style={s.eventTopRow}>
        <Text style={[s.eventTime, { color: colors.mutedForeground }]}>
          {relativeTime(event.ts)}
        </Text>
        <View
          style={[s.matchBadge, { backgroundColor: badgeColor + '22', borderColor: badgeColor }]}
        >
          <Text style={[s.matchBadgeText, { color: badgeColor }]}>
            {matchTypeLabel(event.matchType)}
          </Text>
        </View>
        {!event.parseOk ? (
          <View style={[s.parseFail, { backgroundColor: '#ef444422' }]}>
            <Text style={[s.parseFailText, { color: '#ef4444' }]}>Parse fail</Text>
          </View>
        ) : null}
        {event.latencyMs != null ? (
          <Text style={[s.latency, { color: colors.mutedForeground }]}>{event.latencyMs} ms</Text>
        ) : null}
      </View>

      {/* AI guess row */}
      {event.catalogGuess || event.vendorGuess ? (
        <View style={s.dataRow}>
          <Text style={[s.rowLabel, { color: colors.mutedForeground }]}>AI guess</Text>
          <Text style={[s.rowValue, { color: colors.foreground }]} numberOfLines={1}>
            {[event.catalogGuess, event.vendorGuess].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ) : null}

      {/* Top result row */}
      {event.topResultCatalog ? (
        <View style={s.dataRow}>
          <Text style={[s.rowLabel, { color: colors.mutedForeground }]}>Top result</Text>
          <Text style={[s.rowValue, { color: colors.foreground }]} numberOfLines={1}>
            {[event.topResultCatalog, event.topResultVendor].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ) : null}

      {/* Confirmed result row */}
      {event.confirmedResultCatalog ? (
        <View style={s.dataRow}>
          <Text style={[s.rowLabel, { color: colors.mutedForeground }]}>Confirmed</Text>
          <Text style={[s.rowValue, s.confirmedValue, { color: '#10b981' }]} numberOfLines={1}>
            {[event.confirmedResultCatalog, event.confirmedResultVendor]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      ) : null}

      {/* Vision raw summary — especially useful for parse failures */}
      {event.visionRawSummary ? (
        <View style={s.dataRow}>
          <Text style={[s.rowLabel, { color: colors.mutedForeground }]}>Vision</Text>
          <Text
            style={[s.rowValue, s.visionText, { color: colors.mutedForeground }]}
            numberOfLines={2}
          >
            {event.visionRawSummary}
          </Text>
        </View>
      ) : null}

      {/* Image hash (truncated for visual reference) */}
      {event.imageHash ? (
        <Text style={[s.hashText, { color: colors.mutedForeground }]}>
          #{event.imageHash.slice(0, 12)}
        </Text>
      ) : null}
    </View>
  );
}

function FilterRow({
  label,
  children,
  colors,
}: {
  label: string;
  children: React.ReactNode;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={s.filterRow}>
      <Text style={[s.filterLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={s.filterChips}>{children}</View>
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
  colors,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[
        s.chip,
        {
          backgroundColor: active ? colors.primary : 'transparent',
          borderColor: active ? colors.primary : colors.border,
        },
      ]}
    >
      <Text style={[s.chipText, { color: active ? colors.primaryForeground : colors.foreground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },

  subtitle: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },

  filtersSection: { borderBottomWidth: 1, paddingBottom: 10, paddingHorizontal: 16, gap: 6 },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  filterLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    minWidth: 70,
  },
  filterChips: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  chip: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 12, fontFamily: 'Inter_500Medium' },

  errorBanner: { margin: 16, padding: 10, borderRadius: 8, borderWidth: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyBox: { margin: 16, borderRadius: 10, padding: 20, alignItems: 'center' },
  emptyText: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19, textAlign: 'center' },

  list: { flex: 1 },
  listContent: { padding: 12, gap: 8, paddingBottom: 32 },

  eventCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    gap: 5,
  },
  eventTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  eventTime: { fontSize: 11, fontFamily: 'Inter_400Regular', marginRight: 2 },
  matchBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
  },
  matchBadgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  parseFail: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5 },
  parseFailText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  latency: { marginLeft: 'auto', fontSize: 11, fontFamily: 'Inter_400Regular' },

  dataRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  rowLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    minWidth: 72,
    paddingTop: 1,
  },
  rowValue: { flex: 1, fontSize: 13, fontFamily: 'Inter_500Medium' },
  confirmedValue: { fontFamily: 'Inter_700Bold' },

  visionText: { fontSize: 11, fontFamily: 'Inter_400Regular', fontStyle: 'italic' },

  hashText: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.3,
    marginTop: 2,
  },

  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 8,
    marginTop: 4,
  },
  pageBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  pageBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  pageInfo: { fontSize: 13, fontFamily: 'Inter_500Medium' },

  loadingOverlay: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
  },
});
