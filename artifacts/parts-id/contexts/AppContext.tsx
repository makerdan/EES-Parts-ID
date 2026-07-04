import { useAuth, useClerk } from "@clerk/expo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setAuthTokenGetter, setBaseUrl, setUnauthorizedHandler } from "@workspace/api-client-react";
import * as SecureStore from "expo-secure-store";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Appearance, AppState, Platform, StyleSheet, Text, useColorScheme,View } from "react-native";

import colorTokens from "@/constants/colors";
import type { ResumeProgress } from "@/types/catalogPdf";
import { API_BASE, API_ORIGIN } from "@/utils/apiBase";
import {
  fetchWithAuth,
  notifyTokenAvailable,
  setAppTokenGetter,
  setOnUnauthorized,
} from "@/utils/appAuth";
import { type LogoutHandler,LogoutRegistry } from "@/utils/logoutRegistry";
import {
  clearSessionStorage,
  SEARCH_CACHE_KEYS,
} from "@/utils/sessionStorage";
import {
  reportStorageError,
  setStorageErrorHandler,
} from "@/utils/storageErrorReporter";

// ── App Settings ─────────────────────────────────────────────────────────────
export const SETTINGS_KEY = "parts_id_settings_v1";
export type TextSize = "small" | "normal" | "large";
export type ThemeMode = "light" | "dark" | "system";
export type DimensionUnit = "mm" | "cm" | "in";
export type ApprovalStatus = "idle" | "loading" | "pending" | "approved" | "banned";

export type PinnedPart = {
  binCode: string;
  label: string;
  aisleNum: number;
  variant?: boolean;
  /** ID of the parent search result item — used to scope variant pin removal to a single card. */
  groupId?: number;
};

/** Dimensions captured by the Measure tab, passed back to an item edit form. */
export type LidarDims = {
  length?: number | null;
  width?: number | null;
  height?: number | null;
  diameter?: number | null;
};

/** Inventory search pre-filter set by cross-tab navigation (e.g. "View in Inventory" after adding a part). */
export type InventorySearchParams = {
  vendor?: string;
  catalog?: string;
};

export type MeasureSearchParams = {
  minLength?: string;
  maxLength?: string;
  minWidth?: string;
  maxWidth?: string;
  minHeight?: string;
  maxHeight?: string;
  minDiameter?: string;
  maxDiameter?: string;
};

export type AppSettings = {
  textSize: TextSize;
  defaultConfidenceThreshold: number;
  themeMode: ThemeMode;
  shelfViewEnabled: boolean;
  scanSound: boolean;
  dimensionUnit: DimensionUnit;
};
export type ToastVariant = "info" | "success" | "error";

export const DEFAULT_SETTINGS: AppSettings = {
  textSize: "normal",
  defaultConfidenceThreshold: 50,
  themeMode: "system",
  shelfViewEnabled: true,
  scanSound: true,
  dimensionUnit: "mm",
};

const VALID_TEXT_SIZES: Array<TextSize> = ["small", "normal", "large"];
const VALID_THEME_MODES: Array<ThemeMode> = ["light", "dark", "system"];
const VALID_DIMENSION_UNITS: Array<DimensionUnit> = ["mm", "cm", "in"];

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      await saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      textSize: VALID_TEXT_SIZES.includes(parsed.textSize as TextSize)
        ? (parsed.textSize as TextSize)
        : DEFAULT_SETTINGS.textSize,
      themeMode: VALID_THEME_MODES.includes(parsed.themeMode as ThemeMode)
        ? (parsed.themeMode as ThemeMode)
        : DEFAULT_SETTINGS.themeMode,
      dimensionUnit: VALID_DIMENSION_UNITS.includes(parsed.dimensionUnit as DimensionUnit)
        ? (parsed.dimensionUnit as DimensionUnit)
        : DEFAULT_SETTINGS.dimensionUnit,
    };
  } catch { return DEFAULT_SETTINGS; }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (err) {
    reportStorageError("Could not save settings", err);
  }
}

/**
 * Propagates the stored theme preference to React Native's Appearance API so
 * that ALL native components — including NativeTabs / Liquid Glass tabs on iOS
 * — immediately reflect the manually chosen Light / Dark mode.
 */
function applyThemeMode(mode: ThemeMode) {
  try {
    Appearance.setColorScheme(mode === "system" ? null : mode);
  } catch {
    // `setColorScheme` is a no-op on platforms that don't support it.
  }
}

type AdminProfilePayload = {
  dimensionUnit?: string;
  textSize?: string;
  themeMode?: string;
  defaultConfidenceThreshold?: number;
  scanSound?: boolean;
};

function mergeProfileIntoSettings(prev: AppSettings, profile: AdminProfilePayload): AppSettings {
  let next = prev;

  if (
    profile.dimensionUnit &&
    VALID_DIMENSION_UNITS.includes(profile.dimensionUnit as DimensionUnit) &&
    prev.dimensionUnit !== profile.dimensionUnit
  ) {
    next = { ...next, dimensionUnit: profile.dimensionUnit as DimensionUnit };
  }

  if (
    profile.textSize &&
    VALID_TEXT_SIZES.includes(profile.textSize as TextSize) &&
    prev.textSize !== profile.textSize
  ) {
    next = { ...next, textSize: profile.textSize as TextSize };
  }

  if (
    profile.themeMode &&
    VALID_THEME_MODES.includes(profile.themeMode as ThemeMode) &&
    prev.themeMode !== profile.themeMode
  ) {
    next = { ...next, themeMode: profile.themeMode as ThemeMode };
  }

  if (
    typeof profile.defaultConfidenceThreshold === "number" &&
    Number.isInteger(profile.defaultConfidenceThreshold) &&
    profile.defaultConfidenceThreshold >= 0 &&
    profile.defaultConfidenceThreshold <= 100 &&
    prev.defaultConfidenceThreshold !== profile.defaultConfidenceThreshold
  ) {
    next = { ...next, defaultConfidenceThreshold: profile.defaultConfidenceThreshold };
  }

  if (
    typeof profile.scanSound === "boolean" &&
    prev.scanSound !== profile.scanSound
  ) {
    next = { ...next, scanSound: profile.scanSound };
  }

  return next;
}

async function fetchAdminProfile(token: string): Promise<AdminProfilePayload | null> {
  try {
    const resp = await fetchWithAuth(`${API_BASE}/admin/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    return await resp.json() as AdminProfilePayload;
  } catch {
    return null;
  }
}

async function pushAdminProfile(token: string, settings: AppSettings): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/admin/profile`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      dimensionUnit: settings.dimensionUnit,
      textSize: settings.textSize,
      themeMode: settings.themeMode,
      defaultConfidenceThreshold: settings.defaultConfidenceThreshold,
      scanSound: settings.scanSound,
    }),
  });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
}

export type { LogoutHandler };

export type MapFocus = {
  aisleNum: number;
  /** Section number of the primary bin, used to centre the map on the exact section zone. */
  sectionNum?: number;
  label?: string;
};

interface AppContextValue {
  isAuthenticated: boolean;
  approvalStatus: ApprovalStatus;
  recheckApprovalStatus: () => Promise<void>;
  isAdmin: boolean;
  adminToken: string | null;
  logout: () => Promise<void>;
  logoutAdmin: () => Promise<void>;
  clearCache: () => Promise<void>;
  isLoading: boolean;
  // Settings
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  textFontScale: number;
  // Non-blocking toast surface (used by storage error reporter + callers)
  showToast: (message: string, type?: ToastVariant) => void;
  // Allow screens to register an in-memory reset that fires on logout
  registerLogoutHandler: (handler: LogoutHandler) => () => void;
  // Cross-tab navigation: pending zone to open on the Map tab
  pendingMapFocus: MapFocus | null;
  setPendingMapFocus: (focus: MapFocus | null) => void;
  // Cross-tab: parts currently pinned on the map from a search session
  pinnedParts: Array<PinnedPart>;
  setPinnedParts: React.Dispatch<React.SetStateAction<Array<PinnedPart>>>;
  // Cross-tab: dimension-keyword search set by the Photo tab Measure flow
  pendingMeasureSearch: MeasureSearchParams | null;
  setPendingMeasureSearch: (search: MeasureSearchParams | null) => void;
  // Cross-tab: vendor+catalog pre-filter set when navigating from "View in Inventory"
  pendingInventorySearch: InventorySearchParams | null;
  setPendingInventorySearch: (search: InventorySearchParams | null) => void;
  // Cross-tab: LiDAR dims captured in the Measure tab to pre-fill an item form
  pendingLidarDims: LidarDims | null;
  setPendingLidarDims: (dims: LidarDims | null) => void;
  // Persisted resume-progress state so the card survives screen navigation
  resumeProgress: Record<number, ResumeProgress>;
  setResumeProgress: React.Dispatch<React.SetStateAction<Record<number, ResumeProgress>>>;
}

const AppContext = createContext<AppContextValue | null>(null);

async function secureDelete(key: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      localStorage.removeItem(key);
    } catch (err) {
      reportStorageError("Could not clear local storage", err);
    }
    return;
  }
  return SecureStore.deleteItemAsync(key);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  // ── Clerk auth state ─────────────────────────────────────────────────────
  const { isSignedIn, getToken, userId, isLoaded: clerkLoaded } = useAuth();
  const { signOut } = useClerk();

  // ── Local state ───────────────────────────────────────────────────────────
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus>("idle");
  const isAuthenticated = approvalStatus === "approved";

  // `isAdmin` is the source of truth (derived from the server's role check via
  // GET /admin/me). `adminToken` mirrors the current Clerk session token but is
  // only populated while the user is an admin, so downstream call sites that
  // still expect an admin bearer token keep working unchanged.
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const isLoading = !clerkLoaded || !settingsLoaded;
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [toastState, setToastState] = useState<{ message: string; type: ToastVariant } | null>(null);
  const [pendingMapFocus, setPendingMapFocus] = useState<MapFocus | null>(null);
  const [pinnedParts, setPinnedParts] = useState<Array<PinnedPart>>([]);
  const [pendingMeasureSearch, setPendingMeasureSearch] = useState<MeasureSearchParams | null>(null);
  const [pendingInventorySearch, setPendingInventorySearch] = useState<InventorySearchParams | null>(null);
  const [pendingLidarDims, setPendingLidarDims] = useState<LidarDims | null>(null);
  const [resumeProgress, setResumeProgress] = useState<Record<number, ResumeProgress>>({});
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [apiInitError, setApiInitError] = useState(false);

  const adminTokenRef = useRef<string | null>(null);
  useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);

  const isAdminRef = useRef(false);
  useEffect(() => { isAdminRef.current = isAdmin; }, [isAdmin]);

  // Keep a stable ref to getToken so we don't recreate the auth getter on every render.
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);

  // ── API client initialization ─────────────────────────────────────────────
  useEffect(() => {
    try {
      if (typeof setBaseUrl !== "function" || typeof setAuthTokenGetter !== "function") {
        setApiInitError(true);
        return;
      }
      if (API_ORIGIN) setBaseUrl(API_ORIGIN);

      // All requests use the Clerk session token; admin authority is enforced
      // server-side by the user's role, not by a separate token.
      const tokenGetter = () => getTokenRef.current();

      // Wire into both the generated API client and fetchWithAuth (manual fetches).
      setAuthTokenGetter(tokenGetter);
      setAppTokenGetter(tokenGetter);
    } catch {
      setApiInitError(true);
    }
    return () => {
      try { setAuthTokenGetter(null); } catch {}
      setAppTokenGetter(null);
    };
  }, []);

  // ── Admin role check ──────────────────────────────────────────────────────
  // Determine admin status from the server (role-based) via GET /admin/me.
  // When the user is an admin, mirror the current Clerk token into `adminToken`
  // so downstream admin-only fetches keep a bearer token to send.
  const verifyAdmin = useCallback(async (token: string, signal?: AbortSignal) => {
    try {
      const resp = await fetch(`${API_BASE}/admin/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (signal?.aborted) return;
      if (resp.ok) {
        const body = await resp.json() as { isAdmin?: boolean };
        const admin = !!body.isAdmin;
        setIsAdmin(admin);
        setAdminToken(admin ? token : null);
      } else {
        setIsAdmin(false);
        setAdminToken(null);
      }
    } catch {
      if (!signal?.aborted) {
        setIsAdmin(false);
        setAdminToken(null);
      }
    }
  }, []);

  // ── Approval status check ─────────────────────────────────────────────────
  // After Clerk confirms sign-in, call the API to verify the user is approved.
  const doApprovalCheck = useCallback(async (signal?: AbortSignal) => {
    const token = await getToken();
    if (signal?.aborted) return;
    if (!token) {
      setApprovalStatus("pending");
      setIsAdmin(false);
      setAdminToken(null);
      return;
    }

    const resp = await fetch(`${API_BASE}/auth/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });

    if (signal?.aborted) return;

    if (resp.ok) {
      setApprovalStatus("approved");
      notifyTokenAvailable();
      await verifyAdmin(token, signal);
    } else if (resp.status === 403) {
      const body = await resp.json() as { code?: string };
      setApprovalStatus(body.code === "banned" ? "banned" : "pending");
      setIsAdmin(false);
      setAdminToken(null);
    } else {
      setApprovalStatus("pending");
      setIsAdmin(false);
      setAdminToken(null);
    }
  }, [getToken, verifyAdmin]);

  useEffect(() => {
    if (!clerkLoaded) return;

    if (!isSignedIn) {
      setApprovalStatus("idle");
      return;
    }

    const controller = new AbortController();
    setApprovalStatus("loading");

    doApprovalCheck(controller.signal).catch(() => {
      if (!controller.signal.aborted) setApprovalStatus("pending");
    });

    return () => { controller.abort(); };
  }, [isSignedIn, userId, clerkLoaded, doApprovalCheck]);

  // Manual re-check: used by the pending screen so users don't have to sign
  // out and back in after an admin approves them.
  const recheckControllerRef = useRef<AbortController | null>(null);

  // Abort any in-flight recheck when the provider unmounts.
  useEffect(() => {
    return () => { recheckControllerRef.current?.abort(); };
  }, []);

  const recheckApprovalStatus = useCallback(async () => {
    if (!isSignedIn) return;
    // Cancel any previous in-flight recheck before starting a new one.
    recheckControllerRef.current?.abort();
    const controller = new AbortController();
    recheckControllerRef.current = controller;
    setApprovalStatus("loading");
    try {
      await doApprovalCheck(controller.signal);
    } catch {
      if (!controller.signal.aborted) setApprovalStatus("pending");
    } finally {
      if (recheckControllerRef.current === controller) {
        recheckControllerRef.current = null;
      }
    }
  }, [isSignedIn, doApprovalCheck]);

  // ── Registry of in-memory logout handlers ─────────────────────────────────
  const logoutRegistryRef = useRef(new LogoutRegistry());
  const registerLogoutHandler = useCallback((handler: LogoutHandler) => {
    return logoutRegistryRef.current.register(handler);
  }, []);

  const showToast = useCallback((message: string, type: ToastVariant = "info") => {
    setToastState({ message, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastState(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  // ── 401 handler ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handle401 = () => {
      // Every request now carries the Clerk session token, so a 401 means the
      // session expired — sign out and reset admin state.
      signOut().catch(() => {});
      setApprovalStatus("idle");
      setIsAdmin(false);
      setAdminToken(null);
      showToast("Session expired. Please sign in again.", "error");
    };

    try {
      if (typeof setUnauthorizedHandler === "function") {
        setUnauthorizedHandler(handle401);
      }
    } catch {}
    setOnUnauthorized(handle401);

    return () => {
      try { setUnauthorizedHandler(null); } catch {}
      setOnUnauthorized(null);
    };
  }, [showToast, signOut]);

  // ── Storage error reporter ───────────────────────────────────────────────
  useEffect(() => {
    setStorageErrorHandler((label, err) => {
      console.warn(`[storage] ${label}:`, err);
      showToast(label, "error");
    });
    return () => { setStorageErrorHandler(null); };
  }, [showToast]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // ── Boot: restore settings from storage ──────────────────────────────────
  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      applyThemeMode(s.themeMode);
      setSettingsLoaded(true);
    }).catch(() => {
      setSettingsLoaded(true);
    });
  }, []);

  // ── Admin profile sync ────────────────────────────────────────────────────
  // When the user becomes an admin, pull their server-stored profile settings
  // once and merge them in. Reset the guard when admin status is lost.
  const adminProfileSyncedRef = useRef(false);
  useEffect(() => {
    if (!isAdmin) {
      adminProfileSyncedRef.current = false;
      return;
    }
    if (adminProfileSyncedRef.current) return;
    adminProfileSyncedRef.current = true;
    (async () => {
      const token = await getTokenRef.current();
      if (!token) return;
      try {
        const profile = await fetchAdminProfile(token);
        if (!profile) return;
        setSettings(prev => {
          const merged = mergeProfileIntoSettings(prev, profile);
          if (merged === prev) return prev;
          saveSettings(merged);
          if (merged.themeMode !== prev.themeMode) applyThemeMode(merged.themeMode);
          return merged;
        });
      } catch (err) {
        console.warn("[AppContext] Admin profile sync failed:", err);
      }
    })();
  }, [isAdmin]);

  // ── Periodic admin-status re-check ────────────────────────────────────────
  // Re-verify the user's admin role against the server on a short interval and
  // whenever the app returns to the foreground. Running for ALL approved users
  // (not just current admins) means a newly promoted user discovers their new
  // role within one poll cycle — no sign-out required.
  const refreshAdminStatus = useCallback(async () => {
    const token = await getTokenRef.current();
    if (!token) {
      setIsAdmin(false);
      setAdminToken(null);
      return;
    }
    await verifyAdmin(token);
  }, [verifyAdmin]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const id = setInterval(() => { refreshAdminStatus(); }, 30_000);
    return () => clearInterval(id);
  }, [isAuthenticated, refreshAdminStatus]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && isAuthenticated) refreshAdminStatus();
    });
    return () => sub.remove();
  }, [isAuthenticated, refreshAdminStatus]);

  const currentSettingsRef = useRef(settings);
  useEffect(() => { currentSettingsRef.current = settings; }, [settings]);

  const pendingSyncRef = useRef(false);

  const syncSettingsToServer = useCallback(async (settingsToSync: AppSettings) => {
    const token = adminTokenRef.current;
    if (!token) return;
    try {
      await pushAdminProfile(token, settingsToSync);
      pendingSyncRef.current = false;
    } catch {
      pendingSyncRef.current = true;
      showToast("Couldn't save setting to server — will retry when reconnected.", "error");
    }
  }, [showToast]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && pendingSyncRef.current) {
        syncSettingsToServer(currentSettingsRef.current);
      }
    });
    return () => sub.remove();
  }, [syncSettingsToServer]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...currentSettingsRef.current, [key]: value };
    setSettings(next);
    saveSettings(next);
    if (key === "themeMode") applyThemeMode(value as ThemeMode);
    const PORTABLE_KEYS: Array<keyof AppSettings> = [
      "dimensionUnit", "textSize", "themeMode", "defaultConfidenceThreshold", "scanSound",
    ];
    if (PORTABLE_KEYS.includes(key) && adminTokenRef.current) {
      syncSettingsToServer(next);
    }
  }, [syncSettingsToServer]);

  const textFontScale =
    settings.textSize === "small" ? 0.85 : settings.textSize === "large" ? 1.18 : 1.0;

  // ── Auth actions ──────────────────────────────────────────────────────────

  const logout = useCallback(async () => {
    try {
      await clearSessionStorage(secureDelete, AsyncStorage.multiRemove);
    } catch (err) {
      reportStorageError("Could not clear session storage on logout", err);
    }
    logoutRegistryRef.current.fire();
    setIsAdmin(false);
    setAdminToken(null);
    setApprovalStatus("idle");
    await signOut();
  }, [signOut]);

  // Re-verify admin status against the server using a fresh Clerk token. Called
  // when an admin action returns 401/403 so a stale token or a role change is
  // reconciled without dropping the user out of the app entirely.
  const logoutAdmin = useCallback(async () => {
    const token = await getTokenRef.current();
    if (!token) {
      setIsAdmin(false);
      setAdminToken(null);
      return;
    }
    await verifyAdmin(token);
  }, [verifyAdmin]);

  const clearCache = useCallback(async () => {
    try {
      await AsyncStorage.multiRemove(SEARCH_CACHE_KEYS);
    } catch (err) {
      reportStorageError("Could not clear search cache", err);
    }
  }, []);

  if (apiInitError) {
    return (
      <View style={apiErrStyles.container}>
        <Text style={apiErrStyles.title}>Server unavailable</Text>
        <Text style={apiErrStyles.hint}>Restart the app to reconnect.</Text>
      </View>
    );
  }

  return (
    <AppContext.Provider value={{
      isAuthenticated,
      approvalStatus,
      recheckApprovalStatus,
      isAdmin,
      adminToken,
      logout,
      logoutAdmin,
      clearCache,
      isLoading,
      settings,
      updateSetting,
      textFontScale,
      showToast,
      registerLogoutHandler,
      pendingMapFocus,
      setPendingMapFocus,
      pinnedParts,
      setPinnedParts,
      pendingMeasureSearch,
      setPendingMeasureSearch,
      pendingInventorySearch,
      setPendingInventorySearch,
      pendingLidarDims,
      setPendingLidarDims,
      resumeProgress,
      setResumeProgress,
    }}>
      {children}
      {toastState ? <BrandedToast message={toastState.message} type={toastState.type} /> : null}
    </AppContext.Provider>
  );
}

function BrandedToast({ message, type }: { message: string; type: ToastVariant }) {
  const systemScheme = useColorScheme();
  const { settings } = useApp();
  const themeMode = settings.themeMode ?? "system";
  const effectiveScheme = themeMode === "system" ? systemScheme : themeMode;
  const palette = effectiveScheme === "dark" ? colorTokens.dark : colorTokens.light;
  const colors = { ...palette, radius: colorTokens.radius };

  const accentColor =
    type === "success" ? colors.success :
    type === "error"   ? colors.destructive :
    colors.primary;

  return (
    <View style={[toastStyles.wrap, { pointerEvents: "none" }]}>
      <View style={[toastStyles.toast, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[toastStyles.accent, { backgroundColor: accentColor }]} />
        <View style={toastStyles.body}>
          <Text style={[toastStyles.text, { color: colors.foreground }]} numberOfLines={3}>{message}</Text>
        </View>
      </View>
    </View>
  );
}

const apiErrStyles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  title: { fontSize: 18, fontWeight: "700", marginBottom: 8, textAlign: "center" },
  hint: { fontSize: 14, textAlign: "center", opacity: 0.7 },
});

const toastStyles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 32,
    alignItems: "center",
    paddingHorizontal: 24,
  },
  toast: {
    flexDirection: "row",
    borderRadius: 10,
    borderWidth: 1,
    maxWidth: 480,
    overflow: "hidden",
    elevation: 4,
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
  },
  accent: {
    width: 4,
    alignSelf: "stretch",
  },
  body: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  text: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
});

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
