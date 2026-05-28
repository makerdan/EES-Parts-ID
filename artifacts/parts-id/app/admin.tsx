/**
 * Admin Dashboard Screen
 *
 * Shows AI usage analytics, screen view tracking, and summary cards.
 * Non-admins see a plain "Not found" screen — no redirect, no hint this route exists.
 *
 * Route: /admin-dashboard
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Rect, Text as SvgText } from "react-native-svg";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { File as FsFile, Paths as FsPaths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { serializeDashboardToCsv } from "@/utils/exportCsv";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

type DailyPoint = { date: string; total: number };
type ByScreen = { screenName: string; total: number };
type ByFeature = { feature: string; total: number };

type DashboardStats = {
  ai: {
    totalAllTime: number;
    totalThisMonth: number;
    byFeature: ByFeature[];
  };
  screenViews: {
    totalAllTime: number;
    uniqueVisitorsToday: number;
    byScreen: ByScreen[];
    dailyLast30Days: DailyPoint[];
  };
  summary: {
    inventoryItems: number;
    catalogJobsDone: number;
    contactMessages: number;
  };
};

function StatBox({
  label,
  value,
  colors,
}: {
  label: string;
  value: string | number;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.statBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: colors.foreground }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

function SectionHeader({ title, colors }: { title: string; colors: ReturnType<typeof useColors> }) {
  return (
    <Text style={[styles.sectionHeader, { color: colors.foreground, borderBottomColor: colors.border }]}>
      {title}
    </Text>
  );
}

function TableRow({
  left,
  right,
  colors,
  dim,
}: {
  left: string;
  right: string | number;
  colors: ReturnType<typeof useColors>;
  dim?: boolean;
}) {
  return (
    <View style={[styles.tableRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.tableLeft, { color: dim ? colors.mutedForeground : colors.foreground }]} numberOfLines={1}>
        {left}
      </Text>
      <Text style={[styles.tableRight, { color: dim ? colors.mutedForeground : colors.primary }]}>
        {right}
      </Text>
    </View>
  );
}

const BAR_CHART_HEIGHT = 120;
const BAR_CHART_WIDTH = 320;

function DailyBarChart({
  data,
  colors,
}: {
  data: DailyPoint[];
  colors: ReturnType<typeof useColors>;
}) {
  if (data.length === 0) {
    return (
      <View style={[styles.barChartEmpty, { backgroundColor: colors.muted }]}>
        <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>No data yet</Text>
      </View>
    );
  }

  const maxVal = Math.max(...data.map((d) => d.total), 1);
  const barWidth = Math.floor((BAR_CHART_WIDTH - 8) / data.length) - 1;
  const barAreaHeight = BAR_CHART_HEIGHT - 20;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <Svg width={Math.max(BAR_CHART_WIDTH, data.length * (barWidth + 2))} height={BAR_CHART_HEIGHT + 4}>
        {data.map((d, i) => {
          const barH = Math.max(2, Math.round((d.total / maxVal) * barAreaHeight));
          const x = i * (barWidth + 2) + 2;
          const y = barAreaHeight - barH;
          const dayLabel = d.date.slice(5); // MM-DD
          return (
            <React.Fragment key={d.date}>
              <Rect
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                fill={colors.primary}
                opacity={0.85}
                rx={2}
              />
              {i % Math.ceil(data.length / 10) === 0 ? (
                <SvgText
                  x={x + barWidth / 2}
                  y={BAR_CHART_HEIGHT}
                  fontSize={8}
                  fill={colors.mutedForeground}
                  textAnchor="middle"
                >
                  {dayLabel}
                </SvgText>
              ) : null}
            </React.Fragment>
          );
        })}
      </Svg>
    </ScrollView>
  );
}

export default function AdminDashboardScreen() {
  "use no memo";
  const colors = useColors();
  const { isLoading, adminToken } = useApp();
  const router = useRouter();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    if (!stats) return;
    setExporting(true);
    try {
      const csv = serializeDashboardToCsv(stats);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `admin-dashboard-${date}.csv`;

      if (Platform.OS === "web") {
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const file = new FsFile(FsPaths.cache, filename);
        file.write(csv);
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(file.uri, {
            mimeType: "text/csv",
            dialogTitle: "Export Dashboard CSV",
            UTI: "public.comma-separated-values-text",
          });
        }
      }
    } catch (err) {
      Alert.alert("Export failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setExporting(false);
    }
  }, [stats]);

  const fetchStats = useCallback(async () => {
    if (!adminToken || !API_BASE) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/dashboard-stats`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardStats;
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    if (!isLoading && adminToken) {
      fetchStats();
    }
  }, [isLoading, adminToken, fetchStats]);

  // While auth state is loading, show nothing to avoid flicker
  if (isLoading) {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  // Not authenticated as admin — show plain not-found, no redirect, no hint
  if (!adminToken) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.notFound}>
          <Text style={[styles.notFoundText, { color: colors.mutedForeground }]}>Not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Admin Dashboard</Text>
        <Pressable
          onPress={handleExport}
          style={styles.exportBtn}
          hitSlop={8}
          disabled={!stats || exporting}
        >
          <Feather
            name="download"
            size={18}
            color={!stats || exporting ? colors.mutedForeground : colors.primary}
          />
        </Pressable>
        <Pressable onPress={fetchStats} style={styles.refreshBtn} hitSlop={8} disabled={loading}>
          <Feather name="refresh-cw" size={18} color={loading ? colors.mutedForeground : colors.primary} />
        </Pressable>
      </View>

      {loading && !stats ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Loading stats…</Text>
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
          <Pressable onPress={fetchStats} style={[styles.retryBtn, { backgroundColor: colors.primary }]}>
            <Text style={[styles.retryBtnText, { color: colors.primaryForeground }]}>Retry</Text>
          </Pressable>
        </View>
      ) : stats ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>

          {/* Summary Cards */}
          <SectionHeader title="Summary" colors={colors} />
          <View style={styles.statRow}>
            <StatBox label="Inventory Items" value={stats.summary.inventoryItems} colors={colors} />
            <StatBox label="Catalog Jobs Done" value={stats.summary.catalogJobsDone} colors={colors} />
            <StatBox label="Contact Messages" value={stats.summary.contactMessages} colors={colors} />
          </View>

          {/* AI Usage */}
          <SectionHeader title="AI Usage" colors={colors} />
          <View style={styles.statRow}>
            <StatBox label="All Time" value={stats.ai.totalAllTime} colors={colors} />
            <StatBox label="This Month" value={stats.ai.totalThisMonth} colors={colors} />
          </View>
          <View style={[styles.table, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <TableRow left="Feature" right="Requests" colors={colors} dim />
            {stats.ai.byFeature.length === 0 ? (
              <TableRow left="No data yet" right="" colors={colors} dim />
            ) : (
              stats.ai.byFeature.map((row) => (
                <TableRow
                  key={row.feature}
                  left={row.feature === "identify" ? "Photo ID" : "Reference Assistant"}
                  right={row.total}
                  colors={colors}
                />
              ))
            )}
          </View>

          {/* Screen Views */}
          <SectionHeader title="Screen Views" colors={colors} />
          <View style={styles.statRow}>
            <StatBox label="All Time" value={stats.screenViews.totalAllTime} colors={colors} />
            <StatBox label="Unique Today" value={stats.screenViews.uniqueVisitorsToday} colors={colors} />
          </View>
          <View style={[styles.table, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <TableRow left="Screen" right="Views" colors={colors} dim />
            {stats.screenViews.byScreen.length === 0 ? (
              <TableRow left="No data yet" right="" colors={colors} dim />
            ) : (
              stats.screenViews.byScreen.slice(0, 10).map((row) => (
                <TableRow key={row.screenName} left={row.screenName} right={row.total} colors={colors} />
              ))
            )}
          </View>

          {/* 30-day chart */}
          <SectionHeader title="Daily Views — Last 30 Days" colors={colors} />
          <View style={[styles.chartCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <DailyBarChart data={stats.screenViews.dailyLast30Days} colors={colors} />
          </View>

          <View style={{ height: 32 }} />
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { fontSize: 16 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  backBtn: { marginRight: 12 },
  headerTitle: { flex: 1, fontSize: 18, fontFamily: "Inter_600SemiBold" },
  exportBtn: { marginLeft: 8 },
  refreshBtn: { marginLeft: 8 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  loadingText: { marginTop: 12, fontSize: 14 },
  errorText: { fontSize: 14, textAlign: "center", marginBottom: 16 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  content: { padding: 16 },
  sectionHeader: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 20,
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
  },
  statRow: { flexDirection: "row", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  statBox: {
    flex: 1,
    minWidth: 90,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
  },
  statValue: { fontSize: 26, fontFamily: "Inter_700Bold" },
  statLabel: { fontSize: 11, marginTop: 4, textAlign: "center", fontFamily: "Inter_500Medium" },
  table: { borderWidth: 1, borderRadius: 10, overflow: "hidden", marginBottom: 4 },
  tableRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tableLeft: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", marginRight: 12 },
  tableRight: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  chartCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    overflow: "hidden",
  },
  barChartEmpty: {
    height: BAR_CHART_HEIGHT,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
});
