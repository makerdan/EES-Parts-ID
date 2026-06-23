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
 *
 * Background behaviour: uploads use expo-file-system's FileSystem.createUploadTask
 * with FileSystemSessionType.BACKGROUND (NSURLSession background configuration on
 * iOS, OkHttp on Android). Chunks continue transferring even when the app is
 * backgrounded — no AppState guard or manual resume is needed. Each chunk's JSON
 * body is written to a temp file in cacheDirectory, uploaded via BINARY_CONTENT,
 * then deleted after the task resolves.
 */

import "buffer";

import { Buffer } from "buffer";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { activateKeepAwake, deactivateKeepAwake } from "expo-keep-awake";
import { useNavigation, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import { useColors } from "@/hooks/useColors";
import { shouldUseFallback } from "@/utils/aiFallbackHeaders";
import {
  clearPdfPickLogs,
  formatPdfPickLogs,
  getPdfPickLogs,
  logPdfPick,
  subscribePdfPickLogs,
} from "@/utils/pdfPickLogger";
import { readPdfAsBytes, toFriendlyReadError } from "@/utils/readPdfAsBase64";
import { getOrSplitChunks, PAGES_PER_CHUNK, splitPdfIntoChunks } from "@/utils/splitPdfIntoChunks";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

const POLL_MS = 2500;

/** Files above this threshold are split into chunks before uploading. */
const CHUNK_SIZE_THRESHOLD = 20 * 1024 * 1024; // 20 MB

/** How many times an admin can retry a single server-side chunk before the button is disabled. */
const MAX_SERVER_CHUNK_RETRIES = 3;

/** Silent automatic retries on transient network errors before surfacing to the user. */
const MAX_SILENT_RETRIES = 2;
/** Back-off delay between silent retries (ms). */
const SILENT_RETRY_DELAY_MS = 2000;

type JobStatus = {
  jobId: string;
  status: "pending" | "processing" | "done" | "failed" | "cancelled";
  totalPages: number | null;
  processedPages: number;
  matchedParts: number;
  imagesMatched: number;
  unmatchedParts?: Array<{ catalogNumber: string; description: string }>;
  errorMessage: string | null;
  failedChunks?: Array<{ chunkJobId: string; chunkIndex: number }>;
};

type FailedChunkInfo = {
  chunkIndex: number;
  totalChunks: number;
  parentJobId: string | null;
};

/**
 * Module-level cache that survives component unmount/remount within the same
 * app session. Written when the OS backgrounds the app mid-chunk-upload and
 * the in-flight XHR is aborted into the "paused" state. Read on mount so the
 * "Paused" card reappears if the user navigates away and back while paused.
 * Cleared when the upload starts fresh, completes, is cancelled, or resumes.
 */
type PausedUploadCache = {
  failedChunkInfo: FailedChunkInfo;
  chunks: Awaited<ReturnType<typeof splitPdfIntoChunks>> | null;
  /** Raw PDF bytes — needed so Resume can restart from chunk 0 if required. */
  pdfBytes: Uint8Array | null;
  /** Vendor string — required by the API for the first chunk's parent-job creation. */
  vendor: string;
  /** Display name of the picked file — restored so the filename label reappears. */
  filename: string | null;
};
let _pausedUploadCache: PausedUploadCache | null = null;
let _mountCount = 0;

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
  const [chunkLabel, setChunkLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRetryBtn, setShowRetryBtn] = useState(false);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);

  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const [chunksCompleted, setChunksCompleted] = useState(0);
  const [chunksTotal, setChunksTotal] = useState(0);
  const [failedChunkInfo, setFailedChunkInfo] = useState<FailedChunkInfo | null>(null);
  /** Byte-level upload progress (0–100) for the current chunk or single-file upload. Null = not yet started. */
  const [uploadBytePct, setUploadBytePct] = useState<number | null>(null);

  useEffect(() => {
    if (retryCountdown === null || retryCountdown <= 0) return;
    const timer = setTimeout(() => {
      setRetryCountdown(prev => (prev !== null && prev > 1 ? prev - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [retryCountdown]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds the active background upload task so Cancel can call cancelAsync().
  const uploadTaskRef = useRef<FileSystem.UploadTask | null>(null);
  // Stores the split chunks so server-side failures can be retried without re-picking the file.
  const chunksRef = useRef<Awaited<ReturnType<typeof splitPdfIntoChunks>> | null>(null);
  const [hasStoredChunks, setHasStoredChunks] = useState(false);
  const adminTokenRef = useRef(adminToken);
  useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);
  // Set to true when retrying with OpenAI fallback after poe_chain_exhausted.
  const withFallbackRef = useRef(false);
  // Prevents showing the poe_chain_exhausted Alert more than once per job.
  const poeExhaustedAlertShownRef = useRef(false);
  // Stable ref to handleStart so the poe_chain_exhausted useEffect can call it
  // without capturing a stale closure.
  const handleStartRef = useRef<(attempt?: number) => void>(() => {});
  const [, setLogVersion] = useState(0);

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

  // Tracks how many times each chunk (by index) has been retried via handleRetryServerChunk.
  const chunkRetryCountsRef = useRef<Map<number, number>>(new Map());

  const [cancellingJob, setCancellingJob] = useState(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  useEffect(() => {
    const mountId = ++_mountCount;
    logPdfPick(`LIFECYCLE: component mounted (instance #${mountId})`, {
      platform: Platform.OS,
      adminToken: adminToken ? "set" : "null",
    });
    return () => {
      logPdfPick(`LIFECYCLE: component unmounted (instance #${mountId})`);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => subscribePdfPickLogs(() => setLogVersion(v => v + 1)), []);

  useEffect(() => {
    return () => {
      if (uploadTaskRef.current) {
        void uploadTaskRef.current.cancelAsync();
        uploadTaskRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  // Release stored chunk bytes and pdf bytes when the job reaches a terminal
  // success/cancel state (failure keeps them so retry remains available).
  useEffect(() => {
    if (jobStatus?.status === "done" || jobStatus?.status === "cancelled") {
      chunksRef.current = null;
      setHasStoredChunks(false);
      setPdfBytes(null);
      withFallbackRef.current = false;
      poeExhaustedAlertShownRef.current = false;
    }
  }, [jobStatus?.status]);

  // Detect poe_chain_exhausted from a job failure and offer the OpenAI fallback.
  useEffect(() => {
    if (
      jobStatus?.status === "failed" &&
      jobStatus.errorMessage === "poe_chain_exhausted" &&
      !poeExhaustedAlertShownRef.current
    ) {
      poeExhaustedAlertShownRef.current = true;
      Alert.alert(
        "AI Unavailable",
        "All AI bots are currently unavailable. Retry catalog extraction using OpenAI instead?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Use OpenAI",
            onPress: () => {
              setJobStatus(null);
              withFallbackRef.current = true;
              poeExhaustedAlertShownRef.current = false;
              handleStartRef.current(0);
            },
          },
        ],
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStatus?.status, jobStatus?.errorMessage]);

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
    logPdfPick("handlePickFile: called", {
      platform: Platform.OS,
      adminToken: adminToken ? "set" : "null",
      currentFilename: filename ?? "none",
      currentJobStatus: jobStatus?.status ?? "none",
    });
    setError(null);
    setReadingFile(true);
    logPdfPick("handlePickFile: setReadingFile(true)");
    try {
      const pickerOptions = { type: "application/pdf", copyToCacheDirectory: true };
      logPdfPick("handlePickFile: calling DocumentPicker.getDocumentAsync", pickerOptions);
      const result = await DocumentPicker.getDocumentAsync(pickerOptions);
      logPdfPick("handlePickFile: DocumentPicker resolved", {
        canceled: result.canceled,
        assetCount: result.assets?.length ?? 0,
      });
      if (result.canceled || !result.assets?.[0]) {
        logPdfPick("handlePickFile: canceled or no assets → returning early");
        setReadingFile(false);
        return;
      }
      const asset = result.assets[0]!;
      const webFile = (asset as { file?: File }).file;
      logPdfPick("handlePickFile: asset received", {
        uriScheme: asset.uri?.split(":")[0],
        uriPrefix: asset.uri?.substring(0, 80),
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        hasFile: webFile !== undefined,
        fileConstructor: webFile?.constructor?.name,
        isFileInstance: webFile instanceof File,
        isBlobInstance: webFile instanceof Blob,
      });
      try {
        logPdfPick("handlePickFile: calling readPdfAsBytes");
        const bytes = await readPdfAsBytes(asset.uri, webFile, logPdfPick);
        logPdfPick("handlePickFile: readPdfAsBytes resolved", { byteLength: bytes.length });
        setPdfBytes(bytes);
        logPdfPick("handlePickFile: setPdfBytes called", { byteLength: bytes.length });
        setFilename(asset.name ?? "catalog.pdf");
        logPdfPick("handlePickFile: setFilename called", { filename: asset.name ?? "catalog.pdf" });
        chunksRef.current = null;
        setHasStoredChunks(false);
        chunkRetryCountsRef.current = new Map();
        logPdfPick("handlePickFile: ✅ SUCCESS — file ready for extraction");
      } catch (err) {
        logPdfPick("handlePickFile: ❌ inner catch (readPdfAsBytes threw)", {
          errName: (err as Error)?.name,
          errMsg: (err as Error)?.message,
        });
        const message = toFriendlyReadError(err);
        setError(message);
        Alert.alert("Could not read PDF", message);
      } finally {
        logPdfPick("handlePickFile: finally — setReadingFile(false)");
        setReadingFile(false);
      }
    } catch (err) {
      logPdfPick("handlePickFile: ❌ outer catch (DocumentPicker threw)", {
        errName: (err as Error)?.name,
        errMsg: (err as Error)?.message,
      });
      setReadingFile(false);
      setError(toFriendlyReadError(err));
    }
  };

  const MAX_AUTO_RETRIES = 2;

  // ── Background-capable chunk upload ───────────────────────────────────────
  // Uses FileSystem.createUploadTask with FileSystemSessionType.BACKGROUND so
  // the native URLSession (iOS) / OkHttp (Android) layer can complete the
  // in-flight request even while JS is suspended in the background.
  // The JSON body is written to a temp file and sent as binary content with
  // Content-Type: application/json; the temp file is deleted on completion.
  const sendChunkViaBackground = async (
    base64: string,
    extraFields: Record<string, unknown>,
    onSuccess: (resp: { jobId: string; chunkJobId?: string }) => void,
    onFailure: (msg: string) => void,
    onAbort: () => void,
    onNetwork: () => void,
    onProgress?: (pct: number) => void,
  ): Promise<void> => {
    const token = adminTokenRef.current!;
    const body = JSON.stringify({
      pdfBase64: base64,
      vendor: vendor.trim(),
      filename: filename ?? "catalog.pdf",
      ...extraFields,
    });
    const tempUri = `${FileSystem.cacheDirectory}upload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;

    try {
      await FileSystem.writeAsStringAsync(tempUri, body, {
        encoding: FileSystem.EncodingType.UTF8,
      });
    } catch {
      onNetwork();
      return;
    }

    try {
      const task = FileSystem.createUploadTask(
        `${API_BASE}/admin/catalog-pdf`,
        tempUri,
        {
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          httpMethod: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            ...(withFallbackRef.current ? { "x-use-openai-fallback": "true" } : {}),
          },
          sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
        },
        onProgress
          ? (data) => {
              if (data.totalBytesExpectedToSend > 0) {
                onProgress(Math.round((data.totalBytesSent / data.totalBytesExpectedToSend) * 100));
              }
            }
          : undefined,
      );
      uploadTaskRef.current = task;
      const result = await task.uploadAsync();
      uploadTaskRef.current = null;

      if (result === null || result === undefined) {
        onAbort();
        return;
      }
      if (result.status === 401) { onSessionExpired(); onFailure("__session_expired__"); return; }
      if (result.status < 200 || result.status >= 300) {
        let errMsg = "Failed to start job";
        try { errMsg = (JSON.parse(result.body) as { error?: string }).error ?? errMsg; } catch { /* ignore */ }
        onFailure(errMsg);
        return;
      }
      onSuccess(JSON.parse(result.body) as { jobId: string; chunkJobId?: string });
    } catch {
      uploadTaskRef.current = null;
      onNetwork();
    } finally {
      try { await FileSystem.deleteAsync(tempUri, { idempotent: true }); } catch { /* ignore */ }
    }
  };

  // ── Chunked upload inner loop ──────────────────────────────────────────────
  // Uploads chunks[startIndex..end] sequentially using the background-capable
  // upload API. Each chunk's base64 is encoded lazily (one at a time) inside
  // the loop to avoid holding all base64 strings in the Hermes heap at once.
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
      // Encode this chunk's bytes immediately before use, then let it be
      // garbage-collected once the upload body has been sent.
      const base64 = bytesToBase64(chunk.bytes);
      setChunkLabel(`Part ${i + 1} of ${chunks.length}`);

      // ── Silent transient retry loop ────────────────────────────────────────
      // Up to MAX_SILENT_RETRIES automatic retries on network errors before the
      // failure is surfaced to the user. Aborts and server errors are not retried.
      let result: { jobId: string; chunkJobId?: string } | null = null;
      let lastErr: Error | null = null;

      for (let attempt = 0; attempt <= MAX_SILENT_RETRIES; attempt++) {
        if (attempt > 0) {
          await new Promise<void>((res) => setTimeout(res, SILENT_RETRY_DELAY_MS));
        }
        try {
          result = await new Promise<{ jobId: string; chunkJobId?: string }>((resolve, reject) => {
            void sendChunkViaBackground(
              base64,
              { chunkIndex: i, chunkCount: chunks.length, pageOffset: chunk.pageOffset, ...(parentJobId ? { parentJobId } : {}) },
              resolve, (msg) => reject(new Error(msg)), () => reject(new Error("__abort__")), () => reject(new Error("__network__")),
              (pct) => setUploadBytePct(pct),
            );
          });
          lastErr = null;
          break;
        } catch (err) {
          const msg = (err as Error).message;
          if (msg === "__abort__") {
            lastErr = err as Error;
            break;
          }
          if (msg === "__network__" && attempt < MAX_SILENT_RETRIES) {
            lastErr = err as Error;
            continue;
          }
          lastErr = err as Error;
          break;
        }
      }

      if (lastErr !== null) {
        const msg = lastErr.message;
        if (msg === "__abort__") {
          aborted = true;
          // Manual cancel — full reset.
          setLoading(false);
          setChunkLabel(null);
          setChunksCompleted(0);
          setChunksTotal(0);
          setUploadBytePct(null);
          setFailedChunkInfo(null);
          return;
        }
        if (msg === "__session_expired__") {
          // Auth expired — full reset (onSessionExpired was already called above).
          setLoading(false);
          setChunkLabel(null);
          setChunksCompleted(0);
          setChunksTotal(0);
          setUploadBytePct(null);
          setFailedChunkInfo(null);
          return;
        }
        // Network or server error — surface targeted chunk retry.
        // Intentionally preserve chunksCompleted and chunksTotal so the UI
        // continues to show "Part N of M failed" rather than blanking out.
        setLoading(false);
        setChunkLabel(null);
        setUploadBytePct(null);
        setFailedChunkInfo({
          chunkIndex: i,
          totalChunks: chunks.length,
          parentJobId: i === 0 ? null : parentJobId,
        });
        setError(msg === "__network__" ? "Network error — check your connection and try again." : msg);
        return;
      }

      if (i === 0) { parentJobId = result!.jobId; }
      setUploadBytePct(null);
      setChunksCompleted(i + 1);
    }

    if (aborted || !parentJobId) return;

    // All chunks uploaded — start polling parent job
    setChunkLabel(null);
    setChunksCompleted(0);
    setChunksTotal(0);
    setUploadBytePct(null);
    setLoading(false);
    // pdfBytes intentionally kept so the "Use OpenAI" fallback can re-upload
    // if the server-side job fails with poe_chain_exhausted.
    setFailedChunkInfo(null);

    setJobStatus({ jobId: parentJobId, status: "pending", totalPages: null, processedPages: 0, matchedParts: 0, imagesMatched: 0, errorMessage: null });
    startPolling(parentJobId);
  };

  // ── Chunked upload flow ────────────────────────────────────────────────────
  const handleChunkedUpload = async (bytes: Uint8Array): Promise<void> => {
    let chunks: Awaited<ReturnType<typeof splitPdfIntoChunks>>;
    try {
      chunks = await splitPdfIntoChunks(bytes, PAGES_PER_CHUNK);
    } catch (err) {
      setLoading(false);
      setChunkLabel(null);
      setError("Failed to prepare PDF chunks: " + ((err as Error)?.message ?? "Unknown error"));
      return;
    }

    // Single-element result: delegate to the regular single-upload path.
    // keep-awake for that path is handled by the useEffect on `loading`.
    if (chunks.length === 1) {
      const base64 = bytesToBase64(chunks[0]!.bytes);
      handleSingleUpload(base64, 0);
      return;
    }

    // Multi-chunk path: activate keep-awake for the full upload lifetime.
    // deactivateKeepAwake is called in the finally block so it fires on
    // completion, abort, network error, and unexpected exceptions alike.
    activateKeepAwake("catalog-upload");
    try {
      // Persist the chunks so server-side processing failures can be retried
      // without the admin re-picking the file (pdfBytes is cleared after upload).
      chunksRef.current = chunks;
      setHasStoredChunks(true);

      setChunksTotal(chunks.length);
      setChunksCompleted(0);

      await uploadChunksFromIndex(chunks, 0, null);
    } finally {
      deactivateKeepAwake("catalog-upload");
    }
  };

  // ── Retry a single failed chunk (without re-uploading the whole file) ──────
  const handleRetryChunk = async (): Promise<void> => {
    if (!failedChunkInfo || !pdfBytes || !adminToken) return;

    const { chunkIndex, parentJobId } = failedChunkInfo;
    setError(null);
    setFailedChunkInfo(null);
    setLoading(true);
    setChunkLabel(null);

    if (chunkIndex === 0 || !parentJobId) {
      // Chunk 0 failed before a parent job was created — restart everything
      void handleChunkedUpload(pdfBytes);
      return;
    }

    // Reuse already-split chunks from the initial upload rather than
    // re-splitting the raw bytes (which discards the cached work).
    let chunks: Awaited<ReturnType<typeof splitPdfIntoChunks>>;
    try {
      chunks = await getOrSplitChunks(chunksRef.current, pdfBytes, PAGES_PER_CHUNK);
    } catch (err) {
      setLoading(false);
      setError("Failed to prepare PDF chunks: " + ((err as Error)?.message ?? "Unknown error"));
      return;
    }

    setChunksTotal(chunks.length);
    setChunksCompleted(chunkIndex);

    await uploadChunksFromIndex(chunks, chunkIndex, parentJobId);
  };

  // ── Retry a specific chunk that failed during server-side AI processing ────
  // Called from the polling-detected failure UI. pdfBytes may already be null,
  // so this uses chunksRef (persisted when the chunked upload started).
  const handleRetryServerChunk = async (chunkIndex: number): Promise<void> => {
    const chunks = chunksRef.current;
    const parentJobId = jobStatus?.jobId ?? null;
    if (!chunks || !adminToken || !parentJobId) return;

    const chunk = chunks[chunkIndex];
    if (!chunk) return;

    // Enforce the retry cap — increment first, then check.
    const prevCount = chunkRetryCountsRef.current.get(chunkIndex) ?? 0;
    const newCount = prevCount + 1;
    chunkRetryCountsRef.current.set(chunkIndex, newCount);
    if (newCount > MAX_SERVER_CHUNK_RETRIES) return;

    setError(null);
    setLoading(true);
    setChunkLabel(`Uploading part ${chunkIndex + 1} of ${chunks.length}…`);

    // If this chunk was killed by a Poe outage, upgrade all subsequent retries
    // to use the OpenAI fallback.
    if (shouldUseFallback(jobStatus?.errorMessage)) {
      withFallbackRef.current = true;
    }

    try {
      const base64 = bytesToBase64(chunk.bytes);
      await new Promise<void>((resolve, reject) => {
        void sendChunkViaBackground(
          base64,
          { chunkIndex, chunkCount: chunks.length, pageOffset: chunk.pageOffset, parentJobId },
          () => resolve(),
          (msg) => reject(new Error(msg)),
          () => reject(new Error("__abort__")),
          () => reject(new Error("__network__")),
        );
      });

      setLoading(false);
      setChunkLabel(null);
      // Reset the job status optimistically so polling reflects resumed work
      setJobStatus(prev =>
        prev ? { ...prev, status: "processing", errorMessage: null, failedChunks: undefined } : prev,
      );
      startPolling(parentJobId);
    } catch (err) {
      const msg = (err as Error).message;
      setLoading(false);
      setChunkLabel(null);
      if (msg !== "__abort__") {
        setError(
          msg === "__network__"
            ? "Network error — check your connection and try again."
            : msg,
        );
      }
    }
  };

  // ── Single-upload flow (small files) ─────────────────────────────────────
  const handleSingleUpload = (base64: string, attempt: number): void => {
    void sendChunkViaBackground(
      base64,
      {},
      (resp) => {
        setLoading(false);
        setUploadBytePct(null);
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
        // pdfBytes intentionally kept so the "Use OpenAI" fallback can re-upload
        // if the server-side job fails with poe_chain_exhausted.
      },
      (errMsg) => {
        setLoading(false);
        setUploadBytePct(null);
        // __session_expired__ is a sentinel — auth redirect was already handled
        // by the onSessionExpired prop inside sendChunkViaBackground; no UI error.
        if (errMsg !== "__session_expired__") setError(errMsg);
      },
      () => {
        setLoading(false);
        setUploadBytePct(null);
        setError("Upload was interrupted. Please try again.");
      },
      () => {
        if (attempt < MAX_AUTO_RETRIES) {
          const delaySec = Math.pow(2, attempt);
          setError(null);
          setUploadBytePct(null);
          setRetryCountdown(delaySec);
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            handleStart(attempt + 1);
          }, delaySec * 1000);
        } else {
          setLoading(false);
          setUploadBytePct(null);
          setRetryCountdown(null);
          setError("Network error — check your connection and try again.");
          setShowRetryBtn(true);
        }
      },
      (pct) => setUploadBytePct(pct),
    );
  };

  const handleStart = (attempt = 0) => {
    if (!pdfBytes || !vendor.trim() || !adminToken) return;
    if (pdfBytes.length === 0) {
      setError("The selected PDF appears to be empty. Please choose a different file.");
      return;
    }
    _pausedUploadCache = null;
    setError(null);
    setRetryCountdown(null);
    setShowRetryBtn(false);
    setFailedChunkInfo(null);
    if (attempt === 0) {
      setJobStatus(null);
      chunksRef.current = null;
      setHasStoredChunks(false);
      chunkRetryCountsRef.current = new Map();
      poeExhaustedAlertShownRef.current = false;
      // withFallbackRef is managed externally: set to true by the "Use OpenAI"
      // alert before calling handleStart(0), reset to false by the done/cancelled
      // useEffect. Do not reset here so the fallback flag survives the re-entry.
    }
    setLoading(true);
    setChunkLabel(null);
    setChunksCompleted(0);
    setChunksTotal(0);
    setUploadBytePct(null);

    if (pdfBytes.length > CHUNK_SIZE_THRESHOLD) {
      void handleChunkedUpload(pdfBytes);
    } else {
      const base64 = bytesToBase64(pdfBytes);
      handleSingleUpload(base64, attempt);
    }
  };

  // Keep handleStartRef in sync so the poe_chain_exhausted Alert can call the
  // latest closure without a stale capture.
  handleStartRef.current = handleStart;

  const handleCancel = () => {
    if (uploadTaskRef.current) {
      void uploadTaskRef.current.cancelAsync();
      uploadTaskRef.current = null;
    }
  };

  const handleCancelRetry = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setRetryCountdown(null);
    setLoading(false);
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

      {/* Upload progress — chunked mode shows step bar; single-file shows byte progress */}
      {loading && !isRunning ? (
        <View style={s.progressBlock}>
          <View style={s.progressRow}>
            <Text style={[s.progressLabel, { color: colors.foreground, flex: 1 }]}>
              {chunkLabel !== null ? `Uploading… ${chunkLabel}` : "Uploading…"}
            </Text>
            <Pressable onPress={handleCancel} style={[s.cancelBtn, { borderColor: colors.destructive }]}>
              <Text style={[s.cancelBtnText, { color: colors.destructive }]}>Cancel</Text>
            </Pressable>
          </View>

          {chunkLabel !== null && chunksTotal > 0 ? (
            // Chunked upload: combined bar — advances per completed chunk and also
            // updates within the current chunk as bytes are sent.
            <>
              <View style={[s.progressBar, { backgroundColor: colors.muted }]}>
                <View style={[s.progressFill, {
                  width: `${Math.min(100, Math.round(((chunksCompleted + (uploadBytePct ?? 0) / 100) / chunksTotal) * 100))}%`,
                  backgroundColor: colors.primary,
                }]} />
              </View>
              <Text style={[s.progressText, { color: colors.mutedForeground }]}>
                {chunksCompleted} of {chunksTotal} parts uploaded
                {uploadBytePct !== null && uploadBytePct > 0 && chunksCompleted < chunksTotal
                  ? ` — part ${chunksCompleted + 1}: ${uploadBytePct}%`
                  : ""}
              </Text>
            </>
          ) : uploadBytePct !== null ? (
            // Single-file upload: real byte-level progress bar
            <>
              <View style={[s.progressBar, { backgroundColor: colors.muted }]}>
                <View style={[s.progressFill, {
                  width: `${uploadBytePct}%`,
                  backgroundColor: colors.primary,
                }]} />
              </View>
              <Text style={[s.progressText, { color: colors.mutedForeground }]}>
                {uploadBytePct}% uploaded
              </Text>
            </>
          ) : (
            // Fallback spinner before first progress event arrives
            <ActivityIndicator size="small" color={colors.primary} />
          )}
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
          {jobStatus.matchedParts === 0 &&
          (!jobStatus.unmatchedParts || jobStatus.unmatchedParts.length === 0) &&
          jobStatus.processedPages > 0 ? (
            <Text style={[s.unmatchedNote, { color: colors.warning }]}>
              No parts were identified — the AI may be temporarily unavailable. Try again shortly.
            </Text>
          ) : null}
          {jobStatus.unmatchedParts && jobStatus.unmatchedParts.length > 0 ? (
            <Text style={[s.unmatchedNote, { color: colors.warning }]}>
              {jobStatus.unmatchedParts.length} unrecognized part{jobStatus.unmatchedParts.length !== 1 ? "s" : ""} found — tap Review to see them
            </Text>
          ) : null}
          <Pressable
            onPress={() => router.push(`/catalog-review?jobId=${jobStatus.jobId}`)}
            style={[s.reviewBtn, { borderColor: colors.primary }]}
          >
            <Text style={[s.reviewBtnText, { color: colors.primary }]}>Review changes →</Text>
          </Pressable>
          <Pressable
            onPress={() => { setJobStatus(null); setFilename(null); setPdfBytes(null); }}
            style={[s.reviewBtn, { borderColor: colors.mutedForeground }]}
          >
            <Text style={[s.reviewBtnText, { color: colors.mutedForeground }]}>Start new extraction</Text>
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
            {jobStatus.errorMessage === "poe_chain_exhausted"
              ? "All AI bots are currently unavailable"
              : `Job failed: ${jobStatus.errorMessage ?? "Unknown error"}`}
          </Text>
          {hasStoredChunks && jobStatus.failedChunks && jobStatus.failedChunks.length > 0 ? (
            jobStatus.failedChunks.map((fc) => {
              const retryCount = chunkRetryCountsRef.current.get(fc.chunkIndex) ?? 0;
              const exhausted = retryCount >= MAX_SERVER_CHUNK_RETRIES;
              const totalChunks = chunksRef.current?.length;
              return (
                <View key={fc.chunkJobId} style={{ gap: 6 }}>
                  <Pressable
                    onPress={() => { if (!exhausted) { void handleRetryServerChunk(fc.chunkIndex); } }}
                    disabled={exhausted}
                    style={[s.reviewBtn, {
                      borderColor: exhausted ? colors.mutedForeground : colors.primary,
                      opacity: exhausted ? 0.5 : 1,
                    }]}
                  >
                    <Text style={[s.reviewBtnText, { color: exhausted ? colors.mutedForeground : colors.primary }]}>
                      Retry failed part {fc.chunkIndex + 1}{totalChunks ? `/${totalChunks}` : ""}
                      {retryCount > 0 && !exhausted ? ` (attempt ${retryCount + 1}/${MAX_SERVER_CHUNK_RETRIES})` : ""}
                    </Text>
                  </Pressable>
                  {exhausted ? (
                    <Text style={[s.hint, { color: colors.mutedForeground }]}>
                      Part {fc.chunkIndex + 1} has failed {MAX_SERVER_CHUNK_RETRIES} times — consider cancelling and re-uploading a smaller file.
                    </Text>
                  ) : null}
                </View>
              );
            })
          ) : (
            <Pressable
              onPress={() => { setJobStatus(null); setFilename(null); chunksRef.current = null; setHasStoredChunks(false); }}
              style={[s.reviewBtn, { borderColor: colors.destructive }]}
            >
              <Text style={[s.reviewBtnText, { color: colors.destructive }]}>Try again</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {/* ── PDF Pick Diagnostic Log ─────────────────────────────────── */}
      {getPdfPickLogs().length > 0 ? (
        <View style={[s.logPanel, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <View style={s.logPanelHeader}>
            <Text style={[s.logPanelTitle, { color: colors.foreground }]}>
              📋 Diag Log · {getPdfPickLogs().length} entries
            </Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Pressable
                onPress={() => {
                  const text = formatPdfPickLogs();
                  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                    void navigator.clipboard.writeText(text);
                  }
                  Alert.alert("Copied", `${getPdfPickLogs().length} entries copied to clipboard.`);
                }}
                style={[s.logPanelBtn, { borderColor: colors.border }]}
              >
                <Text style={[s.logPanelBtnText, { color: colors.foreground }]}>Copy</Text>
              </Pressable>
              <Pressable
                onPress={() => clearPdfPickLogs()}
                style={[s.logPanelBtn, { borderColor: colors.destructive }]}
              >
                <Text style={[s.logPanelBtnText, { color: colors.destructive }]}>Clear</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled>
            {getPdfPickLogs().map(entry => (
              <View key={entry.seq} style={s.logEntry}>
                <Text style={[s.logEntryTime, { color: colors.primary }]}>
                  {`+${entry.relMs}ms`.padStart(8)}
                </Text>
                <Text
                  style={[s.logEntryMsg, { color: colors.mutedForeground }]}
                  selectable
                >
                  {entry.msg}
                  {entry.data !== undefined ? `\n    ${JSON.stringify(entry.data)}` : ""}
                </Text>
              </View>
            ))}
          </ScrollView>
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
  unmatchedNote: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  reviewBtn: { borderWidth: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14, alignSelf: "flex-start" },
  reviewBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  cancelBtn: { borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 12 },
  cancelBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },

  // ── Diagnostic log panel ────────────────────────────────────────────────
  logPanel: {
    borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 4, gap: 4,
  },
  logPanelHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4,
  },
  logPanelTitle: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  logPanelBtn: {
    borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2,
  },
  logPanelBtnText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  logEntry: { flexDirection: "row", gap: 4, flexWrap: "wrap", paddingVertical: 1 },
  logEntryTime: { fontSize: 10, fontFamily: "Inter_400Regular", opacity: 0.7, minWidth: 60 },
  logEntryMsg: { fontSize: 10, fontFamily: "Inter_400Regular", flex: 1, flexWrap: "wrap" },
});
