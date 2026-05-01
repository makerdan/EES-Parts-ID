import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

const SEARCH_CACHE_KEYS = ["parts_id_fuse_cache_v2", "parts_id_query_cache_v1"];

const SESSION_KEY = "parts_id_session";
const APP_PASSWORD = process.env.EXPO_PUBLIC_APP_PASSWORD ?? "";

interface AppContextValue {
  isAuthenticated: boolean;
  login: (password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  isLoading: boolean;
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
    try { localStorage.setItem(key, value); } catch { }
    return;
  }
  return SecureStore.setItemAsync(key, value);
}

async function secureDelete(key: string): Promise<void> {
  if (Platform.OS === "web") {
    try { localStorage.removeItem(key); } catch { }
    return;
  }
  return SecureStore.deleteItemAsync(key);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    secureGet(SESSION_KEY).then((val) => {
      if (val === "authenticated") setIsAuthenticated(true);
      setIsLoading(false);
    });
  }, []);

  const login = useCallback(async (password: string) => {
    if (!APP_PASSWORD) {
      return { success: false, error: "App password not configured. Contact your administrator." };
    }
    if (password === APP_PASSWORD) {
      await secureSet(SESSION_KEY, "authenticated");
      setIsAuthenticated(true);
      return { success: true };
    }
    return { success: false, error: "Incorrect password" };
  }, []);

  const logout = useCallback(async () => {
    await secureDelete(SESSION_KEY);
    await AsyncStorage.multiRemove(SEARCH_CACHE_KEYS).catch(() => {});
    setIsAuthenticated(false);
  }, []);

  return (
    <AppContext.Provider value={{ isAuthenticated, login, logout, isLoading }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
