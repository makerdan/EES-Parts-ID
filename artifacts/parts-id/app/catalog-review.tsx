/**
 * Catalog Review Screen
 *
 * Lists all inventory items updated by PDF extraction, grouped by upload
 * session. Each item shows the before/after description change. Low-confidence
 * matches are flagged. Admins can revert individual parts.
 *
 * Route: /catalog-review?jobId=<n>  (jobId optional — omit to show all)
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { RetryImage } from "@/components/RetryImage";
import { FailedJobsSection } from "@/components/FailedJobsSection";
import { InfoDialog } from "@/components/ConfirmDialog";
import type { ResumeProgress } from "@/types/catalogPdf";
import { useTrackScreen } from "@/utils/useTrackScreen";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

type JobMeta = {
  id: number;
  vendor: string;
  filename: string;
  status: string;
  createdAt: string;
};

type FailedJob = {
  id: number;
  vendor: string;
  filename: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  processedPages: number;
  totalPages: number | null;
  matchedParts: number;
};

type ReviewItem = {
  id: number;
  vendor: string;
  catalog: string;
  description: string;
  previousDescription: string | null;
  imageUrl: string | null;
  imageConfidence: number | null;
  catalogPdfJobId: number | null;
  updatedAt: string;
  isLowConfidence: boolean;
  job: JobMeta | null;
};

type SessionGroup = {
  job: JobMeta | null;
  jobId: number | null;
  items: ReviewItem[];
};

export default function CatalogReviewScreen() {
  "use no memo";
  useTrackScreen("Catalog Review");
  const colors = useColors();
  const router = useRouter();
  const { jobId } = useLocalSearchParams<{ jobId?: string }>();
  const { adminToken, logoutAdmin, resumeProgress, setResumeProgress } = useApp();

  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [revertedIds, setRevertedIds] = useState<Set<number>>(new Set());
  const [dismissingId, setDismissingId] = useState<number | null>(null);
  const [resumingId, setResumingId] = useState<number | null>(null);
  // Track one poll interval per jobId so multiple concurrent resumes work and
  // we can re-attach polls when the screen remounts.
  const resumePollRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const [infoDialog, setInfoDialog] = useState<{ visible: boolean; title: string; message: string }>({
    visible: false, title: "", message: "",
  });
  const showInfo = (title: string, message: string) =>
    setInfoDialog({ visible: true, title, message });

  const authHeaders: Record<string, string> = adminToken
    ? { Authorization: `Bearer ${adminToken}` }
    : {};

  const fetchItems = useCallback(async (isRefresh = false) => {
    if (!adminToken) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const url = jobId
        ? `${API_BASE}/admin/catalog-pdf/reviews?jobId=${jobId}`
        : `${API_BASE}/admin/catalog-pdf/reviews`;
      const [reviewRes, failedRes] = await Promise.all([
        fetch(url, { headers: authHeaders }),
        jobId ? Promise.resolve(null) : fetch(`${API_BASE}/admin/catalog-pdf/failed-jobs`, { headers: authHeaders }),
      ]);

      if (reviewRes.status === 401) { logoutAdmin(); return; }
      if (!reviewRes.ok) throw new Error("Failed to load");
      const data = await reviewRes.json() as { items: ReviewItem[] };

      // Group by upload session (catalogPdfJobId)
      const groupMap = new Map<number | null, SessionGroup>();
      for (const item of data.items) {
        const key = item.catalogPdfJobId;
        if (!groupMap.has(key)) {
          groupMap.set(key, { job: item.job, jobId: key, items: [] });
        }
        groupMap.get(key)!.items.push(item);
      }
      // Sort groups newest-first (higher jobId = newer)
      setGroups(
        [...groupMap.values()].sort((a, b) => (b.jobId ?? 0) - (a.jobId ?? 0)),
      );

      if (failedRes) {
        if (failedRes.status === 401) { logoutAdmin(); return; }
        if (failedRes.ok) {
          const failedData = await failedRes.json() as { jobs: FailedJob[] };
          setFailedJobs(failedData.jobs);
        }
      }
    } catch {
      setError("Could not load review data. Check your connection.");
    } finally {
      if (isRefresh) setRefreshing(false);
      else setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken, jobId]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Helper: start (or re-start) polling the status endpoint for a given jobId.
  // Stored in a ref so it can be called from handleResume AND the remount effect.
  const startPollForJobRef = useRef<(id: number, headers: Record<string, string>) => void>(
    () => undefined,
  );
  startPollForJobRef.current = (id: number, headers: Record<string, string>) => {
    if (resumePollRef.current[id]) {
      clearInterval(resumePollRef.current[id]);
    }
    resumePollRef.current[id] = setInterval(async () => {
      try {
        const statusRes = await fetch(`${API_BASE}/admin/catalog-pdf/${id}/status`, { headers });
        if (!statusRes.ok) return;
        const body = await statusRes.json() as {
          status: string;
          processedPages: number;
          totalPages: number | null;
          matchedParts: number;
          errorMessage: string | null;
        };
        setResumeProgress((prev) => ({
          ...prev,
          [id]: {
            status: (body.status === "pending" ? "uploading" : body.status) as ResumeProgress["status"],
            processedPages: body.processedPages ?? 0,
            totalPages: body.totalPages ?? null,
            matchedParts: body.matchedParts ?? 0,
            errorMessage: body.errorMessage ?? null,
          },
        }));
        if (body.status === "done" || body.status === "failed") {
          clearInterval(resumePollRef.current[id]);
          delete resumePollRef.current[id];
          setResumingId((prev) => (prev === id ? null : prev));
          if (body.status === "done") {
            setFailedJobs((prev) => prev.filter((j) => j.id !== id));
          }
          fetchItems();
        }
      } catch { /* silent */ }
    }, 3000);
  };

  // Convenience wrapper so call sites don't reach into the ref directly.
  const startPollForJob = (id: number, headers: Record<string, string>) =>
    startPollForJobRef.current(id, headers);

  // On mount (and whenever adminToken changes), re-attach polling for any jobs
  // that are still in-progress in the shared context (e.g. the user navigated
  // away while a resume was running and has now come back).
  useEffect(() => {
    if (!adminToken) return;
    const headers: Record<string, string> = { Authorization: `Bearer ${adminToken}` };
    const pollMap = resumePollRef.current;
    for (const [key, progress] of Object.entries(resumeProgress)) {
      const id = Number(key);
      if (
        (progress.status === "uploading" || progress.status === "processing") &&
        !pollMap[id]
      ) {
        startPollForJobRef.current(id, headers);
      }
    }
    return () => {
      // Clear all active polls when the screen unmounts (they will be
      // re-attached on the next mount via the effect above).
      for (const interval of Object.values(pollMap)) {
        clearInterval(interval);
      }
      resumePollRef.current = {};
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminToken]);

  const handleDismiss = async (jobId: number) => {
    if (dismissingId) return;
    setDismissingId(jobId);
    try {
      const r = await fetch(`${API_BASE}/admin/catalog-pdf/${jobId}/dismiss`, {
        method: "POST",
        headers: authHeaders,
      });
      if (r.status === 401) { logoutAdmin(); return; }
      if (r.ok) {
        setFailedJobs((prev) => prev.filter((j) => j.id !== jobId));
      }
    } catch { /* silent */ }
    finally { setDismissingId(null); }
  };

  const handleResume = async (jobId: number) => {
    if (resumingId) return;

    // Pick the PDF file
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({ type: "application/pdf", copyToCacheDirectory: true });
    } catch {
      showInfo("Error", "Could not open the file picker.");
      return;
    }

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    const uri = asset.uri;

    // Validate file size (max ~25 MB)
    const MAX_PDF_BYTES = 25 * 1024 * 1024;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && "size" in info && info.size > MAX_PDF_BYTES) {
        showInfo("File too large", "Please select a PDF under 25 MB.");
        return;
      }
    } catch { /* proceed even if size check fails */ }

    setResumingId(jobId);

    try {
      const pdfBase64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const r = await fetch(`${API_BASE}/admin/catalog-pdf/${jobId}/resume`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ pdfBase64 }),
      });

      if (r.status === 401) { logoutAdmin(); return; }
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        showInfo("Resume failed", body.error ?? "Could not resume the job.");
        return;
      }

      // Mark job as in-progress (keep it visible with a progress card)
      setResumeProgress((prev) => ({
        ...prev,
        [jobId]: { status: "uploading", processedPages: 0, totalPages: null, matchedParts: 0, errorMessage: null },
      }));

      // Poll until the job finishes, then refresh the review list
      startPollForJob(jobId, authHeaders);
    } catch {
      showInfo("Error", "Could not read or send the PDF file.");
      setResumingId(null);
    }
  };

  const handleDismissResumeError = (jobId: number) => {
    setResumeProgress((prev) => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
  };

  const handleRevert = async (item: ReviewItem) => {
    if (revertingId) return;
    setRevertingId(item.id);
    try {
      const r = await fetch(`${API_BASE}/admin/catalog-pdf/reviews/${item.id}/revert`, {
        method: "POST",
        headers: authHeaders,
      });
      if (r.status === 401) { logoutAdmin(); return; }
      if (!r.ok) return;
      setRevertedIds((prev) => new Set([...prev, item.id]));
    } catch { /* silent */ }
    finally { setRevertingId(null); }
  };

  const totalActive = groups.reduce(
    (acc, g) => acc + g.items.filter((i) => !revertedIds.has(i.id)).length,
    0,
  );

  // Flat list data: section headers + items
  type ListRow =
    | { kind: "header"; group: SessionGroup }
    | { kind: "item"; item: ReviewItem };

  const listData: ListRow[] = [];
  for (const group of groups) {
    const activeItems = group.items.filter((i) => !revertedIds.has(i.id));
    if (activeItems.length === 0) continue;
    listData.push({ kind: "header", group });
    for (const item of activeItems) {
      listData.push({ kind: "item", item });
    }
  }

  const renderRow = ({ item: row }: { item: ListRow }) => {
    if (row.kind === "header") {
      const { group } = row;
      const date = group.job?.createdAt
        ? new Date(group.job.createdAt).toLocaleDateString()
        : "Unknown date";
      return (
        <View style={[s.sectionHeader, { backgroundColor: colors.muted }]}>
          <Text style={[s.sectionTitle, { color: colors.foreground }]}>
            {group.job?.vendor ?? "Unknown vendor"} — {group.job?.filename ?? "catalog.pdf"}
          </Text>
          <Text style={[s.sectionSub, { color: colors.mutedForeground }]}>
            {date} · {group.items.filter((i) => !revertedIds.has(i.id)).length} item{group.items.length !== 1 ? "s" : ""}
          </Text>
        </View>
      );
    }

    const { item } = row;
    const conf = item.imageConfidence != null ? Math.round(item.imageConfidence * 100) : null;
    const isReverting = revertingId === item.id;

    return (
      <View style={[s.row, { backgroundColor: colors.card, borderColor: item.isLowConfidence ? colors.warning + "88" : colors.border }]}>
        <View style={s.rowTop}>
          <View style={s.rowIdent}>
            <Text style={[s.catalog, { color: colors.foreground }]}>{item.catalog}</Text>
            <Text style={[s.vendor, { color: colors.mutedForeground }]}>{item.vendor}</Text>
          </View>
          <View style={s.rowBadges}>
            {item.isLowConfidence ? (
              <View style={[s.badge, { backgroundColor: colors.warning + "22" }]}>
                <Text style={[s.badgeText, { color: colors.warning }]}>Low confidence</Text>
              </View>
            ) : null}
            {conf != null ? (
              <View style={[s.badge, { backgroundColor: colors.muted }]}>
                <Text style={[s.badgeText, { color: colors.mutedForeground }]}>{conf}%</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* Description diff */}
        <View style={s.diffBlock}>
          {item.previousDescription != null && item.previousDescription !== item.description ? (
            <>
              <Text style={[s.diffLabel, { color: colors.mutedForeground }]}>Before</Text>
              <Text style={[s.diffOld, { color: colors.mutedForeground, textDecorationLine: "line-through" }]} numberOfLines={2}>
                {item.previousDescription || "(empty)"}
              </Text>
              <Text style={[s.diffLabel, { color: colors.mutedForeground, marginTop: 4 }]}>After</Text>
              <Text style={[s.diffNew, { color: colors.foreground }]} numberOfLines={2}>
                {item.description}
              </Text>
            </>
          ) : (
            <Text style={[s.diffNew, { color: colors.foreground }]} numberOfLines={2}>
              {item.description || "(no description)"}
            </Text>
          )}
        </View>

        {/* Extracted part image */}
        {item.imageUrl ? (
          <View style={s.imageBlock}>
            <RetryImage
              uri={item.imageUrl.startsWith("/objects/")
                ? `${API_BASE.replace("/api", "")}${item.imageUrl}`
                : item.imageUrl}
              style={s.partImage}
              resizeMode="contain"
            />
          </View>
        ) : null}

        {/* Revert button */}
        <Pressable
          onPress={() => handleRevert(item)}
          disabled={isReverting}
          style={[s.revertBtn, { borderColor: colors.destructive + "88" }]}
        >
          {isReverting ? (
            <ActivityIndicator size="small" color={colors.destructive} />
          ) : (
            <Text style={[s.revertBtnText, { color: colors.destructive }]}>Revert</Text>
          )}
        </Pressable>
      </View>
    );
  };

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: colors.background }]}>
      <InfoDialog
        visible={infoDialog.visible}
        title={infoDialog.title}
        message={infoDialog.message}
        onDismiss={() => setInfoDialog(prev => ({ ...prev, visible: false }))}
      />
      {/* Header */}
      <View style={[s.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={[s.backText, { color: colors.primary }]}>← Back</Text>
        </Pressable>
        <View style={s.headerCenter}>
          <Text style={[s.headerTitle, { color: colors.foreground }]}>Catalog Review</Text>
          {jobId ? (
            <Text style={[s.headerSub, { color: colors.mutedForeground }]}>Job #{jobId}</Text>
          ) : null}
        </View>
        <Pressable onPress={() => fetchItems()} style={s.refreshBtn}>
          <Text style={[s.refreshText, { color: colors.mutedForeground }]}>Refresh</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[s.hint, { color: colors.mutedForeground }]}>Loading…</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={[s.errorText, { color: colors.destructive }]}>{error}</Text>
          <Pressable onPress={() => fetchItems()} style={[s.retryBtn, { backgroundColor: colors.primary }]}>
            <Text style={[s.retryBtnText, { color: colors.primaryForeground }]}>Retry</Text>
          </Pressable>
        </View>
      ) : listData.length === 0 && failedJobs.length === 0 && Object.keys(resumeProgress).length === 0 ? (
        <View style={s.center}>
          <Text style={[s.emptyTitle, { color: colors.foreground }]}>
            {revertedIds.size > 0 ? "All reverted" : "No items to review"}
          </Text>
          <Text style={[s.hint, { color: colors.mutedForeground }]}>
            {revertedIds.size > 0
              ? `${revertedIds.size} item${revertedIds.size !== 1 ? "s" : ""} reverted.`
              : "No inventory items have been updated by PDF extraction yet."}
          </Text>
        </View>
      ) : (
        <>
          {(listData.length > 0) ? (
            <View style={[s.summaryBar, { borderBottomColor: colors.border }]}>
              <Text style={[s.summaryText, { color: colors.mutedForeground }]}>
                {totalActive} item{totalActive !== 1 ? "s" : ""} across {groups.filter(g => g.items.filter(i => !revertedIds.has(i.id)).length > 0).length} session{groups.length !== 1 ? "s" : ""}
                {revertedIds.size > 0 ? ` · ${revertedIds.size} reverted` : ""}
              </Text>
            </View>
          ) : null}
          <FlatList
            data={listData}
            keyExtractor={(row, i) =>
              row.kind === "header"
                ? `hdr-${row.group.jobId ?? "null"}`
                : `item-${row.item.id}-${i}`
            }
            renderItem={renderRow}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => fetchItems(true)}
                tintColor={colors.primary}
                colors={[colors.primary]}
              />
            }
            ListHeaderComponent={
              <FailedJobsSection
                failedJobs={failedJobs}
                dismissingId={dismissingId}
                resumingId={resumingId}
                resumeProgress={resumeProgress}
                onDismiss={handleDismiss}
                onResume={handleResume}
                onReviewChanges={(id) => router.push(`/catalog-review?jobId=${id}`)}
                onDismissResumeError={handleDismissResumeError}
                colors={colors}
              />
            }
            contentContainerStyle={{ paddingBottom: 100 }}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1,
  },
  backBtn: { minWidth: 60 },
  backText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: { fontSize: 17, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
  refreshBtn: { minWidth: 60, alignItems: "flex-end" },
  refreshText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  hint: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
  emptyTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium", textAlign: "center" },
  retryBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  retryBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  summaryBar: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  summaryText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  sectionHeader: { paddingHorizontal: 14, paddingVertical: 10, marginTop: 8 },
  sectionTitle: { fontSize: 14, fontFamily: "Inter_700Bold" },
  sectionSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  row: { marginHorizontal: 12, marginTop: 8, borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  rowTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  rowIdent: { flex: 1 },
  rowBadges: { flexDirection: "row", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" },
  catalog: { fontSize: 15, fontFamily: "Inter_700Bold" },
  vendor: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  diffBlock: { gap: 2 },
  diffLabel: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5 },
  diffOld: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  diffNew: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  revertBtn: { borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, alignSelf: "flex-start", alignItems: "center" },
  revertBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  imageBlock: { borderRadius: 8, overflow: "hidden", alignSelf: "flex-start" },
  partImage: { width: 120, height: 90 },
});
