/**
 * CatalogPdfUpload
 *
 * Self-contained card for the admin "upload" tab. Lets an admin pick a
 * manufacturer PDF catalog, sends it to POST /api/admin/catalog-pdf, then
 * polls the job status endpoint and shows progress. When the job is done a
 * "Review changes" button links to the catalog-review screen.
 *
 * Large PDFs (> CHUNK_SIZE_THRESHOLD bytes) are split client-side into
 * page-range chunks using pdf-lib and uploaded sequentially. Each chunk is
 * sent with chunkIndex / chunkCount / parentJobId / pageOffset fields. The
 * server creates a parent job for the first chunk and returns that parent ID
 * for all subsequent polling. Small PDFs follow the existing single-upload
 * path unchanged.
 */

import "buffer";
import { Buffer } from "buffer";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import * as DocumentPicker from "expo-document-picker";
import { activateKeepAwake, deactivateKeepAwake } from "expo-keep-awake";
import { readPdfAsBytes, InvalidPdfError, EncryptedPdfError } from "@/utils/readPdfAsBase64";
import { splitPdfIntoChunks, PAGES_PER_CHUNK } from "@/utils/splitPdfIntoChunks";
import { useNavigation, useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

const POLL_MS = 2500;

/** Files above this threshold are split into chunks before uploading. */
const CHUNK_SIZE_THRESHOLD = 20 * 1024 * 1024; // 20 MB

type JobStatus = {
  jobId: string;
  status: "pending" | "processing" | "done" | "failed" | "cancelled";
  totalPages: number | null;
  processedPages: number;
  matchedParts: number;
  imagesMatched: number;
  errorMessage: string | null;
};

interface Props {
  adminToken: string | null;
  onSessionExpired: () => void;
}

/** Encode a Uint8Array to a base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function CatalogPdfUpload({ adminToken, onSessionExpired }: Props) {
  "use no memo";
  const colors = useColors();
  const router = useRouter();
  const navigation = useNavigation();

  const [vendor, setVendor] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [chunkLabel, setChunkLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRetryBtn, setShowRetryBtn] = useState(false);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);

  const [uploadSpeed, setUploadSpeed] = useState<number | null>(null);
  const [uploadEta, setUploadEta] = useState<number | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const [chunksCompleted, setChunksCompleted] = useState(0);
  const [chunksTotal, setChunksTotal] = useState(0);

  useEffect(() => {
    if (retryCountdown === null || retryCountdown <= 0) return;
    const timer = setTimeout(() => {
      setRetryCountdown(prev => (prev !== null && prev > 1 ? prev - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [retryCountdown]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const adminTokenRef = useRef(adminToken);
  useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);

  useEffect(() => {
    if (!loading) return;
    activateKeepAwake("catalog-upload");
    return () => { deactivateKeepAwake("catalog-upload"); };
  }, [loading]);

  useEffect(() => {
    if (!loading) return;
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      e.preventDefault();
      Alert.alert(
        "Upload in progress",
        "Are you sure you want to leave? The upload will be cancelled.",
        [
          { text: "Stay", style: "cancel" },
          {
            text: "Leave",
            style: "destructive",
            onPress: () => navigation.dispatch(e.data.action),
          },
        ]
      );
    });
    return unsubscribe;
  }, [loading, navigation]);

  const speedSamplesRef = useRef<{ t: number; loaded: number }[]>([]);
  const SPEED_WINDOW_MS = 4000;
  const SPEED_WINDOW_MAX = 20;

  type FailedChunkInfo = {
    chunkIndex: number;
    totalChunks: number;
    parentJobId: string | null;
  };
  const [failedChunkInfo, setFailedChunkInfo] = useState<FailedChunkInfo | null>(null);

  const [cancellingJob, setCancellingJob] = useState(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPolling = useCallback((jobId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const token = adminTokenRef.current;
      if (!token) { stopPolling(); return; }
      try {
        const r = await fetch(`${API_BASE}/admin/catalog-pdf/${jobId}/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 401) { stopPolling(); onSessionExpired(); return; }
        if (!r.ok) return;
        const data = await r.json() as JobStatus;
        setJobStatus(data);
        if (data.status === "done" || data.status === "failed" || data.status === "cancelled") stopPolling();
      } catch { /* network blip — keep polling */ }
    }, POLL_MS);
  }, [stopPolling, onSessionExpired]);

  const handleCancelJob = useCallback(async () => {
    const token = adminTokenRef.current;
    if (!token || !jobStatus?.jobId) return;
    setCancellingJob(true);
    try {
      const r = await fetch(`${API_BASE}/admin/catalog-pdf/${jobStatus.jobId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 401) { stopPolling(); onSessionExpired(); return; }
      if (r.ok) {
        stopPolling();
        setJobStatus(prev => prev ? { ...prev, status: "cancelled" } : prev);
      }
    } catch { /* ignore — polling will pick up the change */ }
    finally { setCancellingJob(false); }
  }, [jobStatus, stopPolling, onSessionExpired]);

  const handlePickFile = async () => {
    setError(null);
    setPdfBytes(null);
    setFilename(null);
    setReadingFile(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) {
        setReadingFile(false);
        return;
      }
      const asset = result.assets[0]!;
      try {
        const bytes = await readPdfAsBytes(asset.uri);
        setPdfBytes(bytes);
        setFilename(asset.name ?? "catalog.pdf");
      } catch (err) {
        if (err instanceof InvalidPdfError || err instanceof EncryptedPdfError) {
          setError(err.message);
        } else {
          setError((err as Error)?.message ?? "Could not read the PDF file. Please try again.");
        }
      } finally {
        setReadingFile(false);
      }
    } catch {
      setReadingFile(false);
      setError("Could not read the PDF file. Please try again.");
    }
  };

  const MAX_AUTO_RETRIES = 2;

  // ── Single-chunk XHR upload ────────────────────────────────────────────────
  const sendSingleChunk = (
    base64: string,
    extraFields: Record<string, unknown>,
    attempt: number,
    onSuccess: (resp: { jobId: string; chunkJobId?: string }) => void,
    onFailure: (msg: string) => void,
    onAbort: () => void,
    onNetwork: () => void,
  ): void => {
    const token = adminToken!;
    const body = JSON.stringify({
      pdfBase64: base64,
      vendor: vendor.trim(),
      filename: filename ?? "catalog.pdf",
      ...extraFields,
    });

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", `${API_BASE}/admin/catalog-pdf`);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setUploadPct(Math.round((e.loaded / e.total) * 100));
        const now = Date.now();
        const samples = speedSamplesRef.current;
        samples.push({ t: now, loaded: e.loaded });
        const cutoff = now - SPEED_WINDOW_MS;
        while (samples.length > 1 && samples[0]!.t < cutoff) samples.shift();
        if (samples.length > SPEED_WINDOW_MAX) samples.splice(0, samples.length - SPEED_WINDOW_MAX);
        if (samples.length >= 2) {
          const oldest = samples[0]!;
          const newest = samples[samples.length - 1]!;
          const dtMs = newest.t - oldest.t;
          if (dtMs > 0) {
            const bytesPerMs = (newest.loaded - oldest.loaded) / dtMs;
            const bytesPerSec = bytesPerMs * 1000;
            setUploadSpeed(bytesPerSec / (1024 * 1024));
            setUploadEta(bytesPerSec > 0 ? (e.total - e.loaded) / bytesPerSec : null);
          }
        }
      }
    };

    xhr.onabort = () => { xhrRef.current = null; onAbort(); };
    xhr.onerror = () => { xhrRef.current = null; onNetwork(); };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status === 401) { onSessionExpired(); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        let errMsg = "Failed to start job";
        try { errMsg = (JSON.parse(xhr.responseText) as { error?: string }).error ?? errMsg; } catch { /* ignore */ }
        onFailure(errMsg);
        return;
      }
      onSuccess(JSON.parse(xhr.responseText) as { jobId: string; chunkJobId?: string });
    };

    xhr.onerror = () => {
      xhrRef.current = null;
      setUploadPct(null);
      setUploadSpeed(null);
      setUploadEta(null);
      if (attempt < MAX_AUTO_RETRIES) {
        const delaySec = Math.pow(2, attempt);
        setError(null);
        setRetryCountdown(delaySec);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          handleStart(attempt + 1);
        }, delaySec * 1000);
      } else {
        setLoading(false);
        setRetryCountdown(null);
        setError("Network error — check your connection and try again.");
        setShowRetryBtn(true);
      }
    };

    xhr.send(body);
  };

  // ── Chunked upload inner loop ──────────────────────────────────────────────
  // Uploads chunks[startIndex..end], reusing existingParentJobId if provided.
  // On success starts polling. On failure sets failedChunkInfo for targeted retry.
  const uploadChunksFromIndex = async (
    chunks: Awaited<ReturnType<typeof splitPdfIntoChunks>>,
    startIndex: number,
    existingParentJobId: string | null,
  ): Promise<void> => {
    let parentJobId: string | null = existingParentJobId;
    let aborted = false;

    for (let i = startIndex; i < chunks.length; i++) {
      if (aborted) break;
      const chunk = chunks[i]!;
      const base64 = bytesToBase64(chunk.bytes);
      setChunkLabel(`Uploading part ${i + 1} of ${chunks.length}…`);
      setUploadPct(null);

      try {
        const result = await new Promise<{ jobId: string; chunkJobId?: string }>((resolve, reject) => {
          sendSingleChunk(
            base64,
            {
              chunkIndex: i,
              chunkCount: chunks.length,
              pageOffset: chunk.pageOffset,
              ...(parentJobId ? { parentJobId } : {}),
            },
            0,
            resolve,
            (msg) => reject(new Error(msg)),
            () => reject(new Error("__abort__")),
            () => reject(new Error("__network__")),
          );
        });

        if (i === 0) {
          parentJobId = result.jobId;
        }
        setChunksCompleted(i + 1);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === "__abort__") {
          aborted = true;
          setLoading(false);
          setUploadPct(null);
          setChunkLabel(null);
          setChunksCompleted(0);
          setChunksTotal(0);
          setFailedChunkInfo(null);
          return;
        }
        // Network or server error — surface targeted chunk retry
        setLoading(false);
        setUploadPct(null);
        setChunkLabel(null);
        setChunksCompleted(0);
        setChunksTotal(0);
        setFailedChunkInfo({
          chunkIndex: i,
          totalChunks: chunks.length,
          parentJobId: i === 0 ? null : parentJobId,
        });
        setError(msg === "__network__" ? "Network error — check your connection and try again." : msg);
        return;
      }
    }

    if (aborted || !parentJobId) return;

    // All chunks uploaded — start polling parent job
    setUploadPct(null);
    setChunkLabel(null);
    setChunksCompleted(0);
    setChunksTotal(0);
    setLoading(false);
    setPdfBytes(null);
    setFailedChunkInfo(null);

    setJobStatus({
      jobId: parentJobId,
      status: "pending",
      totalPages: null,
      processedPages: 0,
      matchedParts: 0,
      imagesMatched: 0,
      errorMessage: null,
    });
    startPolling(parentJobId);
  };

  // ── Chunked upload flow ────────────────────────────────────────────────────
  const handleChunkedUpload = async (bytes: Uint8Array): Promise<void> => {
    let chunks: Awaited<ReturnType<typeof splitPdfIntoChunks>>;
    try {
      chunks = await splitPdfIntoChunks(bytes, PAGES_PER_CHUNK);
    } catch (err) {
      setLoading(false);
      setUploadPct(null);
      setChunkLabel(null);
      setError("Failed to prepare PDF chunks: " + ((err as Error)?.message ?? "Unknown error"));
      return;
    }

    // Single-element result: use the regular single-upload path
    if (chunks.length === 1) {
      const base64 = bytesToBase64(chunks[0]!.bytes);
      handleSingleUpload(base64, 0);
      return;
    }

    setChunksTotal(chunks.length);
    setChunksCompleted(0);
    await uploadChunksFromIndex(chunks, 0, null);
  };

  // ── Retry a single failed chunk (without re-uploading the whole file) ──────
  const handleRetryChunk = async (): Promise<void> => {
    if (!failedChunkInfo || !pdfBytes || !adminToken) return;

    const { chunkIndex, parentJobId } = failedChunkInfo;
    setError(null);
    setFailedChunkInfo(null);
    setLoading(true);
    setUploadPct(0);
    setChunkLabel(null);
    setUploadSpeed(null);
    setUploadEta(null);
    speedSamplesRef.current = [];

    if (chunkIndex === 0 || !parentJobId) {
      // Chunk 0 failed before a parent job was created — restart everything
      void handleChunkedUpload(pdfBytes);
      return;
    }

    let chunks: Awaited<ReturnType<typeof splitPdfIntoChunks>>;
    try {
      chunks = await splitPdfIntoChunks(pdfBytes, PAGES_PER_CHUNK);
    } catch (err) {
      setLoading(false);
      setError("Failed to prepare PDF chunks: " + ((err as Error)?.message ?? "Unknown error"));
      return;
    }

    // Resume from the failed chunk index, reusing the existing parent job
    await uploadChunksFromIndex(chunks, chunkIndex, parentJobId);
  };

  // ── Legacy single-upload flow (small files) ───────────────────────────────
  const handleSingleUpload = (base64: string, attempt: number): void => {
    sendSingleChunk(
      base64,
      {},
      attempt,
      (resp) => {
        setUploadPct(null);
        setUploadSpeed(null);
        setUploadEta(null);
        setLoading(false);
        const jobId = resp.jobId;
        setJobStatus({
          jobId,
          status: "pending",
          totalPages: null,
          processedPages: 0,
          matchedParts: 0,
          imagesMatched: 0,
          errorMessage: null,
        });
        startPolling(jobId);
        setPdfBytes(null);
      },
      (errMsg) => {
        setUploadPct(null);
        setUploadSpeed(null);
        setUploadEta(null);
        setLoading(false);
        setError(errMsg);
      },
      () => {
        setUploadPct(null);
        setLoading(false);
      },
      () => {
        setUploadPct(null);
        setUploadSpeed(null);
        setUploadEta(null);
        if (attempt < MAX_AUTO_RETRIES) {
          const delaySec = Math.pow(2, attempt);
          setError(null);
          setRetryCountdown(delaySec);
          setTimeout(() => handleStart(attempt + 1), delaySec * 1000);
        } else {
          setLoading(false);
          setRetryCountdown(null);
          setError("Network error — check your connection and try again.");
          setShowRetryBtn(true);
        }
      },
    );
  };

  const handleStart = (attempt = 0) => {
    if (!pdfBytes || !vendor.trim() || !adminToken) return;
    setError(null);
    setRetryCountdown(null);
    setShowRetryBtn(false);
    setFailedChunkInfo(null);
    if (attempt === 0) setJobStatus(null);
    setLoading(true);
    setUploadPct(0);
    setChunkLabel(null);
    setUploadSpeed(null);
    setUploadEta(null);
    setChunksCompleted(0);
    setChunksTotal(0);
    speedSamplesRef.current = [];

    if (pdfBytes.length > CHUNK_SIZE_THRESHOLD) {
      void handleChunkedUpload(pdfBytes);
    } else {
      const base64 = bytesToBase64(pdfBytes);
      handleSingleUpload(base64, attempt);
    }
  };

  const handleCancel = () => {
    if (xhrRef.current) {
      xhrRef.current.abort();
    }
  };

  const handleCancelRetry = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setRetryCountdown(null);
    setLoading(false);
    setUploadPct(null);
    setUploadSpeed(null);
    setUploadEta(null);
    setError("Network error — check your connection and try again.");
    setShowRetryBtn(true);
  };

  const isDone = jobStatus?.status === "done";
  const isFailed = jobStatus?.status === "failed";
  const isCancelled = jobStatus?.status === "cancelled";
  const isRunning = jobStatus?.status === "pending" || jobStatus?.status === "processing";

  const progressPct =
    jobStatus?.totalPages && jobStatus.totalPages > 0
      ? Math.round((jobStatus.processedPages / jobStatus.totalPages) * 100)
      : null;

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[s.title, { color: colors.foreground }]}>PDF Catalog Importer</Text>
      <Text style={[s.hint, { color: colors.mutedForeground }]}>
        Upload a manufacturer's product catalog PDF. The system will use AI to
        extract part numbers, descriptions, and product images, then match them
        to your inventory.
      </Text>

      {/* Vendor input */}
      <View style={s.fieldRow}>
        <Text style={[s.label, { color: colors.mutedForeground }]}>
          Vendor <Text style={{ color: colors.destructive }}>*</Text>
        </Text>
        <KeyboardDoneInput
          style={[s.input, {
            backgroundColor: colors.muted,
            color: colors.foreground,
            borderColor: pdfBytes && !vendor.trim() ? colors.destructive : colors.border,
          }]}
          placeholder="e.g. EATON"
          placeholderTextColor={colors.mutedForeground}
          value={vendor}
          onChangeText={v => setVendor(v.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!isRunning && !loading}
        />
      </View>

      {/* File picker */}
      <Pressable
        onPress={handlePickFile}
        disabled={isRunning || loading || readingFile}
        style={[s.pickBtn, { borderColor: isRunning || loading || readingFile ? colors.border : colors.primary }]}
      >
        {readingFile ? (
          <View style={s.pickBtnInner}>
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text style={[s.pickBtnText, { color: colors.mutedForeground }]}>Reading file…</Text>
          </View>
        ) : (
          <Text style={[s.pickBtnText, { color: isRunning || loading ? colors.mutedForeground : colors.primary }]}>
            {filename ? `PDF: ${filename}` : "Choose PDF File"}
          </Text>
        )}
      </Pressable>

      {/* Error / retry countdown */}
      {retryCountdown !== null ? (
        <View style={s.errorRow}>
          <Text style={[s.error, { color: colors.destructive, flex: 1 }]}>
            Network error — retrying in {retryCountdown}…
          </Text>
          <Pressable
            onPress={handleCancelRetry}
            style={[s.retryBtn, { borderColor: colors.destructive }]}
          >
            <Text style={[s.retryBtnText, { color: colors.destructive }]}>Cancel</Text>
          </Pressable>
        </View>
      ) : error ? (
        <View style={s.errorRow}>
          <Text style={[s.error, { color: colors.destructive, flex: 1 }]}>{error}</Text>
          {failedChunkInfo && pdfBytes ? (
            <Pressable
              onPress={() => { void handleRetryChunk(); }}
              style={[s.retryBtn, { borderColor: colors.destructive }]}
            >
              <Text style={[s.retryBtnText, { color: colors.destructive }]}>
                Retry part {failedChunkInfo.chunkIndex + 1}/{failedChunkInfo.totalChunks}
              </Text>
            </Pressable>
          ) : showRetryBtn ? (
            <Pressable
              onPress={() => handleStart(0)}
              style={[s.retryBtn, { borderColor: colors.destructive }]}
            >
              <Text style={[s.retryBtnText, { color: colors.destructive }]}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Start button */}
      {!isRunning && !isDone ? (
        <>
          <Pressable
            onPress={() => handleStart()}
            disabled={!pdfBytes || !vendor.trim() || loading || readingFile}
            style={[s.startBtn, {
              backgroundColor: !pdfBytes || !vendor.trim() || loading || readingFile ? colors.muted : colors.primary,
            }]}
          >
            {loading ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[s.startBtnText, { color: !pdfBytes || !vendor.trim() || readingFile ? colors.mutedForeground : colors.primaryForeground }]}>
                Start Extraction
              </Text>
            )}
          </Pressable>
          {(!pdfBytes || !vendor.trim()) && !loading && !readingFile ? (
            <Text style={[s.fieldHint, { color: colors.mutedForeground }]}>
              {!pdfBytes && !vendor.trim()
                ? "Choose a PDF file and enter a vendor name to continue"
                : !pdfBytes
                  ? "Choose a PDF file above to continue"
                  : "Enter a vendor name above to continue"}
            </Text>
          ) : null}
        </>
      ) : null}

      {/* Upload progress — chunked mode shows step bar; single-file mode shows byte-level bar */}
      {loading && (chunkLabel !== null || uploadPct !== null) ? (
        <View style={s.progressBlock}>
          <View style={s.progressRow}>
            <Text style={[s.progressLabel, { color: colors.foreground, flex: 1 }]}>
              {chunkLabel ?? `Uploading… ${uploadPct ?? 0}%`}
            </Text>
            <Pressable onPress={handleCancel} style={[s.cancelBtn, { borderColor: colors.destructive }]}>
              <Text style={[s.cancelBtnText, { color: colors.destructive }]}>Cancel</Text>
            </Pressable>
          </View>

          {/* Chunked upload: step-based progress bar (advances per completed chunk,
              with smooth sub-chunk XHR progress interpolated within each step) */}
          {chunkLabel !== null && chunksTotal > 0 ? (
            <>
              <View style={[s.progressBar, { backgroundColor: colors.muted }]}>
                <View style={[s.progressFill, {
                  width: `${Math.min(100, Math.round(
                    ((chunksCompleted + (uploadPct ?? 0) / 100) / chunksTotal) * 100
                  ))}%`,
                  backgroundColor: colors.primary,
                }]} />
              </View>
              <Text style={[s.progressText, { color: colors.mutedForeground }]}>
                {chunksCompleted} of {chunksTotal} parts uploaded
              </Text>
            </>
          ) : null}

          {/* Single-file upload: byte-level progress bar */}
          {uploadPct !== null && chunkLabel === null ? (
            <View style={[s.progressBar, { backgroundColor: colors.muted }]}>
              <View style={[s.progressFill, { width: `${uploadPct}%`, backgroundColor: colors.primary }]} />
            </View>
          ) : null}
          {uploadSpeed !== null && uploadEta !== null && chunkLabel === null ? (
            <Text style={[s.progressText, { color: colors.mutedForeground }]}>
              {uploadSpeed >= 1
                ? `${uploadSpeed.toFixed(1)} MB/s`
                : `${(uploadSpeed * 1024).toFixed(0)} KB/s`}
              {uploadEta >= 60
                ? ` · ~${Math.ceil(uploadEta / 60)} min remaining`
                : ` · ~${Math.ceil(uploadEta)} sec remaining`}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Job progress */}
      {jobStatus && isRunning ? (
        <View style={s.progressBlock}>
          <View style={s.progressRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[s.progressLabel, { color: colors.foreground, flex: 1 }]}>
              {jobStatus.status === "pending" ? "Starting…" : "Processing pages…"}
            </Text>
            <Pressable
              onPress={handleCancelJob}
              disabled={cancellingJob}
              style={[s.cancelBtn, { borderColor: colors.destructive, opacity: cancellingJob ? 0.5 : 1 }]}
            >
              <Text style={[s.cancelBtnText, { color: colors.destructive }]}>
                {cancellingJob ? "Cancelling…" : "Cancel job"}
              </Text>
            </Pressable>
          </View>
          {progressPct !== null ? (
            <>
              <View style={[s.progressBar, { backgroundColor: colors.muted }]}>
                <View style={[s.progressFill, { width: `${progressPct}%`, backgroundColor: colors.primary }]} />
              </View>
              <Text style={[s.progressText, { color: colors.mutedForeground }]}>
                {jobStatus.processedPages} / {jobStatus.totalPages} pages — {jobStatus.matchedParts} parts matched
              </Text>
            </>
          ) : null}
        </View>
      ) : null}

      {/* Done */}
      {isDone && jobStatus ? (
        <View style={[s.doneCard, { backgroundColor: colors.success + "18" }]}>
          <Text style={[s.doneText, { color: colors.success }]}>
            Done — {jobStatus.matchedParts} part{jobStatus.matchedParts !== 1 ? "s" : ""} updated across {jobStatus.processedPages} pages{jobStatus.imagesMatched > 0 ? `, ${jobStatus.imagesMatched} with images` : ""}
          </Text>
          <Pressable
            onPress={() => router.push(`/catalog-review?jobId=${jobStatus.jobId}`)}
            style={[s.reviewBtn, { borderColor: colors.primary }]}
          >
            <Text style={[s.reviewBtnText, { color: colors.primary }]}>Review changes →</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Cancelled */}
      {isCancelled && jobStatus ? (
        <View style={[s.doneCard, { backgroundColor: colors.mutedForeground + "18" }]}>
          <Text style={[s.doneText, { color: colors.mutedForeground }]}>
            Job cancelled
            {jobStatus.processedPages > 0
              ? ` — stopped after ${jobStatus.processedPages} page${jobStatus.processedPages !== 1 ? "s" : ""}${jobStatus.matchedParts > 0 ? `, ${jobStatus.matchedParts} parts matched` : ""}`
              : ""}
          </Text>
          <Pressable
            onPress={() => { setJobStatus(null); setFilename(null); setCancellingJob(false); }}
            style={[s.reviewBtn, { borderColor: colors.mutedForeground }]}
          >
            <Text style={[s.reviewBtnText, { color: colors.mutedForeground }]}>Start new job</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Failed */}
      {isFailed && jobStatus ? (
        <View style={[s.doneCard, { backgroundColor: colors.destructive + "18" }]}>
          <Text style={[s.doneText, { color: colors.destructive }]}>
            Job failed: {jobStatus.errorMessage ?? "Unknown error"}
          </Text>
          <Pressable
            onPress={() => { setJobStatus(null); setFilename(null); }}
            style={[s.reviewBtn, { borderColor: colors.destructive }]}
          >
            <Text style={[s.reviewBtnText, { color: colors.destructive }]}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: 12, padding: 16, borderWidth: 1, marginBottom: 14, gap: 10 },
  title: { fontSize: 16, fontFamily: "Inter_700Bold" },
  hint: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 19 },
  fieldRow: { gap: 4 },
  label: { fontSize: 12, fontFamily: "Inter_500Medium" },
  input: {
    borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, fontFamily: "Inter_400Regular",
  },
  pickBtn: {
    borderWidth: 2, borderRadius: 8, paddingVertical: 12, alignItems: "center",
  },
  pickBtnInner: { flexDirection: "row", alignItems: "center", gap: 8 },
  pickBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  error: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  retryBtn: { borderWidth: 1, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 12 },
  retryBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  startBtn: { borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  startBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  fieldHint: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 17 },
  progressBlock: { gap: 8 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  progressLabel: { fontSize: 14, fontFamily: "Inter_500Medium" },
  progressBar: { height: 8, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 4 },
  progressText: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center" },
  doneCard: { borderRadius: 10, padding: 14, gap: 10 },
  doneText: { fontSize: 14, fontFamily: "Inter_600SemiBold", lineHeight: 20 },
  reviewBtn: { borderWidth: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14, alignSelf: "flex-start" },
  reviewBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  cancelBtn: { borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 12 },
  cancelBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
