/**
 * Root Expo Router layout.
 *
 * Loads Inter font weights, wires up the auth gate (redirects unauthenticated
 * users to /login), provides AppContext + React Query, and mounts the
 * ErrorBoundary that catches render errors before they crash the worker's
 * session on the warehouse floor.
 */
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setBaseUrl } from "@workspace/api-client-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider, useApp } from "@/contexts/AppContext";

SplashScreen.preventAutoHideAsync();

// Configure API base URL from env.
// NOTE: do NOT append "/api" here — the OpenAPI spec declares
// `servers: - url: /api`, so every generated client path already starts
// with `/api/...`.  Adding it again here produces `/api/api/...` 404s for
// every typed-client call (suggest-description, search, AI identify, etc.).
const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) {
  setBaseUrl(`https://${domain}`);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 30_000 },
  },
});

function AuthGate() {
  const { isAuthenticated, isLoading } = useApp();
  const segments = useSegments();
  const router = useRouter();
  // On every fresh app launch (or hard reload of the web preview), land on
  // the Search tab — workers expect the app to "open to the main page",
  // not whatever tab they were on last session. We do this exactly once
  // per mount, after auth resolves, so in-session tab switches are not
  // overridden.
  const didLandRef = React.useRef(false);

  useEffect(() => {
    if (isLoading) return;
    const inTabsGroup = segments[0] === "(tabs)";
    // Top-level authenticated routes that live outside the (tabs)
    // group but should NOT bounce the user back to the tab bar
    // (e.g. the Scan camera screen, promoted out of the tab bar in
    // Task #133 so router.push("/scan") works on iOS NativeTabs).
    const isAuthedTopLevel = segments[0] === "scan";
    const inAuthedArea = inTabsGroup || isAuthedTopLevel;
    if (!isAuthenticated && inAuthedArea) {
      router.replace("/login");
      return;
    }
    if (isAuthenticated && !inAuthedArea) {
      router.replace("/(tabs)");
      return;
    }
    if (isAuthenticated && inTabsGroup && !didLandRef.current) {
      didLandRef.current = true;
      router.replace("/(tabs)");
    }
  }, [isAuthenticated, isLoading, segments, router]);

  return null;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <AppProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="login" options={{ headerShown: false }} />
                {/*
                  Scan camera screen — top-level stack route so it works
                  with the iOS native tab bar (Task #133). Pushed onto
                  the stack from the Search header; back-navigation
                  pops it and lands on the Search tab.
                */}
                <Stack.Screen name="scan" options={{ headerShown: false }} />
              </Stack>
              <AuthGate />
            </AppProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
