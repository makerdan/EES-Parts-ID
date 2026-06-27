import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import { fetchWithAuth } from "@/utils/appAuth";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "http://localhost:8080/api";

const FETCH_TIMEOUT_MS = 12_000;

export interface PartCardData {
  displayName: string;
  specs: Array<{ label: string; value: string }>;
  crossRefs: Array<string>;
  compatibilityNote: string;
  cachedAt?: string | null;
}

interface PartCardProps {
  catalog: string;
  vendor?: string;
  description?: string;
  /** When true the section auto-expands immediately on mount (e.g. top Photo ID result). */
  autoExpand?: boolean;
}

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; data: PartCardData }
  | { status: "empty" }
  | { status: "error" };

function formatCachedAge(cachedAt: string | null | undefined): string | null {
  if (!cachedAt) return null;
  const diffMs = Date.now() - new Date(cachedAt).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "Fetched today";
  if (diffDays === 1) return "Fetched 1 day ago";
  return `Fetched ${diffDays} days ago`;
}

function SkeletonRow({ width, colors }: { width: number | string; colors: ReturnType<typeof useColors> }) {
  return (
    <View
      style={[
        pcStyles.skeletonRow,
        { backgroundColor: colors.muted, width: width as never },
      ]}
    />
  );
}

export function PartCard({ catalog, vendor, description, autoExpand = false }: PartCardProps) {
  "use no memo";
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const fetchedRef = useRef(false);

  const spinAnim = useRef(new Animated.Value(0)).current;
  const spinLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  const startSpin = () => {
    spinAnim.setValue(0);
    spinLoopRef.current = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 600,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    spinLoopRef.current.start();
  };

  const stopSpin = () => {
    spinLoopRef.current?.stop();
    spinLoopRef.current = null;
    spinAnim.setValue(0);
  };

  const triggerFetch = React.useCallback((opts?: { force?: boolean }) => {
    if (!opts?.force && fetchedRef.current) return;
    fetchedRef.current = true;

    if (opts?.force) {
      startSpin();
      setIsRefreshing(true);
    } else {
      setFetchState({ status: "loading" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetchWithAuth(`${API_BASE}/ai/part-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog, vendor: vendor ?? "", description: description ?? "", ...(opts?.force ? { force: true } : {}) }),
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timer);
        stopSpin();
        setIsRefreshing(false);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as PartCardData;
        const hasContent = data.displayName || data.specs.length > 0 || data.crossRefs.length > 0 || data.compatibilityNote;
        setFetchState(hasContent ? { status: "done", data } : { status: "empty" });
      })
      .catch((err) => {
        clearTimeout(timer);
        stopSpin();
        setIsRefreshing(false);
        if ((err as Error).name === "AbortError") {
          setFetchState({ status: "empty" });
        } else {
          setFetchState({ status: "error" });
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, vendor, description]);

  useEffect(() => {
    return () => { stopSpin(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autoExpand) {
      setOpen(true);
      triggerFetch();
    }
  }, [autoExpand, triggerFetch]);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const next = !open;
    setOpen(next);
    if (next) triggerFetch();
  };

  const chevronName = open ? "chevron-up" : "chevron-down";
  const showHint = !open && fetchState.status === "idle";

  return (
    <View style={[pcStyles.wrapper, { borderTopColor: colors.border }]}>
      <Pressable
        onPress={(e) => { e.stopPropagation?.(); toggle(); }}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={open ? "Collapse part details" : "Expand part details"}
        style={pcStyles.header}
      >
        <View style={pcStyles.headerLeft}>
          <Feather name="globe" size={12} color={colors.mutedForeground} />
          <Text style={[pcStyles.headerLabel, { color: colors.mutedForeground }]}>Part Details</Text>
          {showHint ? (
            <View style={[pcStyles.hintBadge, { backgroundColor: colors.primary + "18", borderColor: colors.primary + "44" }]}>
              <Text style={[pcStyles.hintText, { color: colors.primary }]}>specs & cross-refs</Text>
            </View>
          ) : null}
        </View>
        <Feather name={chevronName} size={14} color={colors.mutedForeground} />
      </Pressable>

      {open ? (
        <View style={pcStyles.body}>
          {fetchState.status === "loading" ? (
            <View style={pcStyles.skeletonBlock}>
              <SkeletonRow width="55%" colors={colors} />
              <SkeletonRow width="80%" colors={colors} />
              <SkeletonRow width="65%" colors={colors} />
              <SkeletonRow width="75%" colors={colors} />
              <View style={pcStyles.skeletonLoader}>
                <ActivityIndicator size="small" color={colors.mutedForeground} />
                <Text style={[pcStyles.loadingLabel, { color: colors.mutedForeground }]}>
                  Looking up part…
                </Text>
              </View>
            </View>
          ) : fetchState.status === "done" ? (
            <View style={pcStyles.contentBlock}>
              {fetchState.data.displayName ? (
                <Text style={[pcStyles.displayName, { color: colors.foreground }]}>
                  {fetchState.data.displayName}
                </Text>
              ) : null}

              {fetchState.data.specs.length > 0 ? (
                <View style={[pcStyles.specGrid, { borderColor: colors.border }]}>
                  {fetchState.data.specs.map((spec, i) => (
                    <View
                      key={i}
                      style={[
                        pcStyles.specRow,
                        { borderBottomColor: colors.border },
                        i === fetchState.data.specs.length - 1 ? pcStyles.specRowLast : null,
                      ]}
                    >
                      <Text style={[pcStyles.specLabel, { color: colors.mutedForeground }]}>
                        {spec.label}
                      </Text>
                      <Text style={[pcStyles.specValue, { color: colors.foreground }]}>
                        {spec.value}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {fetchState.data.crossRefs.length > 0 ? (
                <View style={pcStyles.section}>
                  <Text style={[pcStyles.sectionLabel, { color: colors.mutedForeground }]}>
                    CROSS-REFERENCES
                  </Text>
                  <View style={pcStyles.chipRow}>
                    {fetchState.data.crossRefs.map((ref, i) => (
                      <View key={i} style={[pcStyles.chip, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                        <Text style={[pcStyles.chipText, { color: colors.foreground }]}>{ref}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {fetchState.data.compatibilityNote ? (
                <View style={[pcStyles.compatNote, { backgroundColor: colors.accent }]}>
                  <Feather name="check-circle" size={12} color={colors.accentForeground} />
                  <Text style={[pcStyles.compatText, { color: colors.accentForeground }]}>
                    {fetchState.data.compatibilityNote}
                  </Text>
                </View>
              ) : null}

              {formatCachedAge(fetchState.data.cachedAt) ? (
                <View style={pcStyles.cachedAtRow}>
                  <Text style={[pcStyles.cachedAtLabel, { color: colors.mutedForeground }]}>
                    {formatCachedAge(fetchState.data.cachedAt)}
                  </Text>
                  <Pressable
                    onPress={() => triggerFetch({ force: true })}
                    hitSlop={8}
                    disabled={isRefreshing}
                    accessibilityRole="button"
                    accessibilityLabel="Refresh part details"
                    style={({ pressed }) => [pcStyles.refreshButton, { opacity: pressed || isRefreshing ? 0.5 : 1 }]}
                  >
                    <Animated.View
                      style={{
                        transform: [{
                          rotate: spinAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: ["0deg", "360deg"],
                          }),
                        }],
                      }}
                    >
                      <Feather name="refresh-cw" size={11} color={colors.mutedForeground} />
                    </Animated.View>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : (
            <Text style={[pcStyles.emptyText, { color: colors.mutedForeground }]}>
              No additional info found.
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const pcStyles = StyleSheet.create({
  wrapper: {
    marginTop: 10,
    borderTopWidth: 1,
    paddingTop: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  headerLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  body: {
    marginTop: 10,
  },
  skeletonBlock: {
    gap: 8,
  },
  skeletonRow: {
    height: 11,
    borderRadius: 5,
  },
  skeletonLoader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  loadingLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  contentBlock: {
    gap: 10,
  },
  displayName: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 18,
  },
  specGrid: {
    borderRadius: 6,
    borderWidth: 1,
    overflow: "hidden",
  },
  specRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    gap: 8,
  },
  specRowLast: {
    borderBottomWidth: 0,
  },
  specLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    flex: 1,
  },
  specValue: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    textAlign: "right",
    flexShrink: 1,
  },
  section: {
    gap: 6,
  },
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  compatNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: 6,
    padding: 8,
    gap: 6,
  },
  compatText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    flex: 1,
    lineHeight: 17,
  },
  emptyText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    paddingBottom: 4,
  },
  hintBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    marginLeft: 4,
  },
  hintText: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.2,
  },
  cachedAtRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 5,
  },
  cachedAtLabel: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
  refreshButton: {
    padding: 2,
  },
});
