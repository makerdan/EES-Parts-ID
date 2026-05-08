/**
 * Global app state container.
 *
 * Holds the auth flag (post-password login), the inventory cache used by the
 * Fuse.js offline fallback, and a few cross-tab UI prefs. Backed by
 * AsyncStorage so the worker's state survives app relaunches.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance, Platform } from 'react-native';

const SEARCH_CACHE_KEYS = ['parts_id_fuse_cache_v2', 'parts_id_query_cache_v1'];

const SESSION_KEY = 'parts_id_session';
const ADMIN_TOKEN_KEY = 'parts_id_admin_token';

// ── App Settings ─────────────────────────────────────────────────────────────
export const SETTINGS_KEY = 'parts_id_settings_v1';
export type TextSize = 'small' | 'normal' | 'large';
export type ThemeMode = 'light' | 'dark' | 'system';
export type AppSettings = {
  textSize: TextSize;
  defaultConfidenceThreshold: number;
  themeMode: ThemeMode;
  shelfViewEnabled: boolean;
  warehouseShelfView: boolean;
};
export const DEFAULT_SETTINGS: AppSettings = {
  textSize: 'normal',
  defaultConfidenceThreshold: 50,
  themeMode: 'system',
  shelfViewEnabled: true,
  warehouseShelfView: true,
};

const VALID_TEXT_SIZES: TextSize[] = ['small', 'normal', 'large'];
const VALID_THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
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
      shelfViewEnabled:
        typeof parsed.shelfViewEnabled === 'boolean'
          ? parsed.shelfViewEnabled
          : DEFAULT_SETTINGS.shelfViewEnabled,
      warehouseShelfView:
        typeof parsed.warehouseShelfView === 'boolean'
          ? parsed.warehouseShelfView
          : DEFAULT_SETTINGS.warehouseShelfView,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
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
    Appearance.setColorScheme(mode === 'system' ? null : mode);
  } catch {
    // `setColorScheme` is a no-op on platforms that don't support it (old RN, some web runtimes).
  }
}
const APP_PASSWORD = process.env.EXPO_PUBLIC_APP_PASSWORD ?? '';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : '';

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
}

const AppContext = createContext<AppContextValue | null>(null);

async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      localStorage.setItem(key, value);
    } catch {}
    return;
  }
  return SecureStore.setItemAsync(key, value);
}

async function secureDelete(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      localStorage.removeItem(key);
    } catch {}
    return;
  }
  return SecureStore.deleteItemAsync(key);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    Promise.all([secureGet(SESSION_KEY), secureGet(ADMIN_TOKEN_KEY), loadSettings()])
      .then(([session, token, s]) => {
        if (session === 'authenticated') setIsAuthenticated(true);
        if (token) setAdminToken(token);
        setSettings(s);
        applyThemeMode(s.themeMode);
        setIsLoading(false);
      })
      .catch(() => {
        // SecureStore failure (e.g. keychain unavailable) — start in clean logged-out state
        setIsLoading(false);
      });
  }, []);

  const updateSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value };
        saveSettings(next);
        if (key === 'themeMode') applyThemeMode(value as ThemeMode);
        return next;
      });
    },
    []
  );

  const textFontScale =
    settings.textSize === 'small' ? 0.85 : settings.textSize === 'large' ? 1.18 : 1.0;

  const login = useCallback(async (password: string) => {
    if (!APP_PASSWORD) {
      return { success: false, error: 'App password not configured. Contact your administrator.' };
    }
    if (password === APP_PASSWORD) {
      await secureSet(SESSION_KEY, 'authenticated');
      setIsAuthenticated(true);
      return { success: true };
    }
    return { success: false, error: 'Incorrect password' };
  }, []);

  const logout = useCallback(async () => {
    await secureDelete(SESSION_KEY);
    await secureDelete(ADMIN_TOKEN_KEY);
    await AsyncStorage.multiRemove(SEARCH_CACHE_KEYS).catch(() => {});
    setIsAuthenticated(false);
    setAdminToken(null);
  }, []);

  const loginAdmin = useCallback(async (password: string) => {
    try {
      const resp = await fetch(`${API_BASE}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = (await resp.json()) as { token?: string; error?: string };

      if (!resp.ok) {
        if (resp.status === 503) {
          return {
            success: false,
            error: body.error ?? 'Admin access is not configured on the server',
          };
        }
        return { success: false, error: body.error ?? 'Incorrect admin password' };
      }

      if (!body.token) {
        return { success: false, error: 'Server did not return a token' };
      }

      await secureSet(ADMIN_TOKEN_KEY, body.token);
      setAdminToken(body.token);
      return { success: true };
    } catch {
      return { success: false, error: 'Could not reach the server. Check your connection.' };
    }
  }, []);

  const logoutAdmin = useCallback(async () => {
    await secureDelete(ADMIN_TOKEN_KEY);
    setAdminToken(null);
  }, []);

  const clearCache = useCallback(async () => {
    await AsyncStorage.multiRemove(SEARCH_CACHE_KEYS).catch(() => {});
  }, []);

  return (
    <AppContext.Provider
      value={{
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
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
