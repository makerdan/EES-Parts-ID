/**
 * EnrichmentStatsChips
 *
 * Renders the Enriched / Pending / Coverage / Review Queue stat chips that
 * appear inside the Enrichment Coverage card on the upload screen.
 *
 * Extracted from app/(tabs)/upload.tsx so the chip gating logic and the
 * Review Queue chip independence from enrichSummary can be unit-tested
 * against real production code.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

export type EnrichSummary = {
  total: number;
  enriched: number;
  unenriched: number;
};

interface Props {
  reviewCount: number | null;
  enrichSummary: EnrichSummary | null;
  onReviewQueuePress: () => void;
}

/**
 * The Review Queue chip is independent of enrichSummary: it resolves from
 * a separate request and should be visible as soon as its own count lands,
 * even if the enrichment-summary fetch is still in-flight.
 */
export function EnrichmentStatsChips({ reviewCount, enrichSummary, onReviewQueuePress }: Props) {
  const colors = useColors();

  if (!enrichSummary && reviewCount == null) return null;

  return (
    <View style={s.row}>
      {enrichSummary ? (
        <>
          <View style={[s.chip, { backgroundColor: colors.success + '11' }]}>
            <Text style={[s.value, { color: colors.success }]}>
              {enrichSummary.enriched.toLocaleString()}
            </Text>
            <Text style={[s.label, { color: colors.mutedForeground }]}>Enriched</Text>
          </View>
          <View style={[s.chip, { backgroundColor: colors.warning + '11' }]}>
            <Text style={[s.value, { color: colors.warning }]}>
              {enrichSummary.unenriched.toLocaleString()}
            </Text>
            <Text style={[s.label, { color: colors.mutedForeground }]}>Pending</Text>
          </View>
          <View style={[s.chip, { backgroundColor: colors.muted }]}>
            <Text style={[s.value, { color: colors.foreground }]}>
              {enrichSummary.total > 0
                ? `${Math.round((enrichSummary.enriched / enrichSummary.total) * 100)}%`
                : '—'}
            </Text>
            <Text style={[s.label, { color: colors.mutedForeground }]}>Coverage</Text>
          </View>
        </>
      ) : null}
      {reviewCount != null ? (
        <Pressable
          style={[s.chip, { backgroundColor: colors.primary + '18' }]}
          onPress={onReviewQueuePress}
          accessibilityLabel="Open review queue"
        >
          <Text style={[s.value, { color: colors.primary }]}>{reviewCount.toLocaleString()}</Text>
          <Text style={[s.label, { color: colors.mutedForeground }]}>Review Queue</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  chip: { flex: 1, alignItems: 'center', padding: 12, borderRadius: 8 },
  value: { fontSize: 22, fontFamily: 'Inter_700Bold' },
  label: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
});
