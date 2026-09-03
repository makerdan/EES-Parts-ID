import AsyncStorage from "@react-native-async-storage/async-storage";

import { reportStorageError } from "@/utils/storageErrorReporter";

export const HELP_GENERAL_CACHE_KEY = "parts_id_help_general_cache_v1";
export const HELP_ORIENTATION_KEY = "parts_id_help_orientation_v1";
export const HELP_CACHE_MAX_RECORDS = 32;
export const HELP_CACHE_MAX_BYTES = 160_000;

export type HelpAudience = "general" | "admin";

export type HelpRecord = {
  id: string;
  audience: HelpAudience;
  workflow: string;
  title: string;
  summary: string;
  body: string;
  prerequisites: Array<string>;
  steps: Array<string>;
  outcomes: Array<string>;
  recovery: Array<string>;
  limitations: Array<string>;
  revision: {
    contentVersion: string;
    revisedAt: string;
    source: string;
  };
};

export type HelpResponse = {
  schemaVersion: string;
  contentVersion: string;
  audience: HelpAudience;
  records: Array<HelpRecord>;
};

function isStringList(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length <= 500);
}

function isHelpRecord(value: unknown): value is HelpRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<HelpRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.audience === "string" &&
    record.audience === "general" &&
    typeof record.workflow === "string" &&
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    typeof record.body === "string" &&
    isStringList(record.prerequisites) &&
    isStringList(record.steps) &&
    isStringList(record.outcomes) &&
    isStringList(record.recovery) &&
    isStringList(record.limitations) &&
    typeof record.revision === "object" &&
    record.revision !== null &&
    typeof record.revision.contentVersion === "string" &&
    typeof record.revision.revisedAt === "string" &&
    typeof record.revision.source === "string"
  );
}

export function isValidGeneralHelpResponse(value: unknown): value is HelpResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Partial<HelpResponse>;
  if (
    typeof response.schemaVersion !== "string" ||
    typeof response.contentVersion !== "string" ||
    response.audience !== "general" ||
    !Array.isArray(response.records) ||
    response.records.length === 0 ||
    response.records.length > HELP_CACHE_MAX_RECORDS
  ) {
    return false;
  }
  return response.records.every(isHelpRecord);
}

export async function readCachedGeneralHelp(): Promise<HelpResponse | null> {
  try {
    const raw = await AsyncStorage.getItem(HELP_GENERAL_CACHE_KEY);
    if (!raw || raw.length > HELP_CACHE_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidGeneralHelpResponse(parsed)) {
      if (raw) await AsyncStorage.removeItem(HELP_GENERAL_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch (error) {
    reportStorageError("Could not read offline Help content", error);
    return null;
  }
}

export async function writeCachedGeneralHelp(response: HelpResponse): Promise<void> {
  if (!isValidGeneralHelpResponse(response)) return;
  try {
    const raw = JSON.stringify(response);
    if (raw.length > HELP_CACHE_MAX_BYTES) {
      reportStorageError("Offline Help content is too large to cache", new Error("cache size limit"));
      return;
    }
    await AsyncStorage.setItem(HELP_GENERAL_CACHE_KEY, raw);
  } catch (error) {
    reportStorageError("Could not save offline Help content", error);
  }
}

export async function readHelpOrientationDismissed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(HELP_ORIENTATION_KEY)) === "dismissed";
  } catch (error) {
    reportStorageError("Could not read Help orientation state", error);
    return false;
  }
}

export async function saveHelpOrientationDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(HELP_ORIENTATION_KEY, "dismissed");
  } catch (error) {
    reportStorageError("Could not save Help orientation state", error);
  }
}