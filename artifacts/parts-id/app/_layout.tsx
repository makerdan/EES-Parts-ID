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
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setBaseUrl } from "@workspace/api-client-react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider, useApp } from "@/contexts/AppContext";
import { FEATHER_FONT_B64 } from "@/assets/fonts/featherBase64";

SplashScreen.preventAutoHideAsync();

// Configure API base URL from env
const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) {
  setBaseUrl(`https://${domain}/api`);
}

// On web: inject the Feather @font-face rule directly into expo-font's own
// style element (id="expo-generated-fonts") before React boots.
// expo-font's Font.isLoaded() only checks that element, and its own
// _createWebFontTemplate omits format("truetype"), which makes browsers
// reject the font. We bypass it entirely and inject with the correct hint.
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

function AuthGate() {
  const { isAuthenticated, isLoading } = useApp();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    const inTabsGroup = segments[0] === "(tabs)";
    if (!isAuthenticated && inTabsGroup) {
      router.replace("/login");
    } else if (isAuthenticated && !inTabsGroup) {
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
    // Native only — on web the font is pre-injected above via CSS.
    ...(Platform.OS !== "web" ? { feather: require("../assets/fonts/Feather.ttf") } : {}),
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
                <Stack.Screen name="catalog-review" options={{ headerShown: false }} />
              </Stack>
              <AuthGate />
            </AppProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
