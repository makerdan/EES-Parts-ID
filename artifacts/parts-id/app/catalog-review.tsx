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
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import { isBinLocationValid, BIN_FORMAT_HINT } from "@/utils/binValidation";

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
  const { adminToken, logoutAdmin, resumeProgress, setResumeProgress, setPendingInventorySearch } = useApp();

  type JobSummary = {
    vendor: string;
    partsFound: number;
    matchedParts: number;
    imagesMatched: number;
    unmatchedParts: Array<{ catalogNumber: string; description: string }>;
  };

  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<number | null>(null);
  const [revertedIds, setRevertedIds] = useState<Set<number>>(new Set());
  const [dismissingId, setDismissingId] = useState<number | null>(null);
  const [resumingId, setResumingId] = useState<number | null>(null);
  const [jobSummary, setJobSummary] = useState<JobSummary | null>(null);
  const [unmatchedExpanded, setUnmatchedExpanded] = useState(false);
  // Track one poll interval per jobId so multiple concurrent resumes work and
  // we can re-attach polls when the screen remounts.
  const resumePollRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const [infoDialog, setInfoDialog] = useState<{ visible: boolean; title: string; message: string }>({
    visible: false, title: "", message: "",
  });
  const showInfo = (title: string, message: string) =>
    setInfoDialog({ visible: true, title, message });

  type AddForm = { vendor: string; catalog: string; description: string; binLocation: string };
  type CreatedPart = { id: number; vendor: string; catalog: string; description: string; binLocations: string[] };
  const [addModalPart, setAddModalPart] = useState<{ catalogNumber: string; description: string } | null>(null);
  const [addForm, setAddForm] = useState<AddForm>({ vendor: "", catalog: "", description: "", binLocation: "" });
  const [addingInProgress, setAddingInProgress] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addedCatalogs, setAddedCatalogs] = useState<Set<string>>(new Set());
  const [addedItem, setAddedItem] = useState<CreatedPart | null>(null);
  const [duplicateItem, setDuplicateItem] = useState<CreatedPart | null>(null);
  const [updatingDescription, setUpdatingDescription] = useState(false);
  const [updateDescriptionError, setUpdateDescriptionError] = useState<string | null>(null);

  const openAddModal = (part: { catalogNumber: string; description: string }) => {
    setAddForm({
      vendor: jobSummary?.vendor ?? "",
      catalog: part.catalogNumber,
      description: part.description,
      binLocation: "",
    });
    setAddError(null);
    setAddedItem(null);
    setDuplicateItem(null);
    setUpdatingDescription(false);
    setUpdateDescriptionError(null);
    setAddModalPart(part);
  };

  const handleUpdateDescription = async () => {
    if (!duplicateItem || updatingDescription) return;
    setUpdatingDescription(true);
    setUpdateDescriptionError(null);
    try {
      const r = await fetch(`${API_BASE}/admin/inventory/${duplicateItem.id}/description`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ description: addForm.description.trim() }),
      });
      if (r.status === 401) { logoutAdmin(); return; }
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        setUpdateDescriptionError(body.error ?? "Failed to update description.");
        return;
      }
      if (addModalPart) {
        setAddedCatalogs((prev) => new Set([...prev, addModalPart.catalogNumber]));
      }
      setAddModalPart(null);
      setDuplicateItem(null);
    } catch {
      setUpdateDescriptionError("Network error. Please try again.");
    } finally {
      setUpdatingDescription(false);
    }
  };

  const handleAddToInventory = async () => {
    if (!addForm.vendor.trim()) {
      setAddError("Vendor is required.");
      return;
    }
    setAddingInProgress(true);
    setAddError(null);
    try {
      const r = await fetch(`${API_BASE}/admin/inventory/add-part`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor: addForm.vendor.trim(),
          catalog: addForm.catalog.trim(),
          description: addForm.description.trim(),
          ...(addForm.binLocation.trim() ? { binLocation: addForm.binLocation.trim() } : {}),
        }),
      });
      if (r.status === 401) { logoutAdmin(); return; }
      if (r.status === 409) {
        const body = await r.json().catch(() => ({})) as { error?: string; existingItem?: CreatedPart };
        if (body.existingItem) {
          setDuplicateItem(body.existingItem);
        } else {
          setAddError(body.error ?? "This part already exists in inventory.");
        }
        return;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        setAddError(body.error ?? "Failed to add part.");
        return;
      }
      const body = await r.json().catch(() => ({})) as { item?: CreatedPart };
      if (addModalPart) {
        setAddedCatalogs((prev) => new Set([...prev, addModalPart.catalogNumber]));
      }
      if (body.item) {
        setAddedItem(body.item);
      } else {
        setAddModalPart(null);
      }
    } catch {
      setAddError("Network error. Please try again.");
    } finally {
      setAddingInProgress(false);
    }
  };

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

      const requests: Promise<Response>[] = [
        fetch(url, { headers: authHeaders }),
      ];
      if (!jobId) {
        requests.push(fetch(`${API_BASE}/admin/catalog-pdf/failed-jobs`, { headers: authHeaders }));
      } else {
        requests.push(fetch(`${API_BASE}/admin/catalog-pdf/${jobId}/status`, { headers: authHeaders }));
      }

      const [reviewRes, secondRes] = await Promise.all(requests);

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

      if (secondRes) {
        if (secondRes.status === 401) { logoutAdmin(); return; }
        if (secondRes.ok) {
          if (jobId) {
            const statusData = await secondRes.json() as {
              vendor?: string;
              partsFound?: number;
              matchedParts?: number;
              imagesMatched?: number;
              unmatchedParts?: Array<{ catalogNumber: string; description: string }>;
            };
            setJobSummary({
              vendor: statusData.vendor ?? "",
              partsFound: statusData.partsFound ?? 0,
              matchedParts: statusData.matchedParts ?? 0,
              imagesMatched: statusData.imagesMatched ?? 0,
              unmatchedParts: statusData.unmatchedParts ?? [],
            });
          } else {
            const failedData = await secondRes.json() as { jobs: FailedJob[] };
            setFailedJobs(failedData.jobs);
          }
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
        if (body.status === "done" || body.status === "failed" || body.status === "cancelled") {
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

        {/* Extracted part image — or explicit "no image found" placeholder */}
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
        ) : (
          <View style={[s.noImageBlock, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Text style={s.noImageIcon}>🚫</Text>
            <Text style={[s.noImageText, { color: colors.mutedForeground }]}>No image found</Text>
          </View>
        )}

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

      {/* Add to Inventory Modal */}
      <Modal
        visible={addModalPart !== null}
        animationType="slide"
        transparent
        onRequestClose={() => { if (!addingInProgress) { setAddModalPart(null); setDuplicateItem(null); } }}
      >
        <KeyboardAvoidingView
          style={s.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={[s.modalSheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[s.modalHeader, { borderBottomColor: colors.border }]}>
              <Text style={[s.modalTitle, { color: colors.foreground }]}>
                {addedItem ? "Part Added" : duplicateItem ? "Already in Inventory" : "Add to Inventory"}
              </Text>
              <Pressable
                onPress={() => { if (!addingInProgress) { setAddModalPart(null); setAddedItem(null); setDuplicateItem(null); } }}
                style={s.modalCloseBtn}
                hitSlop={8}
              >
                <Text style={[s.modalCloseText, { color: colors.mutedForeground }]}>✕</Text>
              </Pressable>
            </View>

            {addedItem ? (
              <>
                <ScrollView style={s.modalBody}>
                  <View style={s.successIconWrap}>
                    <View style={[s.successIconCircle, { backgroundColor: colors.primary + "18" }]}>
                      <Text style={s.successIconText}>✓</Text>
                    </View>
                    <Text style={[s.successHeading, { color: colors.foreground }]}>
                      Added to inventory
                    </Text>
                    <Text style={[s.successSubheading, { color: colors.mutedForeground }]}>
                      Item #{addedItem.id}
                    </Text>
                  </View>

                  <View style={[s.createdCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
                    <View style={s.createdRow}>
                      <Text style={[s.createdLabel, { color: colors.mutedForeground }]}>VENDOR</Text>
                      <Text style={[s.createdValue, { color: colors.foreground }]}>{addedItem.vendor}</Text>
                    </View>
                    <View style={[s.createdDivider, { backgroundColor: colors.border }]} />
                    <View style={s.createdRow}>
                      <Text style={[s.createdLabel, { color: colors.mutedForeground }]}>CATALOG</Text>
                      <Text style={[s.createdValue, { color: colors.foreground }]}>{addedItem.catalog}</Text>
                    </View>
                    {addedItem.description ? (
                      <>
                        <View style={[s.createdDivider, { backgroundColor: colors.border }]} />
                        <View style={s.createdRow}>
                          <Text style={[s.createdLabel, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
                          <Text style={[s.createdValue, { color: colors.foreground }]}>{addedItem.description}</Text>
                        </View>
                      </>
                    ) : null}
                    {addedItem.binLocations.length > 0 ? (
                      <>
                        <View style={[s.createdDivider, { backgroundColor: colors.border }]} />
                        <View style={s.createdRow}>
                          <Text style={[s.createdLabel, { color: colors.mutedForeground }]}>BIN</Text>
                          <Text style={[s.createdValue, { color: colors.foreground }]}>{addedItem.binLocations.join(", ")}</Text>
                        </View>
                      </>
                    ) : null}
                  </View>
                </ScrollView>

                <View style={[s.modalFooter, { borderTopColor: colors.border }]}>
                  <Pressable
                    onPress={() => {
                      setPendingInventorySearch({
                        vendor: addedItem.vendor,
                        catalog: addedItem.catalog,
                      });
                      setAddModalPart(null);
                      setAddedItem(null);
                      router.navigate("/");
                    }}
                    style={[s.modalViewInvBtn, { borderColor: colors.primary }]}
                  >
                    <Text style={[s.modalViewInvText, { color: colors.primary }]}>View in Inventory</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { setAddModalPart(null); setAddedItem(null); }}
                    style={[s.modalSubmitBtn, { backgroundColor: colors.primary }]}
                  >
                    <Text style={[s.modalSubmitText, { color: colors.primaryForeground }]}>Done</Text>
                  </Pressable>
                </View>
              </>
            ) : duplicateItem ? (
              <>
                <ScrollView style={s.modalBody}>
                  <View style={s.successIconWrap}>
                    <View style={[s.successIconCircle, { backgroundColor: colors.warning + "18" }]}>
                      <Text style={[s.successIconText, { color: colors.warning }]}>!</Text>
                    </View>
                    <Text style={[s.successHeading, { color: colors.foreground }]}>
                      Part already exists
                    </Text>
                    <Text style={[s.successSubheading, { color: colors.mutedForeground }]}>
                      This catalog number is already in inventory.
                    </Text>
                  </View>

                  <View style={[s.createdCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
                    <View style={s.createdRow}>
                      <Text style={[s.createdLabel, { color: colors.mutedForeground }]}>VENDOR</Text>
                      <Text style={[s.createdValue, { color: colors.foreground }]}>{duplicateItem.vendor}</Text>
                    </View>
                    <View style={[s.createdDivider, { backgroundColor: colors.border }]} />
                    <View style={s.createdRow}>
                      <Text style={[s.createdLabel, { color: colors.mutedForeground }]}>CATALOG</Text>
                      <Text style={[s.createdValue, { color: colors.foreground }]}>{duplicateItem.catalog}</Text>
                    </View>
                    <View style={[s.createdDivider, { backgroundColor: colors.border }]} />
                    {/* Description comparison: show side-by-side when they differ */}
                    {addForm.description.trim() && addForm.description.trim() !== duplicateItem.description ? (
                      <View style={s.descCompareBlock}>
                        <Text style={[s.createdLabel, { color: colors.mutedForeground, marginBottom: 8 }]}>DESCRIPTION</Text>
                        <View style={s.descCompareRow}>
                          <View style={[s.descCompareCol, { borderColor: colors.border }]}>
                            <Text style={[s.descCompareColLabel, { color: colors.mutedForeground }]}>EXISTING</Text>
                            <Text style={[s.descCompareColText, { color: colors.mutedForeground }]}>
                              {duplicateItem.description || "(empty)"}
                            </Text>
                          </View>
                          <View style={[s.descCompareCol, { borderColor: colors.primary + "66", backgroundColor: colors.primary + "08" }]}>
                            <Text style={[s.descCompareColLabel, { color: colors.primary }]}>FROM PDF</Text>
                            <Text style={[s.descCompareColText, { color: colors.foreground }]}>
                              {addForm.description.trim()}
                            </Text>
                          </View>
                        </View>
                      </View>
                    ) : (
                      <View style={s.createdRow}>
                        <Text style={[s.createdLabel, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
                        <Text style={[s.createdValue, { color: colors.foreground }]}>
                          {duplicateItem.description || "(none)"}
                        </Text>
                      </View>
                    )}
                    {duplicateItem.binLocations.length > 0 ? (
                      <>
                        <View style={[s.createdDivider, { backgroundColor: colors.border }]} />
                        <View style={s.createdRow}>
                          <Text style={[s.createdLabel, { color: colors.mutedForeground }]}>BIN</Text>
                          <Text style={[s.createdValue, { color: colors.foreground }]}>{duplicateItem.binLocations.join(", ")}</Text>
                        </View>
                      </>
                    ) : null}
                  </View>

                  {addForm.description.trim() && addForm.description.trim() !== duplicateItem.description ? (
                    <Pressable
                      onPress={() => {
                        setAddModalPart(null);
                        setDuplicateItem(null);
                        setUpdateDescriptionError(null);
                        router.push({ pathname: "/edit-item", params: { item: JSON.stringify(duplicateItem) } });
                      }}
                      disabled={updatingDescription}
                      style={s.viewExistingLink}
                    >
                      <Text style={[s.viewExistingLinkText, { color: colors.primary }]}>
                        View / edit full entry →
                      </Text>
                    </Pressable>
                  ) : null}

                  {updateDescriptionError ? (
                    <Text style={[s.addErrorText, { color: colors.destructive, marginTop: 8 }]}>
                      {updateDescriptionError}
                    </Text>
                  ) : null}
                </ScrollView>

                <View style={[s.modalFooter, { borderTopColor: colors.border }]}>
                  <Pressable
                    onPress={() => { setDuplicateItem(null); setUpdateDescriptionError(null); }}
                    style={[s.modalCancelBtn, { borderColor: colors.border }]}
                    disabled={updatingDescription}
                  >
                    <Text style={[s.modalCancelText, { color: colors.mutedForeground }]}>Go Back</Text>
                  </Pressable>
                  {addForm.description.trim() && addForm.description.trim() !== duplicateItem.description ? (
                    <Pressable
                      onPress={handleUpdateDescription}
                      disabled={updatingDescription}
                      style={[s.modalSubmitBtn, { backgroundColor: colors.primary, opacity: updatingDescription ? 0.6 : 1 }]}
                    >
                      {updatingDescription ? (
                        <ActivityIndicator size="small" color={colors.primaryForeground} />
                      ) : (
                        <Text style={[s.modalSubmitText, { color: colors.primaryForeground }]}>Update description</Text>
                      )}
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => {
                        setAddModalPart(null);
                        setDuplicateItem(null);
                        router.push({ pathname: "/edit-item", params: { item: JSON.stringify(duplicateItem) } });
                      }}
                      style={[s.modalSubmitBtn, { backgroundColor: colors.primary }]}
                    >
                      <Text style={[s.modalSubmitText, { color: colors.primaryForeground }]}>View existing entry</Text>
                    </Pressable>
                  )}
                </View>
              </>
            ) : (
              <>
                <ScrollView style={s.modalBody} keyboardShouldPersistTaps="handled">
                  <Text style={[s.fieldLabel, { color: colors.mutedForeground }]}>VENDOR *</Text>
                  <TextInput
                    style={[s.fieldInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                    placeholder="e.g. LEVITON"
                    placeholderTextColor={colors.mutedForeground}
                    value={addForm.vendor}
                    onChangeText={(v) => setAddForm((f) => ({ ...f, vendor: v }))}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    editable={!addingInProgress}
                  />

                  <Text style={[s.fieldLabel, { color: colors.mutedForeground, marginTop: 14 }]}>CATALOG NUMBER</Text>
                  <TextInput
                    style={[s.fieldInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                    placeholder="Catalog number"
                    placeholderTextColor={colors.mutedForeground}
                    value={addForm.catalog}
                    onChangeText={(v) => setAddForm((f) => ({ ...f, catalog: v }))}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!addingInProgress}
                  />

                  <Text style={[s.fieldLabel, { color: colors.mutedForeground, marginTop: 14 }]}>DESCRIPTION</Text>
                  <TextInput
                    style={[s.fieldInput, s.fieldInputMulti, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                    placeholder="Description"
                    placeholderTextColor={colors.mutedForeground}
                    value={addForm.description}
                    onChangeText={(v) => setAddForm((f) => ({ ...f, description: v }))}
                    multiline
                    numberOfLines={3}
                    editable={!addingInProgress}
                  />

                  <Text style={[s.fieldLabel, { color: colors.mutedForeground, marginTop: 14 }]}>BIN LOCATION</Text>
                  <TextInput
                    style={[s.fieldInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground }]}
                    placeholder="e.g. A-12-3 (optional)"
                    placeholderTextColor={colors.mutedForeground}
                    value={addForm.binLocation}
                    onChangeText={(v) => setAddForm((f) => ({ ...f, binLocation: v }))}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    editable={!addingInProgress}
                  />
                  {addForm.binLocation.trim() && !isBinLocationValid(addForm.binLocation) ? (
                    <Text style={[s.binFormatHint, { color: colors.warning }]}>
                      ⚠ {BIN_FORMAT_HINT}
                    </Text>
                  ) : null}

                  {addError ? (
                    <Text style={[s.addErrorText, { color: colors.destructive }]}>{addError}</Text>
                  ) : null}
                </ScrollView>

                <View style={[s.modalFooter, { borderTopColor: colors.border }]}>
                  <Pressable
                    onPress={() => { if (!addingInProgress) setAddModalPart(null); }}
                    style={[s.modalCancelBtn, { borderColor: colors.border }]}
                    disabled={addingInProgress}
                  >
                    <Text style={[s.modalCancelText, { color: colors.mutedForeground }]}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleAddToInventory}
                    disabled={addingInProgress}
                    style={[s.modalSubmitBtn, { backgroundColor: colors.primary, opacity: addingInProgress ? 0.6 : 1 }]}
                  >
                    {addingInProgress ? (
                      <ActivityIndicator size="small" color={colors.primaryForeground} />
                    ) : (
                      <Text style={[s.modalSubmitText, { color: colors.primaryForeground }]}>Add to Inventory</Text>
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
      ) : listData.length === 0 && failedJobs.length === 0 && Object.keys(resumeProgress).length === 0 && !(jobId && jobSummary && jobSummary.unmatchedParts.length > 0) ? (
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
          {/* Job-specific extraction summary banner */}
          {jobId && jobSummary ? (
            <View style={[s.extractionBanner, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
              <View style={s.extractionStat}>
                <Text style={s.extractionIcon}>📄</Text>
                <Text style={[s.extractionStatNum, { color: colors.foreground }]}>{jobSummary.partsFound}</Text>
                <Text style={[s.extractionStatLabel, { color: colors.mutedForeground }]}>parts found</Text>
              </View>
              <View style={[s.extractionDivider, { backgroundColor: colors.border }]} />
              <View style={s.extractionStat}>
                <Text style={s.extractionIcon}>✅</Text>
                <Text style={[s.extractionStatNum, { color: colors.primary }]}>{jobSummary.matchedParts}</Text>
                <Text style={[s.extractionStatLabel, { color: colors.mutedForeground }]}>matched</Text>
              </View>
              <View style={[s.extractionDivider, { backgroundColor: colors.border }]} />
              <View style={s.extractionStat}>
                <Text style={s.extractionIcon}>🖼️</Text>
                <Text style={[s.extractionStatNum, { color: colors.foreground }]}>{jobSummary.imagesMatched}</Text>
                <Text style={[s.extractionStatLabel, { color: colors.mutedForeground }]}>images</Text>
              </View>
            </View>
          ) : null}

          {/* General session summary bar (shown when not in job-specific view) */}
          {(!jobId && listData.length > 0) ? (
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
            ListFooterComponent={
              jobId && jobSummary && jobSummary.unmatchedParts.length > 0 ? (
                <View style={[s.unmatchedSection, { borderTopColor: colors.border }]}>
                  <Pressable
                    onPress={() => setUnmatchedExpanded((v) => !v)}
                    style={[s.unmatchedHeader, { backgroundColor: colors.muted }]}
                  >
                    <Text style={[s.unmatchedHeaderText, { color: colors.foreground }]}>
                      Unrecognized parts ({jobSummary.unmatchedParts.length})
                    </Text>
                    <Text style={[s.unmatchedChevron, { color: colors.mutedForeground }]}>
                      {unmatchedExpanded ? "▲" : "▼"}
                    </Text>
                  </Pressable>
                  {unmatchedExpanded ? (
                    <>
                      <View style={[s.unmatchedNote, { backgroundColor: colors.card, borderColor: colors.border }]}>
                        <Text style={[s.unmatchedNoteText, { color: colors.mutedForeground }]}>
                          These part numbers were extracted by AI but don't match any item in your inventory. Review them to decide whether to add them.
                        </Text>
                      </View>
                      {jobSummary.unmatchedParts.map((p, i) => {
                        const isAdded = addedCatalogs.has(p.catalogNumber);
                        return (
                          <View
                            key={`${p.catalogNumber}-${i}`}
                            style={[s.unmatchedRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                          >
                            <View style={s.unmatchedRowTop}>
                              <View style={s.unmatchedRowInfo}>
                                <Text style={[s.unmatchedCatalog, { color: colors.foreground }]}>{p.catalogNumber}</Text>
                                {p.description ? (
                                  <Text style={[s.unmatchedDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
                                    {p.description}
                                  </Text>
                                ) : null}
                              </View>
                              {isAdded ? (
                                <View style={[s.addedBadge, { backgroundColor: colors.primary + "22" }]}>
                                  <Text style={[s.addedBadgeText, { color: colors.primary }]}>✓ Added</Text>
                                </View>
                              ) : (
                                <Pressable
                                  onPress={() => openAddModal(p)}
                                  style={[s.addBtn, { backgroundColor: colors.primary }]}
                                >
                                  <Text style={[s.addBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
                                </Pressable>
                              )}
                            </View>
                          </View>
                        );
                      })}
                    </>
                  ) : null}
                </View>
              ) : null
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
  noImageBlock: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
    borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, gap: 6,
  },
  noImageIcon: { fontSize: 14 },
  noImageText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  extractionBanner: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-around",
    paddingVertical: 14, paddingHorizontal: 14, borderBottomWidth: 1,
  },
  extractionStat: { alignItems: "center", flex: 1 },
  extractionIcon: { fontSize: 18, marginBottom: 2 },
  extractionStatNum: { fontSize: 22, fontFamily: "Inter_700Bold" },
  extractionStatLabel: { fontSize: 11, fontFamily: "Inter_500Medium", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },
  extractionDivider: { width: 1, height: 36 },
  unmatchedSection: { marginTop: 8, borderTopWidth: 1 },
  unmatchedHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingVertical: 12,
  },
  unmatchedHeaderText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  unmatchedChevron: { fontSize: 12, fontFamily: "Inter_500Medium" },
  unmatchedNote: {
    marginHorizontal: 12, marginTop: 6, padding: 12, borderRadius: 8, borderWidth: 1,
  },
  unmatchedNoteText: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  unmatchedRow: {
    marginHorizontal: 12, marginTop: 6, borderRadius: 10, borderWidth: 1, padding: 12, gap: 4,
  },
  unmatchedRowTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  unmatchedRowInfo: { flex: 1, gap: 4 },
  unmatchedCatalog: { fontSize: 13, fontFamily: "Inter_700Bold" },
  unmatchedDesc: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  addBtn: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
  },
  addBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  addedBadge: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
  },
  addedBadgeText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  modalOverlay: {
    flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)",
  },
  modalSheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1,
    maxHeight: "85%",
  },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 18, paddingVertical: 16, borderBottomWidth: 1,
  },
  modalTitle: { fontSize: 17, fontFamily: "Inter_700Bold" },
  modalCloseBtn: { padding: 4 },
  modalCloseText: { fontSize: 18, fontFamily: "Inter_400Regular" },
  modalBody: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 8 },
  fieldLabel: {
    fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 6,
  },
  fieldInput: {
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11,
    fontSize: 15, fontFamily: "Inter_400Regular",
  },
  fieldInputMulti: { minHeight: 80, textAlignVertical: "top", paddingTop: 11 },
  addErrorText: { fontSize: 13, fontFamily: "Inter_500Medium", marginTop: 10, marginBottom: 4 },
  binFormatHint: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 5, marginBottom: 2 },
  modalFooter: {
    flexDirection: "row", gap: 10, paddingHorizontal: 18, paddingVertical: 16, borderTopWidth: 1,
  },
  modalCancelBtn: {
    flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 13, alignItems: "center",
  },
  modalCancelText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  modalSubmitBtn: {
    flex: 2, borderRadius: 10, paddingVertical: 13, alignItems: "center", justifyContent: "center",
  },
  modalSubmitText: { fontSize: 14, fontFamily: "Inter_700Bold" },
  modalViewInvBtn: {
    flex: 1, borderWidth: 1.5, borderRadius: 10, paddingVertical: 13, alignItems: "center", justifyContent: "center",
  },
  modalViewInvText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  successIconWrap: { alignItems: "center", paddingVertical: 24, gap: 8 },
  successIconCircle: {
    width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center",
  },
  successIconText: { fontSize: 32, color: "#22c55e" },
  successHeading: { fontSize: 18, fontFamily: "Inter_700Bold", marginTop: 4 },
  successSubheading: { fontSize: 13, fontFamily: "Inter_400Regular" },
  createdCard: {
    borderWidth: 1, borderRadius: 12, overflow: "hidden", marginBottom: 16,
  },
  createdRow: {
    paddingHorizontal: 16, paddingVertical: 12, gap: 2,
  },
  createdLabel: {
    fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.6, textTransform: "uppercase",
  },
  createdValue: { fontSize: 15, fontFamily: "Inter_500Medium" },
  createdDivider: { height: 1 },
  descCompareBlock: {
    paddingHorizontal: 16, paddingVertical: 12, gap: 2,
  },
  descCompareRow: {
    flexDirection: "row", gap: 8, marginTop: 2,
  },
  descCompareCol: {
    flex: 1, borderWidth: 1, borderRadius: 8, padding: 10, gap: 4,
  },
  descCompareColLabel: {
    fontSize: 9, fontFamily: "Inter_700Bold", letterSpacing: 0.6, textTransform: "uppercase",
  },
  descCompareColText: {
    fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17,
  },
  viewExistingLink: {
    alignSelf: "center", marginTop: 12, paddingVertical: 6, paddingHorizontal: 4,
  },
  viewExistingLinkText: {
    fontSize: 13, fontFamily: "Inter_500Medium", textDecorationLine: "underline",
  },
});
