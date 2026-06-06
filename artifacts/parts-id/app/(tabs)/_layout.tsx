import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useColors, useIsDark } from "@/hooks/useColors";
import { searchResetEvent } from "@/utils/searchResetEvent";
import { isLiDARSupported } from "lidar-measure";
import { useApp } from "@/contexts/AppContext";

export default function TabLayout() {
  const colors = useColors();
  const isDark = useIsDark();
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const { isAdmin } = useApp();
  const lidarSupported = isLiDARSupported();

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
          ...(isWeb ? { height: 84 } : {}),
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
          title: "Upload",
          tabBarIcon: ({ color }) => <Feather name="upload" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="measure"
        options={{
          title: "Measure",
          tabBarIcon: ({ color }) => <Feather name="maximize" size={22} color={color} />,
          // Hide this tab on devices without LiDAR — isLiDARSupported() returns
          // false on Android, Web, and non-LiDAR iOS devices.
          href: lidarSupported && isAdmin ? undefined : null,
        }}
      />
    </Tabs>
  );
}
