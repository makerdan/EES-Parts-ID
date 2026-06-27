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
  setAdminToken as setAdminTokenModule,
  setAppToken as setAppTokenModule,
  setOnUnauthorized,
} from "@/utils/appAuth";
import { type LogoutHandler,LogoutRegistry } from "@/utils/logoutRegistry";
import {
  ADMIN_TOKEN_KEY,
  clearSessionStorage,
  SEARCH_CACHE_KEYS,
  SESSION_KEY,
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
      // First launch — write defaults immediately so every downstream consumer
      // (context, conversion helpers, unit picker) always reads a persisted value.
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
 *
 * Passing `null` resets to the system preference ("system" option).
 */
function applyThemeMode(mode: ThemeMode) {
  try {
    Appearance.setColorScheme(mode === "system" ? null : mode);
  } catch {
    // `setColorScheme` is a no-op on platforms that don't support it (old RN, some web runtimes).
  }
}

type AdminProfilePayload = {
  dimensionUnit?: string;
  textSize?: string;
  themeMode?: string;
  defaultConfidenceThreshold?: number;
  scanSound?: boolean;
};

/**
 * Merge a server profile payload into existing local settings, validating each
 * field before applying it. Returns the same object reference if nothing changed
 * so callers can use reference equality to skip unnecessary saves.
 */
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
    const resp = await fetch(`${API_BASE}/admin/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    return await resp.json() as AdminProfilePayload;
  } catch {
    return null;
  }
}

async function pushAdminProfile(token: string, settings: AppSettings): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/profile`, {
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
  isAdmin: boolean;
  adminToken: string | null;
  login: (password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  loginAdmin: (password: string) => Promise<{ success: boolean; error?: string }>;
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

async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  return SecureStore.getItemAsync(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      reportStorageError("Could not save to local storage", err);
    }
    return;
  }
  return SecureStore.setItemAsync(key, value);
}

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
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [toastState, setToastState] = useState<{ message: string; type: ToastVariant } | null>(null);
  const [pendingMapFocus, setPendingMapFocus] = useState<MapFocus | null>(null);
  const [pinnedParts, setPinnedParts] = useState<Array<PinnedPart>>([]);
  const [pendingMeasureSearch, setPendingMeasureSearch] = useState<MeasureSearchParams | null>(null);
  const [pendingInventorySearch, setPendingInventorySearch] = useState<InventorySearchParams | null>(null);
  const [pendingLidarDims, setPendingLidarDims] = useState<LidarDims | null>(null);
  const [resumeProgress, setResumeProgress] = useState<Record<number, ResumeProgress>>({});
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard: if the generated API client module failed to load (e.g. codegen has
  // not run yet and Metro resolved a stub), setBaseUrl/setAuthTokenGetter will
  // be undefined at runtime.  Detect this early so we can show a clear recovery
  // UI instead of silently crashing individual query hooks.
  const [apiInitError, setApiInitError] = useState(false);

  // Keep adminToken accessible to the generated API client (which calls a
  // module-level getter on every request). Without this, admin-protected
  // mutations like useUpdateItemBins would send no Authorization header
  // and 401, even when the user is logged in as admin.
  const adminTokenRef = useRef<string | null>(null);
  useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);
  // Sync admin token to module-level store so non-React hooks (manual fetch
  // calls that use getAuthHeaders()) always send the current token.
  useEffect(() => { setAdminTokenModule(adminToken); }, [adminToken]);

  // App-session token returned by POST /auth/app-login. Stored in SecureStore
  // under SESSION_KEY and restored on boot.
  const appTokenRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      // If setBaseUrl or setAuthTokenGetter are not functions the generated API
      // client module did not load (codegen hasn't run or Metro resolved a stub).
      // Fail fast so the user sees a clear recovery message instead of silent 404s.
      if (typeof setBaseUrl !== "function" || typeof setAuthTokenGetter !== "function") {
        setApiInitError(true);
        return;
      }
      // Configure the base URL once on mount so all generated hooks point at
      // the correct API origin without requiring each call site to repeat it.
      // API_ORIGIN is the bare origin (no /api suffix) because the generated
      // client paths already start with /api/…; including it here would double
      // the prefix. Empty string means "use relative URLs" (web dev).
      if (API_ORIGIN) setBaseUrl(API_ORIGIN);
      // Use admin token when present; fall back to app-session token so regular
      // (non-admin) users' generated-client calls still pass requireAppAuth.
      setAuthTokenGetter(() => adminTokenRef.current ?? appTokenRef.current);
    } catch {
      // API client module threw during initialisation — still show the error UI.
      setApiInitError(true);
    }
    return () => {
      try { setAuthTokenGetter(null); } catch {}
    };
  }, []);

  // Registry of in-memory reset handlers fired on logout (e.g. SearchScreen
  // clears its filters/results so a new login doesn't see the prior session).
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

  // When any protected request returns 401, force the session to end locally
  // and surface a re-login prompt. Covers both the generated API client
  // (setUnauthorizedHandler) and manual fetchWithAuth call sites (setOnUnauthorized).
  // If an admin token is active the admin session expired; clear only the admin
  // overlay and let the app-session token continue. Otherwise the app-session
  // token itself expired; force a full re-login.
  useEffect(() => {
    const handle401 = () => {
      if (adminTokenRef.current !== null) {
        secureDelete(ADMIN_TOKEN_KEY).catch(err => {
          // eslint-disable-next-line no-console
          console.warn("[AppContext] Failed to delete admin token from secure storage:", err);
          reportStorageError("Could not clear admin session token", err);
        });
        setAdminToken(null);
        showToast("Admin session expired. Please log in again.", "error");
      } else {
        secureDelete(SESSION_KEY).catch(err => {
          // eslint-disable-next-line no-console
          console.warn("[AppContext] Failed to delete app token from secure storage:", err);
          reportStorageError("Could not clear app session token", err);
        });
        appTokenRef.current = null;
        setAppTokenModule(null);
        setIsAuthenticated(false);
        showToast("Session expired. Please enter the app password again.", "error");
      }
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
  }, [showToast]);

  // Wire the storage-error reporter to the toast surface so silent write
  // failures (full disk, locked keychain, web localStorage quota) become
  // visible to the user instead of being swallowed.
  useEffect(() => {
    setStorageErrorHandler((label, err) => {
      // eslint-disable-next-line no-console
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

  useEffect(() => {
    Promise.all([
      secureGet(SESSION_KEY),
      secureGet(ADMIN_TOKEN_KEY),
      loadSettings(),
    ]).then(([session, token, s]) => {
      // SESSION_KEY now stores the signed app-session token. The legacy value
      // "authenticated" (stored by the old client-side check) is treated as
      // invalid and will require a fresh server-validated login.
      if (session && session !== "authenticated") {
        appTokenRef.current = session;
        setAppTokenModule(session);
        setIsAuthenticated(true);
      }
      if (token) setAdminToken(token);
      setSettings(s);
      applyThemeMode(s.themeMode);
      setIsLoading(false);

      // Background: if already logged in as admin, pull server profile and
      // apply all portable settings so the admin's preferences follow them across devices.
      if (token) {
        fetchAdminProfile(token).then(profile => {
          if (!profile) return;
          setSettings(prev => {
            const merged = mergeProfileIntoSettings(prev, profile);
            if (merged === prev) return prev;
            saveSettings(merged);
            if (merged.themeMode !== prev.themeMode) applyThemeMode(merged.themeMode);
            return merged;
          });
        }).catch(err => {
          // eslint-disable-next-line no-console
          console.warn("[AppContext] Background admin profile sync failed:", err);
        });
      }
    }).catch(() => {
      // SecureStore failure (e.g. keychain unavailable) — start in clean logged-out state
      setIsLoading(false);
    });
  }, []);

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

  const login = useCallback(async (password: string) => {
    try {
      const resp = await fetch(`${API_BASE}/auth/app-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await resp.json() as { token?: string; error?: string };

      if (!resp.ok) {
        if (resp.status === 503) {
          return { success: false, error: body.error ?? "App password not configured on the server" };
        }
        return { success: false, error: body.error ?? "Incorrect password" };
      }

      if (!body.token) {
        return { success: false, error: "Server did not return a token" };
      }

      await secureSet(SESSION_KEY, body.token);
      appTokenRef.current = body.token;
      setAppTokenModule(body.token);
      setIsAuthenticated(true);
      return { success: true };
    } catch {
      return { success: false, error: "Could not reach the server. Check your connection." };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await clearSessionStorage(secureDelete, AsyncStorage.multiRemove);
    } catch (err) {
      reportStorageError("Could not clear session storage on logout", err);
    }
    // Fire in-memory reset handlers so screens drop the prior session's state
    logoutRegistryRef.current.fire();
    appTokenRef.current = null;
    setAppTokenModule(null);
    setIsAuthenticated(false);
    setAdminToken(null);
  }, []);

  const loginAdmin = useCallback(async (password: string) => {
    try {
      const resp = await fetch(`${API_BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await resp.json() as { token?: string; error?: string };

      if (!resp.ok) {
        if (resp.status === 503) {
          return { success: false, error: body.error ?? "Admin access is not configured on the server" };
        }
        return { success: false, error: body.error ?? "Incorrect admin password" };
      }

      if (!body.token) {
        return { success: false, error: "Server did not return a token" };
      }

      await secureSet(ADMIN_TOKEN_KEY, body.token);
      setAdminToken(body.token);

      // Background: pull server profile so all portable settings are
      // immediately applied on this device without blocking the login response.
      fetchAdminProfile(body.token).then(profile => {
        if (!profile) return;
        setSettings(prev => {
          const merged = mergeProfileIntoSettings(prev, profile);
          if (merged === prev) return prev;
          saveSettings(merged);
          if (merged.themeMode !== prev.themeMode) applyThemeMode(merged.themeMode);
          return merged;
        });
      }).catch(err => {
        // eslint-disable-next-line no-console
        console.warn("[AppContext] Post-login admin profile sync failed:", err);
      });

      return { success: true };
    } catch {
      return { success: false, error: "Could not reach the server. Check your connection." };
    }
  }, []);

  const logoutAdmin = useCallback(async () => {
    const token = adminTokenRef.current;
    // Best-effort server-side revocation: tells the server to invalidate all
    // outstanding tokens so other devices/sessions are also signed out.
    // We intentionally do not await or surface errors here — local logout
    // completes regardless of network availability.
    if (token && API_BASE) {
      fetch(`${API_BASE}/admin/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    await secureDelete(ADMIN_TOKEN_KEY);
    setAdminToken(null);
  }, []);

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
      isAdmin: !!adminToken,
      adminToken,
      login,
      logout,
      loginAdmin,
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
