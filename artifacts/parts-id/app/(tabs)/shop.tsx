import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { useColors } from "@/hooks/useColors";

const SHOP_URL = "https://www.elliottelectric.com";

export default function ShopScreen() {
  const colors = useColors();
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const handleRetry = () => {
    setErrorMessage(null);
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        {errorMessage ? (
          <View style={styles.errorContainer}>
            <Text style={[styles.errorIcon]}>⚠️</Text>
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
                setErrorMessage(
                  e.nativeEvent.description ||
                    "Check your connection and try again.",
                );
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
