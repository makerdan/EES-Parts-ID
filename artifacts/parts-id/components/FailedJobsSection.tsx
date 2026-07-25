/**
 * FailedJobsSection
 *
 * Renders the "Failed Jobs" header banner and one card per failed PDF job.
 * Extracted from app/catalog-review.tsx so it can be unit-tested without
 * mounting the full screen (which depends on routing, auth, and other context).
 *
 * Props mirror the slice of state the parent already owns:
 *   failedJobs      — jobs with status "failed" and dismissed=false
 *   dismissingId    — id of the job currently being dismissed (shows spinner text)
 *   resumingId      — id of the job currently being resumed (shows spinner)
 *   resumeProgress  — live progress keyed by jobId while a resume is running
 *   onDismiss       — callback when the Dismiss button is pressed
 *   onResume        — callback when the Resume button is pressed
 *   onReviewChanges — callback when "Review changes" is pressed on a completed resume
 *   colors          — theme tokens forwarded from useColors()
 */

import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { ResumeProgress } from "@/types/catalogPdf";
import {
  buildFailedJobMetaLine,
  displayErrorMessage,
} from "@/utils/failedJobCard";

export interface FailedJob {
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
}

export interface FailedJobsSectionColors {
  card: string;
  destructive: string;
  foreground: string;
  mutedForeground: string;
  primary: string;
  muted: string;
  border: string;
}

interface Props {
  failedJobs: Array<FailedJob>;
  dismissingId: number | null;
  resumingId: number | null;
  resumeProgress: Record<number, ResumeProgress>;
  onDismiss: (id: number) => void;
  onResume: (id: number) => void;
  onReviewChanges: (id: number) => void;
  onDismissResumeError: (id: number) => void;
  colors: FailedJobsSectionColors;
}

export function FailedJobsSection({
  failedJobs,
  dismissingId,
  resumingId,
  resumeProgress,
  onDismiss,
  onResume,
  onReviewChanges,
  onDismissResumeError,
  colors,
}: Props) {
  "use no memo";
  // All jobs that have an active resumeProgress entry (any status) are shown
  // via ResumeProgressCard — including "failed" ones, which show an error card.
  const inProgressIds = new Set(Object.keys(resumeProgress).map(Number));

  // Split remaining jobs by status
  const stillFailedJobs = failedJobs.filter(
    (j) => !inProgressIds.has(j.id) && j.status !== "cancelled",
  );
  const cancelledJobs = failedJobs.filter(
    (j) => !inProgressIds.has(j.id) && j.status === "cancelled",
  );

  // Collect in-progress / done cards: jobs that have a resumeProgress entry
  // with status != "failed". These may still be in failedJobs (processing) or
  // may have been removed (done). We render them from the original failedJobs
  // list while progress is live, or solely from resumeProgress when done.
  const resumingJobs = failedJobs.filter((j) => inProgressIds.has(j.id));

  // Also synthesise "done" cards for jobs removed from failedJobs after finishing
  const doneOnlyIds = Object.keys(resumeProgress)
    .map(Number)
    .filter(
      (id) =>
        resumeProgress[id]?.status === "done" &&
        !failedJobs.find((j) => j.id === id),
    );

  const hasSomething =
    stillFailedJobs.length > 0 ||
    cancelledJobs.length > 0 ||
    resumingJobs.length > 0 ||
    doneOnlyIds.length > 0;

  if (!hasSomething) return null;

  return (
    <View style={s.section}>
      {stillFailedJobs.length > 0 && (
        <View
          style={[
            s.sectionHeader,
            {
              backgroundColor: colors.destructive + "18",
              borderColor: colors.destructive + "44",
            },
          ]}
        >
          <Text style={[s.sectionTitle, { color: colors.destructive }]}>
            {stillFailedJobs.length} Failed Job{stillFailedJobs.length !== 1 ? "s" : ""}
          </Text>
          <Text style={[s.sectionHint, { color: colors.mutedForeground }]}>
            Tap Resume to continue from where it stopped, or go to the Upload tab to start fresh.
          </Text>
        </View>
      )}

      {/* In-progress / done / re-failed resume cards */}
      {resumingJobs.map((job) => {
        // resumingJobs is filtered to ids present in resumeProgress.
        const progress = resumeProgress[job.id]!;
        return (
          <ResumeProgressCard
            key={`resume-${job.id}`}
            job={job}
            progress={progress}
            onReviewChanges={onReviewChanges}
            onDismissError={onDismissResumeError}
            onResume={onResume}
            colors={colors}
          />
        );
      })}

      {/* Done cards for jobs already removed from failedJobs */}
      {doneOnlyIds.map((id) => {
        // doneOnlyIds is derived from resumeProgress keys.
        const progress = resumeProgress[id]!;
        return (
          <ResumeProgressCard
            key={`done-${id}`}
            job={null}
            jobId={id}
            progress={progress}
            onReviewChanges={onReviewChanges}
            onDismissError={onDismissResumeError}
            onResume={onResume}
            colors={colors}
          />
        );
      })}

      {/* Still-failed cards */}
      {stillFailedJobs.map((job) => (
        <View
          key={job.id}
          style={[
            s.card,
            {
              backgroundColor: colors.card,
              borderColor: colors.destructive + "55",
            },
          ]}
        >
          <View style={s.cardTop}>
            <View style={s.cardIdent}>
              <Text style={[s.cardVendor, { color: colors.foreground }]}>
                {job.vendor}
              </Text>
              <Text
                style={[s.cardFile, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {job.filename}
              </Text>
            </View>
            <View
              style={[s.badge, { backgroundColor: colors.destructive + "18" }]}
            >
              <Text style={[s.badgeText, { color: colors.destructive }]}>
                Failed
              </Text>
            </View>
          </View>

          <View
            style={[
              s.errorBox,
              {
                backgroundColor: colors.destructive + "0e",
                borderColor: colors.destructive + "33",
              },
            ]}
          >
            <Text style={[s.errorLabel, { color: colors.destructive }]}>
              Error
            </Text>
            <Text style={[s.errorMsg, { color: colors.foreground }]}>
              {displayErrorMessage(job)}
            </Text>
          </View>

          <Text style={[s.meta, { color: colors.mutedForeground }]}>
            {buildFailedJobMetaLine(job)}
          </Text>

          <View style={s.actions}>
            <Pressable
              onPress={() => onResume(job.id)}
              disabled={resumingId === job.id || dismissingId === job.id}
              style={[s.resumeBtn, { backgroundColor: colors.primary + (resumingId === job.id ? "88" : "ff") }]}
            >
              {resumingId === job.id ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={s.resumeBtnText}>Resume</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => onDismiss(job.id)}
              disabled={dismissingId === job.id || resumingId === job.id}
              style={[s.dismissBtn, { borderColor: colors.mutedForeground + "55" }]}
            >
              <Text style={[s.dismissBtnText, { color: colors.mutedForeground }]}>
                {dismissingId === job.id ? "Dismissing…" : "Dismiss"}
              </Text>
            </Pressable>
          </View>
        </View>
      ))}

      {/* Cancelled jobs section header */}
      {cancelledJobs.length > 0 && (
        <View
          style={[
            s.sectionHeader,
            {
              backgroundColor: colors.muted,
              borderColor: colors.mutedForeground + "33",
            },
          ]}
        >
          <Text style={[s.sectionTitle, { color: colors.mutedForeground }]}>
            {cancelledJobs.length} Cancelled Job{cancelledJobs.length !== 1 ? "s" : ""}
          </Text>
          <Text style={[s.sectionHint, { color: colors.mutedForeground }]}>
            These jobs were cancelled before finishing. Dismiss them to clear the list.
          </Text>
        </View>
      )}

      {/* Cancelled job cards */}
      {cancelledJobs.map((job) => (
        <View
          key={job.id}
          style={[
            s.card,
            {
              backgroundColor: colors.card,
              borderColor: colors.mutedForeground + "33",
            },
          ]}
        >
          <View style={s.cardTop}>
            <View style={s.cardIdent}>
              <Text style={[s.cardVendor, { color: colors.foreground }]}>
                {job.vendor}
              </Text>
              <Text
                style={[s.cardFile, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {job.filename}
              </Text>
            </View>
            <View
              style={[s.badge, { backgroundColor: colors.muted }]}
            >
              <Text style={[s.badgeText, { color: colors.mutedForeground }]}>
                Cancelled
              </Text>
            </View>
          </View>

          <Text style={[s.meta, { color: colors.mutedForeground }]}>
            {buildFailedJobMetaLine(job)}
          </Text>

          <View style={[s.actions, { justifyContent: "flex-end" }]}>
            <Pressable
              onPress={() => onDismiss(job.id)}
              disabled={dismissingId === job.id}
              style={[s.dismissBtn, { borderColor: colors.mutedForeground + "55" }]}
            >
              <Text style={[s.dismissBtnText, { color: colors.mutedForeground }]}>
                {dismissingId === job.id ? "Dismissing…" : "Dismiss"}
              </Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

interface ResumeProgressCardProps {
  job: FailedJob | null;
  jobId?: number;
  progress: ResumeProgress;
  onReviewChanges: (id: number) => void;
  onDismissError: (id: number) => void;
  onResume: (id: number) => void;
  colors: FailedJobsSectionColors;
}

function ResumeProgressCard({ job, jobId, progress, onReviewChanges, onDismissError, onResume, colors }: ResumeProgressCardProps) {
  const id = job?.id ?? jobId!;
  const vendor = job?.vendor ?? "Unknown vendor";
  const filename = job?.filename ?? "catalog.pdf";

  const isDone = progress.status === "done";
  const isFailed = progress.status === "failed";
  const isUploading = progress.status === "uploading";
  const isChunked = progress.totalChunks != null && progress.totalChunks > 1;
  const pct =
    progress.totalPages && progress.totalPages > 0
      ? Math.min(100, Math.round((progress.processedPages / progress.totalPages) * 100))
      : 0;

  // Re-failed card: destructive styling with the new error message
  if (isFailed) {
    const errorMsg = progress.errorMessage ?? "The job failed again. Try resuming with the correct PDF.";
    return (
      <View
        style={[
          s.card,
          {
            backgroundColor: colors.card,
            borderColor: colors.destructive + "55",
          },
        ]}
      >
        <View style={s.cardTop}>
          <View style={s.cardIdent}>
            <Text style={[s.cardVendor, { color: colors.foreground }]}>{vendor}</Text>
            <Text style={[s.cardFile, { color: colors.mutedForeground }]} numberOfLines={1}>
              {filename}
            </Text>
          </View>
          <View style={[s.badge, { backgroundColor: colors.destructive + "18" }]}>
            <Text style={[s.badgeText, { color: colors.destructive }]}>Failed again</Text>
          </View>
        </View>

        <View
          style={[
            s.errorBox,
            {
              backgroundColor: colors.destructive + "0e",
              borderColor: colors.destructive + "33",
            },
          ]}
        >
          <Text style={[s.errorLabel, { color: colors.destructive }]}>Error</Text>
          <Text style={[s.errorMsg, { color: colors.foreground }]}>{errorMsg}</Text>
        </View>

        <View style={[s.actions, { justifyContent: "flex-end" }]}>
          <Pressable
            onPress={() => { onDismissError(id); onResume(id); }}
            style={[s.resumeBtn, { backgroundColor: colors.primary + "ff" }]}
          >
            <Text style={s.resumeBtnText}>Resume</Text>
          </Pressable>
          <Pressable
            onPress={() => onDismissError(id)}
            style={[s.dismissBtn, { borderColor: colors.mutedForeground + "55" }]}
          >
            <Text style={[s.dismissBtnText, { color: colors.mutedForeground }]}>Dismiss</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        s.card,
        {
          backgroundColor: colors.card,
          borderColor: isDone ? colors.primary + "55" : colors.primary + "33",
        },
      ]}
    >
      <View style={s.cardTop}>
        <View style={s.cardIdent}>
          <Text style={[s.cardVendor, { color: colors.foreground }]}>{vendor}</Text>
          <Text style={[s.cardFile, { color: colors.mutedForeground }]} numberOfLines={1}>
            {filename}
          </Text>
        </View>
        <View style={[s.badge, { backgroundColor: isDone ? colors.primary + "22" : colors.primary + "18" }]}>
          {!isDone && <ActivityIndicator size="small" color={colors.primary} style={s.badgeSpinner} />}
          <Text style={[s.badgeText, { color: colors.primary }]}>
            {isDone
              ? "Done"
              : isUploading && isChunked
              ? `Uploading ${progress.chunkIndex} of ${progress.totalChunks}…`
              : isUploading
              ? "Uploading…"
              : "Processing…"}
          </Text>
        </View>
      </View>

      {!isDone && (
        <>
          <View style={[s.progressBar, { backgroundColor: colors.muted }]}>
            <View
              style={[
                s.progressFill,
                {
                  width: isUploading && isChunked && progress.totalChunks
                    ? `${Math.max(4, Math.round(((progress.chunkIndex ?? 1) / progress.totalChunks) * 100))}%`
                    : pct > 0
                    ? `${pct}%`
                    : "4%",
                  backgroundColor: colors.primary,
                },
              ]}
            />
          </View>
          <Text style={[s.progressText, { color: colors.mutedForeground }]}>
            {isUploading && isChunked
              ? `Uploading part ${progress.chunkIndex} of ${progress.totalChunks}…`
              : isUploading && !isChunked
              ? "Uploading…"
              : progress.totalPages == null
              ? "Processing pages…"
              : `Processing pages… ${progress.processedPages} / ${progress.totalPages} — ${progress.matchedParts} parts matched`}
          </Text>
        </>
      )}

      {isDone && (
        <>
          <Text style={[s.progressText, { color: colors.mutedForeground }]}>
            Done — {progress.matchedParts} part{progress.matchedParts !== 1 ? "s" : ""} updated across {progress.processedPages} pages
          </Text>
          <Pressable
            onPress={() => onReviewChanges(id)}
            style={[s.reviewBtn, { borderColor: colors.primary + "88" }]}
          >
            <Text style={[s.reviewBtnText, { color: colors.primary }]}>Review changes →</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  section: { paddingBottom: 4 },
  sectionHeader: {
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 4,
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    gap: 4,
  },
  sectionTitle: { fontSize: 15, fontFamily: "Inter_700Bold" },
  sectionHint: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  card: {
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  cardIdent: { flex: 1, gap: 2 },
  cardVendor: { fontSize: 15, fontFamily: "Inter_700Bold" },
  cardFile: { fontSize: 12, fontFamily: "Inter_400Regular" },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    gap: 4,
  },
  badgeSpinner: { width: 12, height: 12 },
  badgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  errorBox: { borderRadius: 8, borderWidth: 1, padding: 10, gap: 4 },
  errorLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  errorMsg: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  meta: { fontSize: 12, fontFamily: "Inter_400Regular" },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },
  resumeBtn: {
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 16,
    minWidth: 80,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 34,
  },
  resumeBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "#fff" },
  dismissBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 16,
  },
  dismissBtnText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  progressBar: { height: 8, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 4 },
  progressText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  reviewBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: "flex-start",
    alignItems: "center",
  },
  reviewBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
