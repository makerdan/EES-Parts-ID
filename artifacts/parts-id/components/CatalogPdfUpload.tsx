/**
 * CatalogPdfUpload
 *
 * Self-contained card for the admin "upload" tab. Lets an admin pick a
 * manufacturer PDF catalog, sends it to POST /api/admin/catalog-pdf, then
 * polls the job status endpoint and shows progress. When the job is done a
 * "Review changes" button links to the catalog-review screen.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import * as DocumentPicker from "expo-document-picker";
import { readPdfAsBase64, PdfTooLargeError } from "@/utils/readPdfAsBase64";
import { useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

const POLL_MS = 2500;

type JobStatus = {
  jobId: string;
  status: "pending" | "processing" | "done" | "failed";
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

export function CatalogPdfUpload({ adminToken, onSessionExpired }: Props) {
  const colors = useColors();
  const router = useRouter();

  const [vendor, setVendor] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const adminTokenRef = useRef(adminToken);
  useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);

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
        if (data.status === "done" || data.status === "failed") stopPolling();
      } catch { /* network blip — keep polling */ }
    }, POLL_MS);
  }, [stopPolling, onSessionExpired]);

  const handlePickFile = async () => {
    setError(null);
    setPdfBase64(null);
    setFilename(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0]!;
      setReadingFile(true);
      try {
        const base64 = await readPdfAsBase64(asset.uri);
        setPdfBase64(base64);
        setFilename(asset.name ?? "catalog.pdf");
      } catch (err) {
        if (err instanceof PdfTooLargeError) {
          setError(err.message);
        } else {
          setError("Could not read the PDF file. Please try again.");
        }
      } finally {
        setReadingFile(false);
      }
    } catch {
      setError("Could not read the PDF file. Please try again.");
    }
  };

  const handleStart = async () => {
    if (!pdfBase64 || !vendor.trim() || !adminToken) return;
    setError(null);
    setJobStatus(null);
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/admin/catalog-pdf`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          pdfBase64,
          vendor: vendor.trim(),
          filename: filename ?? "catalog.pdf",
        }),
      });
      if (r.status === 401) { onSessionExpired(); return; }
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Failed to start job");
        return;
      }
      const { jobId } = await r.json() as { jobId: string };
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
      setPdfBase64(null);
    } catch {
      setError("Network error — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const isDone = jobStatus?.status === "done";
  const isFailed = jobStatus?.status === "failed";
  const isRunning = jobStatus?.status === "pending" || jobStatus?.status === "processing";

  const progressPct =
    jobStatus?.totalPages && jobStatus.totalPages > 0
      ? Math.round((jobStatus.processedPages / jobStatus.totalPages) * 100)
      : null;

  return (
    <View style={[s.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[s.title, { color: colors.foreground }]}>PDF Catalog Importer</Text>
      <Text style={[s.hint, { color: colors.mutedForeground }]}>
        Upload a manufacturer's product catalog PDF. The system will extract part
        numbers and descriptions using AI and match them to your inventory.
      </Text>

      {/* Vendor input */}
      <View style={s.fieldRow}>
        <Text style={[s.label, { color: colors.mutedForeground }]}>Vendor</Text>
        <KeyboardDoneInput
          style={[s.input, { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border }]}
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

      {/* Error */}
      {error ? (
        <Text style={[s.error, { color: colors.destructive }]}>{error}</Text>
      ) : null}

      {/* Start button */}
      {!isRunning && !isDone ? (
        <Pressable
          onPress={handleStart}
          disabled={!pdfBase64 || !vendor.trim() || loading || readingFile}
          style={[s.startBtn, {
            backgroundColor: !pdfBase64 || !vendor.trim() || loading || readingFile ? colors.muted : colors.primary,
          }]}
        >
          {loading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={[s.startBtnText, { color: !pdfBase64 || !vendor.trim() || readingFile ? colors.mutedForeground : colors.primaryForeground }]}>
              Start Extraction
            </Text>
          )}
        </Pressable>
      ) : null}

      {/* Job progress */}
      {jobStatus && isRunning ? (
        <View style={s.progressBlock}>
          <View style={s.progressRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[s.progressLabel, { color: colors.foreground }]}>
              {jobStatus.status === "pending" ? "Starting…" : `Processing pages…`}
            </Text>
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
  error: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  startBtn: { borderRadius: 8, paddingVertical: 13, alignItems: "center" },
  startBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
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
});
