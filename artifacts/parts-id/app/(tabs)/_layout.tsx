/**
 * Tab bar layout for the authenticated app.
 *
 * Four tabs (Search, Photo, Upload, Elliott Site) plus a +Reference modal trigger, with an
 * iOS blur background. Tab order matches the worker's task frequency:
 * searching is the most common action so it's the default landing tab.
 */
import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Tabs } from 'expo-router';
import { Icon, Label, NativeTabs } from 'expo-router/unstable-native-tabs';
import { SymbolView } from 'expo-symbols';
import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useColors, useIsDark } from '@/hooks/useColors';

function NativeTabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: 'magnifyingglass', selected: 'magnifyingglass.circle.fill' }} />
        <Label>Search</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="photo">
        <Icon sf={{ default: 'camera', selected: 'camera.fill' }} />
        <Label>Photo ID</Label>
      </NativeTabs.Trigger>
      {/*
        Scan was moved out of the tab bar (Task #129) and then promoted
        to a top-level stack route (Task #133) so router.push("/scan")
        works on the iOS native (Liquid Glass) tab bar — a hidden
        NativeTabs.Trigger isn't a navigable destination on iOS, so
        the push was being silently swallowed.
      */}
      <NativeTabs.Trigger name="upload">
        <Icon sf={{ default: 'arrow.up.doc', selected: 'arrow.up.doc.fill' }} />
        <Label>Upload</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="shop">
        <Icon sf={{ default: 'globe', selected: 'globe.americas.fill' }} />
        <Label>Elliott Site</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function ClassicTabLayout() {
  const colors = useColors();
  const isDark = useIsDark();
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.background,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          elevation: 0,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />
          ) : null,
        tabBarLabelStyle: {
          fontFamily: 'Inter_500Medium',
          fontSize: 11,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'PartsID',
          tabBarLabel: 'Search',
          // Show the native iOS large-collapsible-title header on this tab.
          // `headerLargeTitle` is a valid React Navigation / expo-router header
          // option at runtime but is not yet surfaced in Tabs.Screen's TypeScript
          // types — hence the suppression below.
          headerShown: isIOS,
          // @ts-expect-error — headerLargeTitle is supported by the underlying
          // React Navigation stack renderer on iOS but not typed for Tabs.Screen
          headerLargeTitle: isIOS,
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="magnifyingglass" tintColor={color} size={24} />
            ) : (
              <Feather name="search" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="photo"
        options={{
          title: 'Photo ID',
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="camera" tintColor={color} size={24} />
            ) : (
              <Feather name="camera" size={22} color={color} />
            ),
        }}
      />
      {/*
        Scan was promoted to a top-level stack route (Task #133) so
        navigation behaves identically on iOS NativeTabs and on the
        classic Tabs layout. No declaration needed here anymore.
      */}
      <Tabs.Screen
        name="upload"
        options={{
          title: 'Upload',
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="arrow.up.doc" tintColor={color} size={24} />
            ) : (
              <Feather name="upload" size={22} color={color} />
            ),
        }}
      />
      <Tabs.Screen
        name="shop"
        options={{
          title: 'Elliott Site',
          tabBarIcon: ({ color }) =>
            isIOS ? (
              <SymbolView name="globe" tintColor={color} size={24} />
            ) : (
              <Feather name="globe" size={22} color={color} />
            ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}
