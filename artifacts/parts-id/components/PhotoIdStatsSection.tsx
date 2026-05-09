/**
 * PhotoIdStatsSection — admin-only Photo ID telemetry dashboard.
 *
 * Lives in the upload tab's enrichment panel beside Classification Review.
 * Fetches GET /photo/stats with a configurable lookback window and renders
 * a glanceable summary: total scans, parse rate, match-type breakdown,
 * confirmation rate, latency, and top confirmed parts.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { getPhotoStats, ApiError } from '@workspace/api-client-react';
import type { PhotoStatsResponse } from '@workspace/api-client-react';
import PhotoEventsModal from './PhotoEventsModal';

interface Props {
  adminHeaders: Record<string, string>;
  onExpiredSession: () => void;
}

const WINDOW_OPTIONS: { label: string; hours: number }[] = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 },
];

function pct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

function ms(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v} ms`;
}

export default function PhotoIdStatsSection({ adminHeaders, onExpiredSession }: Props) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const [windowHours, setWindowHours] = useState<number>(24);
  const [stats, setStats] = useState<PhotoStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventsVisible, setEventsVisible] = useState(false);
  const [eventsMatchType, setEventsMatchType] = useState<
    'catalog_exact' | 'attribute_match' | 'descriptive' | undefined
  >(undefined);

  const openEvents = (matchType?: 'catalog_exact' | 'attribute_match' | 'descriptive') => {
    setEventsMatchType(matchType);
    setEventsVisible(true);
  };

  const fetchStats = useCallback(
    async (hours: number) => {
      setLoading(true);
      setError(null);
      try {
        const data = await getPhotoStats({ windowHours: hours }, { headers: adminHeaders });
        setStats(data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onExpiredSession();
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Network error loading photo stats');
      } finally {
        setLoading(false);
      }
    },
    [adminHeaders, onExpiredSession]
  );

  // Refresh whenever the window changes (only while expanded).
  useEffect(() => {
    if (!expanded) return;
    void fetchStats(windowHours);
  }, [expanded, windowHours, fetchStats]);

  const handleToggle = () => setExpanded((e) => !e);

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <PhotoEventsModal
        visible={eventsVisible}
        onClose={() => setEventsVisible(false)}
        adminHeaders={adminHeaders}
        onExpiredSession={onExpiredSession}
        windowHours={windowHours}
        initialMatchType={eventsMatchType}
      />
      <Pressable
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse Photo ID stats' : 'Expand Photo ID stats'}
        style={s.headerRow}
      >
        <View style={s.headerLeft}>
          <Text style={[s.title, { color: colors.foreground }]}>Photo ID Stats</Text>
          {stats != null ? (
            <View style={[s.badge, { backgroundColor: colors.primary + '22' }]}>
              <Text style={[s.badgeText, { color: colors.primary }]}>
                {stats.totalScans.toLocaleString()} scans
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded ? (
        <>
          <Text style={[s.hint, { color: colors.mutedForeground }]}>
            Aggregated telemetry for the AI Photo ID flow over the selected window.
          </Text>

          {/* Window picker */}
          <View style={s.windowRow}>
            {WINDOW_OPTIONS.map((opt) => {
              const active = opt.hours === windowHours;
              return (
                <Pressable
                  key={opt.hours}
                  onPress={() => {
                    if (opt.hours !== windowHours) {
                      setStats(null);
                      setWindowHours(opt.hours);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Show last ${opt.label}`}
                  style={[
                    s.windowChip,
                    {
                      backgroundColor: active ? colors.primary : 'transparent',
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      s.windowChipText,
                      { color: active ? colors.primaryForeground : colors.foreground },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => void fetchStats(windowHours)}
              accessibilityRole="button"
              accessibilityLabel="Refresh photo stats"
              style={[s.refreshBtn, { borderColor: colors.border }]}
            >
              <Text style={[s.windowChipText, { color: colors.mutedForeground }]}>Refresh</Text>
            </Pressable>
          </View>

          {error ? (
            <View style={[s.errorBanner, { backgroundColor: '#ef444422', borderColor: '#ef4444' }]}>
              <Text style={{ color: '#ef4444', fontSize: 13, fontFamily: 'Inter_500Medium' }}>
                {error}
              </Text>
            </View>
          ) : null}

          {loading && stats == null ? (
            <View style={s.center}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : stats == null ? null : stats.totalScans === 0 ? (
            <View style={[s.emptyBox, { backgroundColor: colors.muted }]}>
              <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
                No Photo ID scans recorded in the selected window.
              </Text>
            </View>
          ) : (
            <>
              {/* Top KPIs */}
              <View style={s.kpiGrid}>
                <Kpi
                  label="Total scans"
                  value={stats.totalScans.toLocaleString()}
                  colors={colors}
                  onPress={() => openEvents(undefined)}
                />
                <Kpi label="Parse OK" value={pct(stats.parseSuccessRate)} colors={colors} />
                <Kpi label="Confirmed" value={pct(stats.confirmationRate)} colors={colors} />
                <Kpi label="Avg latency" value={ms(stats.avgLatencyMs)} colors={colors} />
                <Kpi label="p95 latency" value={ms(stats.p95LatencyMs)} colors={colors} />
              </View>

              {/* Match-type distribution */}
              <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>Match path</Text>
              <MatchBar
                catalog={stats.matchTypeDistribution.catalogExact}
                attribute={stats.matchTypeDistribution.attributeMatch}
                descriptive={stats.matchTypeDistribution.descriptive}
                colors={colors}
                onSegmentPress={openEvents}
              />

              {/* Top confirmed parts */}
              <Text style={[s.sectionLabel, { color: colors.mutedForeground, marginTop: 8 }]}>
                Top confirmed parts
              </Text>
              {stats.topConfirmedParts.length === 0 ? (
                <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
                  No worker confirmations recorded yet in this window.
                </Text>
              ) : (
                stats.topConfirmedParts.map((p) => (
                  <View
                    key={p.inventoryId}
                    style={[
                      s.partRow,
                      { backgroundColor: colors.background, borderColor: colors.border },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[s.partCatalog, { color: colors.foreground }]} numberOfLines={1}>
                        {p.catalog}
                      </Text>
                      <Text
                        style={[s.partVendor, { color: colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {p.vendor}
                      </Text>
                    </View>
                    <View style={[s.countBadge, { backgroundColor: colors.primary + '22' }]}>
                      <Text style={[s.countText, { color: colors.primary }]}>
                        {p.confirmedCount}
                      </Text>
                    </View>
                  </View>
                ))
              )}

              {/* Drill-down link */}
              {(() => {
                const matchCount =
                  eventsMatchType === 'catalog_exact'
                    ? stats.matchTypeDistribution.catalogExact
                    : eventsMatchType === 'attribute_match'
                      ? stats.matchTypeDistribution.attributeMatch
                      : eventsMatchType === 'descriptive'
                        ? stats.matchTypeDistribution.descriptive
                        : null;
                const matchLabel =
                  eventsMatchType === 'catalog_exact'
                    ? 'catalog'
                    : eventsMatchType === 'attribute_match'
                      ? 'attribute'
                      : eventsMatchType === 'descriptive'
                        ? 'descriptive'
                        : null;
                const btnLabel =
                  matchLabel != null && matchCount != null
                    ? `View ${matchCount.toLocaleString()} ${matchLabel} scans →`
                    : 'View individual events →';
                const btnA11y =
                  matchLabel != null
                    ? `View ${matchLabel} scan events`
                    : 'View individual scan events';
                return (
                  <Pressable
                    onPress={() => openEvents(eventsMatchType)}
                    accessibilityRole="button"
                    accessibilityLabel={btnA11y}
                    style={[s.viewEventsBtn, { borderColor: colors.border }]}
                  >
                    <Text style={[s.viewEventsBtnText, { color: colors.primary }]}>{btnLabel}</Text>
                  </Pressable>
                );
              })()}
            </>
          )}
        </>
      ) : null}
    </View>
  );
}

function Kpi({
  label,
  value,
  colors,
  onPress,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useColors>;
  onPress?: () => void;
}) {
  const inner = (
    <View style={[s.kpi, { backgroundColor: colors.muted }]}>
      <Text style={[s.kpiValue, { color: colors.foreground }]}>{value}</Text>
      <Text style={[s.kpiLabel, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`View events for ${label}`}
      style={{ flexGrow: 1, flexBasis: '30%', minWidth: 96 }}
    >
      {inner}
    </Pressable>
  );
}

type MatchTypeKey = 'catalog_exact' | 'attribute_match' | 'descriptive';

function MatchBar({
  catalog,
  attribute,
  descriptive,
  colors,
  onSegmentPress,
}: {
  catalog: number;
  attribute: number;
  descriptive: number;
  colors: ReturnType<typeof useColors>;
  onSegmentPress: (mt: MatchTypeKey) => void;
}) {
  const total = catalog + attribute + descriptive;
  if (total === 0) {
    return (
      <Text style={[s.emptyText, { color: colors.mutedForeground }]}>
        No match-path data in this window.
      </Text>
    );
  }
  const seg = (n: number, color: string, key: string, mt: MatchTypeKey) => {
    const w = (n / total) * 100;
    if (w === 0) return null;
    return (
      <Pressable
        key={key}
        onPress={() => onSegmentPress(mt)}
        accessibilityRole="button"
        accessibilityLabel={`Filter by ${key} match type`}
        style={{ width: `${w}%`, height: '100%', backgroundColor: color }}
      />
    );
  };
  return (
    <>
      <View style={[s.barTrack, { backgroundColor: colors.muted }]}>
        {seg(catalog, '#10b981', 'catalog', 'catalog_exact')}
        {seg(attribute, '#3b82f6', 'attribute', 'attribute_match')}
        {seg(descriptive, '#f59e0b', 'descriptive', 'descriptive')}
      </View>
      <View style={s.legendRow}>
        <Legend
          color="#10b981"
          label={`Catalog ${catalog}`}
          colors={colors}
          onPress={() => onSegmentPress('catalog_exact')}
        />
        <Legend
          color="#3b82f6"
          label={`Attribute ${attribute}`}
          colors={colors}
          onPress={() => onSegmentPress('attribute_match')}
        />
        <Legend
          color="#f59e0b"
          label={`Descriptive ${descriptive}`}
          colors={colors}
          onPress={() => onSegmentPress('descriptive')}
        />
      </View>
    </>
  );
}

function Legend({
  color,
  label,
  colors,
  onPress,
}: {
  color: string;
  label: string;
  colors: ReturnType<typeof useColors>;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Filter events by ${label}`}
      style={s.legendItem}
    >
      <View style={[s.legendSwatch, { backgroundColor: color }]} />
      <Text style={[s.legendText, { color: colors.mutedForeground }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 12, marginBottom: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  badgeText: { fontSize: 12, fontFamily: 'Inter_700Bold' },
  hint: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19 },

  windowRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  windowChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  refreshBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    marginLeft: 'auto',
  },
  windowChipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },

  errorBanner: { padding: 10, borderRadius: 8, borderWidth: 1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24 },
  emptyBox: { borderRadius: 8, padding: 16, alignItems: 'center' },
  emptyText: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19 },

  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kpi: {
    minWidth: 96,
    flexGrow: 1,
    flexBasis: '30%',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  kpiValue: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  kpiLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', marginTop: 2 },

  sectionLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
  },
  barTrack: {
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { fontSize: 11, fontFamily: 'Inter_500Medium' },

  partRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  partCatalog: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  partVendor: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: 2,
  },
  countBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  countText: { fontSize: 12, fontFamily: 'Inter_700Bold' },

  viewEventsBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
    marginTop: 4,
  },
  viewEventsBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
