import { Feather } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import React from "react";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/contexts/AppContext";
import { useColors, useIsDark } from "@/hooks/useColors";
import { searchResetEvent } from "@/utils/searchResetEvent";

export default function TabLayout() {
  const { isAuthenticated } = useApp();
  const colors = useColors();
  const isDark = useIsDark();
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const { width, height } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const shortLandscape = width > height && height < 500;
  const tabBarHeight = isWeb ? 84 : (shortLandscape ? 52 + bottom : undefined);

  // Guard: render nothing while approvalStatus has not settled to "approved".
  // This closes the narrow window between setActive() resolving (isSignedIn=true)
  // and the /auth/status fetch completing where approvalStatus is still "loading".
  // During that window OAuthButtons may have already called router.replace("/(tabs)"),
  // so without this guard tab content would briefly flash for pending/banned users
  // before AuthGate fires its corrective redirect.
  if (!isAuthenticated) return null;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: "absolute",
          backgroundColor: isIOS ? "transparent" : colors.background,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          elevation: 0,
          ...(tabBarHeight !== undefined ? { height: tabBarHeight } : {}),
          ...(shortLandscape ? { paddingTop: 2, paddingBottom: Math.max(bottom, 2) } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? "dark" : "light"}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />
          ) : null,
        tabBarLabelStyle: {
          fontFamily: "Inter_500Medium",
          fontSize: 11,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Search",
          tabBarIcon: ({ color }) => <Feather name="search" size={22} color={color} />,
        }}
        listeners={({ navigation }) => ({
          tabPress: () => {
            if (navigation.isFocused()) {
              searchResetEvent.emit();
            }
          },
        })}
      />
      <Tabs.Screen
        name="photo"
        options={{
          title: "Photo ID",
          tabBarIcon: ({ color }) => <Feather name="camera" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: "Map",
          tabBarIcon: ({ color }) => <Feather name="map" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="upload"
        options={{
          title: "Admin",
          tabBarIcon: ({ color }) => <Feather name="shield" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="help"
        options={{
          title: "Help",
          tabBarIcon: ({ color }) => <Feather name="help-circle" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="measure"
        options={{
          title: "Measure",
          tabBarIcon: ({ color }) => <Feather name="maximize" size={22} color={color} />,
          href: null,
        }}
      />
    </Tabs>
  );
}
