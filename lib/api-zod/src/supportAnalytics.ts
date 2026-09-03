import { z } from "zod";

/**
 * The only screen names that may be recorded. Keep this list deliberately
 * small: screen telemetry is for operational usage counts, not arbitrary
 * client-provided labels.
 */
export const SCREEN_EVENT_NAMES = [
  "Search",
  "Map",
  "Photo ID",
  "Measure Part",
  "Upload",
  "Edit Item",
  "Catalog Review",
  "AI Log",
  "Admin Inbox",
  "Admin Audit Log",
] as const;

export const SCREEN_EVENT_VERSION = 1 as const;

export const ScreenViewEventSchema = z
  .object({
    version: z.literal(SCREEN_EVENT_VERSION),
    event: z.literal("screen_view"),
    screen: z.enum(SCREEN_EVENT_NAMES),
  })
  .strict();

export type ScreenViewEvent = z.infer<typeof ScreenViewEventSchema>;