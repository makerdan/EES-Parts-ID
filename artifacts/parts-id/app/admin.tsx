/**
 * Admin Dashboard Screen
 *
 * Shows AI usage analytics, screen view tracking, and summary cards.
 * Non-admins see a plain "Not found" screen — no redirect, no hint this route exists.
 *
 * Route: /admin-dashboard
 */
import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { File as FsFile, Paths as FsPaths } from "expo-file-system";
import { useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Rect, Text as SvgText } from "react-native-svg";

import { useApiHealth } from "@/contexts/ApiHealthContext";
import { useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { API_BASE } from "@/utils/apiBase";
import { serializeDashboardToCsv } from "@/utils/exportCsv";

type DailyPoint = { date: string; total: number };
type ByScreen = { screenName: string; total: number };
type ByFeature = { feature: string; total: number | null };

type DashboardStats = {
  generatedAt?: string;
  window?: { start: string; end: string; days: number };
  timezone?: string;
  privacy?: {
    minimumCellCount: number;
    suppressedValue: string;
    uniqueVisitorsAvailable: boolean;
    aggregateOnly: boolean;
  };
  ai: {
    requestsInWindow?: number | null;
    byFeature: Array<ByFeature>;
  };
  screenViews: {
    viewsInWindow?: number | null;
    uniqueVisitorsInWindow?: number | null;
    byScreen: Array<ByScreen>;
    dailyInWindow?: Array<DailyPoint>;
  };
  summary: {
    inventoryItems: number;
    catalogJobsDone: number;
    contactMessages: number;
  };
};

type ExportNotice = {
  kind: "downloaded" | "shared" | "saved" | "copied" | "failed";
  message: string;
  uri?: string;
};

type MapToolFailure = {
  label: string;
  url: string;
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

function displayPrivacyValue(value: number | null | undefined): string | number {
  return value == null ? "Suppressed" : value;
}

function formatReportingWindow(window: DashboardStats["window"]): string {
  if (!window) return "Reporting window unavailable";
  return `${window.start.slice(0, 10)} through ${window.end.slice(0, 10)} (UTC)`;
}

const BAR_CHART_HEIGHT = 120;
const BAR_CHART_WIDTH = 320;

function DailyBarChart({
  data,
  colors,
}: {
  data: Array<DailyPoint>;
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

  // Derived at render time so that tests can control EXPO_PUBLIC_DOMAIN via process.env.
  const zoneEditorUrl: string | null = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/__mockup/zone-editor`
    : null;
  const warehouseMapUrl: string | null = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/__mockup/warehouse-map`
    : null;
  const { checkStatus, readinessIssue, reportNetworkFailure } = useApiHealth();
  const router = useRouter();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null);
  const [mapToolFailure, setMapToolFailure] = useState<MapToolFailure | null>(null);
  const [openingMapTool, setOpeningMapTool] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const statsGenerationRef = useRef(0);
  const exportGenerationRef = useRef(0);
  const statsControllerRef = useRef<AbortController | null>(null);
  const exportControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
    statsGenerationRef.current += 1;
    exportGenerationRef.current += 1;
    statsControllerRef.current?.abort();
    exportControllerRef.current?.abort();
  }, []);
  useEffect(() => () => {
    statsGenerationRef.current += 1;
    statsControllerRef.current?.abort();
  }, [adminToken]);

  const handleMapTool = useCallback(async (label: string, url: string) => {
    if (openingMapTool) return;
    setOpeningMapTool(label);
    setMapToolFailure(null);
    try {
      await Linking.openURL(url);
    } catch {
      if (!mountedRef.current) return;
      setMapToolFailure({ label, url });
      Alert.alert(
        `Unable to open ${label}`,
        "The tool could not be opened. Copy the URL or try again.",
        [
          {
            text: "Copy URL",
            onPress: () => {
              Clipboard.setStringAsync(url).catch(() => {
                Alert.alert("Copy failed", "The tool URL could not be copied.");
              });
            },
          },
          { text: "Retry", onPress: () => void handleMapTool(label, url) },
          { text: "Cancel", style: "cancel" },
        ],
      );
    } finally {
      if (mountedRef.current) setOpeningMapTool(null);
    }
  }, [openingMapTool]);

  const copyExportLocation = useCallback(async () => {
    if (!exportNotice?.uri) return;
    try {
      await Clipboard.setStringAsync(exportNotice.uri);
      if (mountedRef.current) {
        setExportNotice({
          kind: "copied",
          message: "Export location copied to the clipboard.",
          uri: exportNotice.uri,
        });
      }
    } catch {
      Alert.alert("Copy failed", "The export location could not be copied.");
    }
  }, [exportNotice]);

  const handleExport = useCallback(async () => {
    if (!stats) return;
    exportControllerRef.current?.abort();
    const controller = new AbortController();
    exportControllerRef.current = controller;
    const generation = ++exportGenerationRef.current;
    setExporting(true);
    setExportNotice(null);
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
         if (mountedRef.current && generation === exportGenerationRef.current) {
           setExportNotice({ kind: "downloaded", message: `${filename} downloaded.` });
         }
      } else {
        const file = new FsFile(FsPaths.cache, filename);
        await file.write(csv);
        if (controller.signal.aborted || !mountedRef.current) return;
        const canShare = await Sharing.isAvailableAsync();
        if (controller.signal.aborted || !mountedRef.current) return;
        if (canShare) {
          await Sharing.shareAsync(file.uri, {
            mimeType: "text/csv",
            dialogTitle: "Export Dashboard CSV",
            UTI: "public.comma-separated-values-text",
          });
          if (controller.signal.aborted || !mountedRef.current) return;
           setExportNotice({ kind: "shared", message: `${filename} is ready in the share sheet.` });
         } else {
           setExportNotice({
             kind: "saved",
             message: `${filename} was saved, but native sharing is unavailable.`,
             uri: file.uri,
           });
        }
      }
    } catch (err) {
      if (
        mountedRef.current &&
        generation === exportGenerationRef.current &&
        !controller.signal.aborted
      ) {
        setExportNotice({
          kind: "failed",
          message: `Export failed: ${err instanceof Error ? err.message : "Unknown error"}. Try again.`,
        });
        Alert.alert("Export failed", err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      if (mountedRef.current && generation === exportGenerationRef.current) {
        setExporting(false);
      }
    }
  }, [stats]);

  const fetchStats = useCallback(async (isRefresh = false) => {
    if (!adminToken) return;
    if (!API_BASE) {
      setError("Dashboard API is not configured.");
      if (isRefresh) setRefreshing(false);
      else setLoading(false);
      return;
    }
    statsControllerRef.current?.abort();
    const controller = new AbortController();
    statsControllerRef.current = controller;
    const generation = ++statsGenerationRef.current;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/dashboard-stats`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardStats;
      if (mountedRef.current && generation === statsGenerationRef.current && !controller.signal.aborted) {
        setStats(data);
      }
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current || generation !== statsGenerationRef.current) return;
      if (err instanceof TypeError) reportNetworkFailure();
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      if (mountedRef.current && generation === statsGenerationRef.current) {
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    }
  }, [adminToken, reportNetworkFailure]);

  let readinessMessage: string | null = null;
  if (readinessIssue?.detail === "database_unreachable") {
    readinessMessage = "The application database is temporarily unavailable.";
  } else if (readinessIssue?.detail === "schema_unavailable") {
    readinessMessage = "The application schema is temporarily unavailable.";
  } else if (readinessIssue?.detail === "startup_not_ready") {
    readinessMessage = readinessIssue.startupStatus === "pending"
      ? "Application startup is still in progress."
      : readinessIssue.startupStatus === "timed_out"
        ? "Application startup timed out. Try again shortly."
        : "Application startup did not complete. Try again shortly.";
  }

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
        <Pressable
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Admin Dashboard</Text>
        <Pressable
          onPress={handleExport}
          style={styles.exportBtn}
          hitSlop={8}
          disabled={!stats || exporting}
           accessibilityRole="button"
           accessibilityLabel="Export dashboard CSV"
           accessibilityState={{ disabled: !stats || exporting, busy: exporting }}
        >
          <Feather
            name="download"
            size={18}
            color={!stats || exporting ? colors.mutedForeground : colors.primary}
          />
        </Pressable>
        <Pressable
          onPress={() => fetchStats()}
          style={styles.refreshBtn}
          hitSlop={8}
          disabled={loading || refreshing}
          accessibilityRole="button"
          accessibilityLabel={refreshing ? "Refreshing dashboard" : "Refresh dashboard"}
          accessibilityState={{ disabled: loading || refreshing, busy: loading || refreshing }}
        >
          <Feather
            name="refresh-cw"
            size={18}
            color={loading || refreshing ? colors.mutedForeground : colors.primary}
          />
        </Pressable>
      </View>

      {readinessMessage ? (
        <View
          style={[styles.statusBanner, { backgroundColor: colors.muted, borderColor: colors.warning }]}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          <Text style={[styles.statusText, { color: colors.foreground }]}>{readinessMessage}</Text>
          <Pressable
            onPress={() => void checkStatus()}
            style={[styles.statusAction, { backgroundColor: colors.primary }]}
            accessibilityRole="button"
            accessibilityLabel="Retry application readiness check"
          >
            <Text style={[styles.statusActionText, { color: colors.primaryForeground }]}>Retry status</Text>
          </Pressable>
        </View>
      ) : null}

      {loading && !stats ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>Loading stats…</Text>
        </View>
      ) : !stats && error ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
          <Pressable onPress={() => fetchStats()} style={[styles.retryBtn, { backgroundColor: colors.primary }]}>
            <Text style={[styles.retryBtnText, { color: colors.primaryForeground }]}>Retry</Text>
          </Pressable>
        </View>
      ) : stats ? (
        <ScrollView
          style={{ flex: 1 }}
           contentContainerStyle={[styles.content, { flexGrow: 1 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchStats(true)}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        >
          {error ? (
            <View
              style={[styles.statusBanner, { backgroundColor: colors.muted, borderColor: colors.warning }]}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
            >
              <Text style={[styles.statusText, { color: colors.foreground }]}>
                Showing the last successful snapshot. Refresh failed: {error}
              </Text>
              <Pressable
                onPress={() => fetchStats()}
                style={[styles.statusAction, { backgroundColor: colors.primary }]}
                accessibilityRole="button"
                accessibilityLabel="Retry dashboard refresh"
              >
                <Text style={[styles.statusActionText, { color: colors.primaryForeground }]}>Retry refresh</Text>
              </Pressable>
            </View>
          ) : null}

          {exportNotice ? (
            <View
              style={[
                styles.statusBanner,
                {
                  backgroundColor: exportNotice.kind === "failed" ? colors.muted : colors.card,
                  borderColor: exportNotice.kind === "failed" ? colors.destructive : colors.border,
                },
              ]}
              accessibilityRole={exportNotice.kind === "failed" ? "alert" : undefined}
              accessibilityLiveRegion="polite"
            >
              <Text style={[styles.statusText, { color: colors.foreground }]}>{exportNotice.message}</Text>
              {exportNotice.uri ? (
                <Pressable
                  onPress={() => void copyExportLocation()}
                  style={[styles.statusAction, { backgroundColor: colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel="Copy export location"
                >
                  <Text style={[styles.statusActionText, { color: colors.primaryForeground }]}>
                    Copy location
                  </Text>
                </Pressable>
              ) : null}
              {exportNotice.kind === "failed" ? (
                <Pressable
                  onPress={() => void handleExport()}
                  style={[styles.statusAction, { backgroundColor: colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel="Retry dashboard export"
                >
                  <Text style={[styles.statusActionText, { color: colors.primaryForeground }]}>Retry export</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

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
            <StatBox
              label={`Requests — Last ${stats.window?.days ?? 30} Days`}
              value={displayPrivacyValue(stats.ai.requestsInWindow)}
              colors={colors}
            />
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
                  right={displayPrivacyValue(row.total)}
                  colors={colors}
                />
              ))
            )}
          </View>

          {/* Screen Views */}
          <SectionHeader title="Screen Views" colors={colors} />
          <View style={styles.statRow}>
            <StatBox
              label={`Views — Last ${stats.window?.days ?? 30} UTC Days`}
              value={displayPrivacyValue(stats.screenViews.viewsInWindow)}
              colors={colors}
            />
            <StatBox
              label={`Unique Visitors — Last ${stats.window?.days ?? 30} UTC Days`}
              value={displayPrivacyValue(stats.screenViews.uniqueVisitorsInWindow)}
              colors={colors}
            />
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

          {/* Bounded, privacy-filtered chart */}
          <SectionHeader title="Daily Views — Reporting Window (UTC)" colors={colors} />
          <View style={[styles.chartCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <DailyBarChart data={stats.screenViews.dailyInWindow ?? []} colors={colors} />
          </View>
          <Text style={[styles.privacyDisclosure, { color: colors.mutedForeground }]}>
            Aggregate counts only for the bounded reporting window: {formatReportingWindow(stats.window)}.{"\n"}
            Counts below {stats.privacy?.minimumCellCount ?? 5} events are suppressed.
            {stats.privacy?.uniqueVisitorsAvailable === false
              ? " Unique-visitor reporting is unavailable because server privacy key material is not configured."
              : " Unique visitors are server-derived and rotated daily."}
          </Text>

          {/* Admin tools */}
          <SectionHeader title="Map Calibration" colors={colors} />
          <Pressable
            onPress={() => router.push("/admin-map-calibration")}
            style={({ pressed }) => [
              styles.calibrationBtn,
              { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Feather name="crosshair" size={16} color={colors.foreground} />
            <Text style={[styles.calibrationBtnText, { color: colors.foreground }]}>
              Anchor-Point Calibration
            </Text>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </Pressable>

          {/* Map Tools — only shown when EXPO_PUBLIC_DOMAIN is configured */}
          {(zoneEditorUrl !== null || warehouseMapUrl !== null) && (
            <>
              <SectionHeader title="Map Tools" colors={colors} />
              {mapToolFailure ? (
                <View
                  style={[styles.statusBanner, { backgroundColor: colors.muted, borderColor: colors.destructive }]}
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                >
                  <Text style={[styles.statusText, { color: colors.foreground }]}>
                    Could not open {mapToolFailure.label}. Retry or copy the URL to open it elsewhere.
                  </Text>
                  <View style={styles.statusActions}>
                    <Pressable
                      onPress={() => void handleMapTool(mapToolFailure.label, mapToolFailure.url)}
                      style={[styles.statusAction, { backgroundColor: colors.primary }]}
                      accessibilityRole="button"
                      accessibilityLabel={`Retry opening ${mapToolFailure.label}`}
                    >
                      <Text style={[styles.statusActionText, { color: colors.primaryForeground }]}>Retry</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        Clipboard.setStringAsync(mapToolFailure.url).catch(() => {
                          Alert.alert("Copy failed", "The tool URL could not be copied.");
                        });
                      }}
                      style={[styles.statusAction, { backgroundColor: colors.primary }]}
                      accessibilityRole="button"
                      accessibilityLabel={`Copy ${mapToolFailure.label} URL`}
                    >
                      <Text style={[styles.statusActionText, { color: colors.primaryForeground }]}>Copy URL</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {zoneEditorUrl !== null && (
                <Pressable
                  onPress={() => void handleMapTool("Zone Editor", zoneEditorUrl)}
                  disabled={openingMapTool !== null}
                  style={({ pressed }) => [
                    styles.calibrationBtn,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      opacity: pressed || openingMapTool !== null ? 0.7 : 1,
                    },
                  ]}
                  accessibilityLabel="Open Zone Editor"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: openingMapTool !== null, busy: openingMapTool === "Zone Editor" }}
                >
                  <Feather name="edit-2" size={16} color={colors.foreground} />
                  <Text style={[styles.calibrationBtnText, { color: colors.foreground }]}>
                    Zone Editor
                  </Text>
                  <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
                </Pressable>
              )}
              {warehouseMapUrl !== null && (
                <Pressable
                  onPress={() => void handleMapTool("Warehouse Map", warehouseMapUrl)}
                  disabled={openingMapTool !== null}
                  style={({ pressed }) => [
                    styles.calibrationBtn,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      opacity: pressed || openingMapTool !== null ? 0.7 : 1,
                    },
                  ]}
                  accessibilityLabel="Open Warehouse Map"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: openingMapTool !== null, busy: openingMapTool === "Warehouse Map" }}
                >
                  <Feather name="map" size={16} color={colors.foreground} />
                  <Text style={[styles.calibrationBtnText, { color: colors.foreground }]}>
                    Warehouse Map
                  </Text>
                  <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
                </Pressable>
              )}
            </>
          )}

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
  statusBanner: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12, gap: 8 },
  statusText: { fontSize: 13, lineHeight: 18 },
  statusActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusAction: { alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 7 },
  statusActionText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
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
  calibrationBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 4,
  },
  calibrationBtnText: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium" },
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
  privacyDisclosure: { fontSize: 12, lineHeight: 18, marginTop: 8 },
});
