/**
 * Animated placeholder card that mirrors the visual footprint of ResultCard.
 *
 * Shown in the search results list while a first-time search is in flight
 * (no prior results to display). Uses a looping opacity shimmer so the
 * screen feels alive rather than blank. Reuses theme colors so it looks
 * correct in both light and dark mode.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, type DimensionValue, StyleSheet, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

function ShimmerBar({
  width,
  height = 12,
  shimmer,
  colors,
}: {
  width: DimensionValue;
  height?: number;
  shimmer: Animated.Value;
  colors: ReturnType<typeof useColors>;
}) {
  const opacity = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [0.35, 0.7],
  });
  return (
    <View style={{ width, height }}>
      <Animated.View
        style={{
          flex: 1,
          backgroundColor: colors.mutedForeground,
          borderRadius: 4,
          opacity,
        }}
      />
    </View>
  );
}

export function SkeletonResultCard({ colors }: { colors: ReturnType<typeof useColors> }) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [shimmer]);

  return (
    <View
      style={[
        skelStyles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
        },
      ]}
    >
      {/* Header row: rank badge + vendor/catalog block on left, badge on right */}
      <View style={skelStyles.header}>
        <View style={skelStyles.headerLeft}>
          {/* Rank badge */}
          <View style={[skelStyles.rankBadge, { backgroundColor: colors.muted }]} />
          <View style={skelStyles.titleGroup}>
            {/* Vendor line */}
            <ShimmerBar width="30%" height={9} shimmer={shimmer} colors={colors} />
            {/* Catalog number — large */}
            <ShimmerBar width="55%" height={22} shimmer={shimmer} colors={colors} />
          </View>
        </View>
        {/* Confidence badge */}
        <View style={[skelStyles.badgePlaceholder, { backgroundColor: colors.muted }]} />
      </View>

      {/* Description lines */}
      <View style={skelStyles.descBlock}>
        <ShimmerBar width="95%" height={11} shimmer={shimmer} colors={colors} />
        <ShimmerBar width="70%" height={11} shimmer={shimmer} colors={colors} />
      </View>

      {/* Bin row */}
      <View style={[skelStyles.binRow, { backgroundColor: colors.accent }]}>
        <ShimmerBar width="45%" height={11} shimmer={shimmer} colors={colors} />
      </View>
    </View>
  );
}

const skelStyles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
    padding: 12,
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    flex: 1,
  },
  rankBadge: {
    width: 28,
    height: 18,
    borderRadius: 4,
    marginTop: 4,
  },
  titleGroup: {
    flex: 1,
    gap: 6,
  },
  badgePlaceholder: {
    width: 44,
    height: 20,
    borderRadius: 6,
    marginTop: 2,
  },
  descBlock: {
    gap: 6,
  },
  binRow: {
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  bar: {},
});
