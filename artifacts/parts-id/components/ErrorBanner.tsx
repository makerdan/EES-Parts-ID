/**
 * Branded inline error banner — left-accented red bar with an icon and
 * concise message. Use wherever an operation fails and the worker needs
 * immediate, in-context feedback (login, upload, scan, search).
 *
 * Keep messages direct and action-oriented. Never use filler phrases like
 * "Oops" or "Something went wrong" without a specific follow-up action.
 *
 * Pass `onDismiss` to show a ✕ button that lets the worker clear the
 * banner after reading it.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface ErrorBannerProps {
  message: string;
  style?: object;
  onDismiss?: () => void;
}

export function ErrorBanner({ message, style, onDismiss }: ErrorBannerProps) {
  const colors = useColors();

  return (
    <View
      style={[
        styles.banner,
        {
          backgroundColor: colors.destructive + '12',
          borderLeftColor: colors.destructive,
        },
        style,
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text style={[styles.icon, { color: colors.destructive }]}>✕</Text>
      <Text style={[styles.text, { color: colors.destructive }]} numberOfLines={4}>
        {message}
      </Text>
      {onDismiss ? (
        <Pressable
          onPress={onDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
          style={styles.dismissBtn}
        >
          <Text style={[styles.dismissText, { color: colors.destructive }]}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 8,
    marginVertical: 8,
  },
  icon: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
    marginTop: 1,
    flexShrink: 0,
  },
  text: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    lineHeight: 19,
    flexShrink: 1,
    flex: 1,
  },
  dismissBtn: {
    flexShrink: 0,
    paddingHorizontal: 4,
    paddingVertical: 2,
    marginTop: 1,
  },
  dismissText: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
    opacity: 0.7,
  },
});
