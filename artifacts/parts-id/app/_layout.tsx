import { ClerkLoaded, ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import NetInfo from "@react-native-community/netinfo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { FEATHER_FONT_B64 } from "@/assets/fonts/featherBase64";
import { DismissKeyboard } from "@/components/DismissKeyboard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { prefetchSvgAsset } from "@/components/WarehouseMapView";
import { AppProvider, useApp } from "@/contexts/AppContext";

SplashScreen.preventAutoHideAsync();

// Required so the OAuth redirect tab closes automatically after sign-in.
// Must be called at module level, outside any component.
WebBrowser.maybeCompleteAuthSession();

if (Platform.OS === "web" && typeof document !== "undefined") {
  const EXPO_STYLE_ID = "expo-generated-fonts";
  let styleEl = document.getElementById(EXPO_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = EXPO_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  const already = styleEl.sheet
    ? Array.from(styleEl.sheet.cssRules).some(
        (r) => r instanceof CSSFontFaceRule && (r as CSSFontFaceRule).style.fontFamily.replace(/['"]/g, "") === "feather"
      )
    : styleEl.textContent?.includes("feather");
  if (!already) {
    const css = `@font-face{font-family:"feather";src:url("data:font/ttf;base64,${FEATHER_FONT_B64}") format("truetype");font-weight:normal;font-style:normal;font-display:auto}`;
    styleEl.appendChild(document.createTextNode(css));
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 30_000 },
  },
});

// EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY — required.
// Paste the "Publishable key" value from your Clerk dashboard
// (API Keys → Publishable key, format: pk_live_… or pk_test_…).
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;

// EXPO_PUBLIC_CLERK_PROXY_URL — optional, production only.
// Set this to your deployed API server's Clerk proxy path when running in
// production so that Clerk Frontend API traffic is routed through your own
// domain (e.g. https://your-app.replit.app/api/__clerk).
// Leave unset in development — Clerk proxying only works for production
// instances (pk_live_…) and the API server skips the proxy in non-production.
const proxyUrl = process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined;

function AuthGate() {
  const { isSignedIn, isLoaded: clerkLoaded } = useAuth();
  const { approvalStatus } = useApp();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!clerkLoaded) return;

    const seg0 = segments[0] as string | undefined;
    const inTabs = seg0 === "(tabs)";
    const atLogin = seg0 === "login";
    const atSignUp = seg0 === "sign-up";
    const atPending = seg0 === "pending";
    const atBanned = seg0 === "banned";

    if (!isSignedIn) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!atLogin && !atSignUp) router.replace("/login" as any);
    } else {
      if (approvalStatus === "loading" || approvalStatus === "idle") return;
      if (approvalStatus === "pending" && !atPending) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.replace("/pending" as any);
      } else if (approvalStatus === "banned" && !atBanned) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.replace("/banned" as any);
      } else if (approvalStatus === "approved" && !inTabs) {
        router.replace("/(tabs)");
      }
    }
  }, [isSignedIn, clerkLoaded, approvalStatus, segments, router]);

  return null;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    ...(Platform.OS !== "web" ? { feather: require("../assets/fonts/Feather.ttf") } : {}),
  });

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    if (!fontsLoaded && !fontError) return;
    NetInfo.fetch().then((state) => {
      if (state.isConnected) prefetchSvgAsset();
    }).catch(console.error);
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache} proxyUrl={proxyUrl}>
      <ClerkLoaded>
        <SafeAreaProvider>
          <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <GestureHandlerRootView style={{ flex: 1 }}>
                <AppProvider>
                  <DismissKeyboard>
                    <Stack screenOptions={{ headerShown: false }}>
                      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                      <Stack.Screen name="login" options={{ headerShown: false }} />
                      <Stack.Screen name="sign-up" options={{ headerShown: false }} />
                      <Stack.Screen name="pending" options={{ headerShown: false }} />
                      <Stack.Screen name="banned" options={{ headerShown: false }} />
                      <Stack.Screen name="catalog-review" options={{ headerShown: false }} />
                      <Stack.Screen name="edit-item" options={{ headerShown: false }} />
                      <Stack.Screen name="ai-log" options={{ headerShown: false }} />
                      <Stack.Screen name="admin-inbox" options={{ headerShown: false }} />
                      <Stack.Screen name="admin" options={{ headerShown: false }} />
                    </Stack>
                    <AuthGate />
                  </DismissKeyboard>
                </AppProvider>
              </GestureHandlerRootView>
            </QueryClientProvider>
          </ErrorBoundary>
        </SafeAreaProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
