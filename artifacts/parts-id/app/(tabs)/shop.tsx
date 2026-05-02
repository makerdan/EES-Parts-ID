/**
 * Shop tab — embedded WebView pinned to the Elliott Electric Supply
 * storefront so workers can order replacement parts without leaving the
 * app. Shows a friendly offline state when the network is unreachable.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import NetInfo from "@react-native-community/netinfo";
import { useColors } from "@/hooks/useColors";

const SHOP_URL = "https://www.elliottelectric.com";

const OFFLINE_PATTERNS = [
  "internet connection appears to be offline",
  "err_internet_disconnected",
  "err_name_not_resolved",
  "err_address_unreachable",
  "err_network_changed",
  "err_proxy_connection_failed",
  "could not connect to the server",
  "a server with the specified hostname could not be found",
  "the network connection was lost",
  "network is unreachable",
  "no internet",
];

const OFFLINE_ERROR_CODES = new Set([-1009, -1003, -1004, -1005, -1020]);

function looksLikeOfflineError(
  description: string | undefined,
  code: number | undefined,
): boolean {
  if (code !== undefined && OFFLINE_ERROR_CODES.has(code)) return true;
  if (!description) return false;
  const d = description.toLowerCase();
  return OFFLINE_PATTERNS.some((p) => d.includes(p));
}

export default function ShopScreen() {
  const colors = useColors();
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const wasOfflineRef = useRef(false);

  const handleRetry = () => {
    setErrorMessage(null);
    setIsOffline(false);
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  // Subscribe to network state. When connectivity is restored after being
  // offline, automatically reload the WebView so the user doesn't have to
  // tap retry themselves.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online =
        state.isConnected === true && state.isInternetReachable !== false;
      if (!online) {
        wasOfflineRef.current = true;
        setIsOffline(true);
      } else if (online && wasOfflineRef.current) {
        wasOfflineRef.current = false;
        handleRetry();
      }
    });
    return unsubscribe;
  }, []);

  const showingOffline = isOffline;
  const showingError = !showingOffline && errorMessage !== null;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        {showingOffline ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>📡</Text>
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              You're offline
            </Text>
            <Text style={[styles.errorBody, { color: colors.mutedForeground }]}>
              Connect to the internet to browse Elliott Electric Supply. We'll
              reload the shop automatically once you're back online.
            </Text>
            <Pressable
              onPress={handleRetry}
              style={[styles.retryBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.retryBtnText, { color: colors.primaryForeground }]}>
                Try again
              </Text>
            </Pressable>
          </View>
        ) : showingError ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={[styles.errorTitle, { color: colors.foreground }]}>
              Couldn't load Elliott Electric Supply
            </Text>
            <Text style={[styles.errorBody, { color: colors.mutedForeground }]}>
              {errorMessage}
            </Text>
            <Pressable
              onPress={handleRetry}
              style={[styles.retryBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.retryBtnText, { color: colors.primaryForeground }]}>
                Try again
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            <WebView
              key={reloadKey}
              source={{ uri: SHOP_URL }}
              style={styles.webView}
              onLoadStart={() => setLoading(true)}
              onLoadEnd={() => setLoading(false)}
              onError={(e) => {
                setLoading(false);
                const { description, code } = e.nativeEvent;
                if (looksLikeOfflineError(description, code)) {
                  wasOfflineRef.current = true;
                  setIsOffline(true);
                  setErrorMessage(null);
                } else {
                  setErrorMessage(
                    description || "Check your connection and try again.",
                  );
                }
              }}
              onHttpError={(e) => {
                const status = e.nativeEvent.statusCode;
                if (status >= 400) {
                  setLoading(false);
                  setErrorMessage(
                    `The page returned an error (${status}). Please try again later.`,
                  );
                }
              }}
              startInLoadingState={false}
              allowsBackForwardNavigationGestures
              cacheEnabled
              domStorageEnabled
              javaScriptEnabled
              originWhitelist={["*"]}
            />
            {loading ? (
              <View
                style={[
                  styles.loadingOverlay,
                  { backgroundColor: colors.background + "CC" },
                ]}
                pointerEvents="none"
              >
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
                  Loading shop…
                </Text>
              </View>
            ) : null}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { flex: 1, position: "relative" },
  webView: { flex: 1 },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  errorIcon: { fontSize: 48 },
  errorTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  errorBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
