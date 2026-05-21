/**
 * FailedJobsSection
 *
 * Renders the "Failed Jobs" header banner and one card per failed PDF job.
 * Extracted from app/catalog-review.tsx so it can be unit-tested without
 * mounting the full screen (which depends on routing, auth, and other context).
 *
 * Props mirror the slice of state the parent already owns:
 *   failedJobs   — jobs with status "failed" and dismissed=false
 *   dismissingId — id of the job currently being dismissed (shows spinner text)
 *   resumingId   — id of the job currently being resumed (shows spinner)
 *   onDismiss    — callback when the Dismiss button is pressed
 *   onResume     — callback when the Resume button is pressed
 *   colors       — theme tokens forwarded from useColors()
 */

import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  displayErrorMessage,
  buildFailedJobMetaLine,
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
}

interface Props {
  failedJobs: FailedJob[];
  dismissingId: number | null;
  resumingId: number | null;
  onDismiss: (id: number) => void;
  onResume: (id: number) => void;
  colors: FailedJobsSectionColors;
}

export function FailedJobsSection({ failedJobs, dismissingId, resumingId, onDismiss, onResume, colors }: Props) {
  if (failedJobs.length === 0) return null;

  return (
    <View style={s.section}>
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
          {failedJobs.length} Failed Job{failedJobs.length !== 1 ? "s" : ""}
        </Text>
        <Text style={[s.sectionHint, { color: colors.mutedForeground }]}>
          Tap Resume to continue from where it stopped, or go to the Upload tab to start fresh.
        </Text>
      </View>

      {failedJobs.map((job) => (
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
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
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
});
