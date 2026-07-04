/**
 * UserAdminButtonRow
 *
 * Renders the admin-role action button for a single user card in the Users tab.
 *
 * Rules (mirrors the server-side guard in POST /admin/users/:id/promote):
 *   - If the user already has the admin role   → show "↓ Revoke Admin"
 *   - If the user is approved (non-admin)       → show "↑ Make Admin"
 *   - If the user is pending or banned          → render nothing
 *
 * Extracted so the conditional can be unit-tested without mounting the full
 * upload screen.
 */

import React from "react";
import { ActivityIndicator, Pressable, Text } from "react-native";

import { useColors } from "@/hooks/useColors";
import type { UserRow } from "@/utils/adminUserActions";

type Props = {
  user: UserRow;
  userActionPending: string | null;
  onPromote: () => void;
  onDemote: () => void;
};

export function UserAdminButtonRow({
  user,
  userActionPending,
  onPromote,
  onDemote,
}: Props) {
  const colors = useColors();
  const isAdminRole = user.role === "admin";
  const isPending = userActionPending === user.clerkUserId;

  if (isAdminRole) {
    return (
      <Pressable
        onPress={onDemote}
        disabled={!!userActionPending}
        accessibilityLabel="Revoke Admin"
        style={{
          borderRadius: 6,
          paddingVertical: 8,
          alignItems: "center",
          backgroundColor: colors.muted,
          borderWidth: 1,
          borderColor: colors.border,
          opacity: userActionPending ? 0.6 : 1,
        }}
      >
        {isPending ? (
          <ActivityIndicator size="small" color={colors.foreground} />
        ) : (
          <Text
            style={{
              fontSize: 13,
              fontFamily: "Inter_600SemiBold",
              color: colors.foreground,
            }}
          >
            ↓ Revoke Admin
          </Text>
        )}
      </Pressable>
    );
  }

  if (user.status === "approved") {
    return (
      <Pressable
        onPress={onPromote}
        disabled={!!userActionPending}
        accessibilityLabel="Make Admin"
        style={{
          borderRadius: 6,
          paddingVertical: 8,
          alignItems: "center",
          backgroundColor: colors.primary + "15",
          borderWidth: 1,
          borderColor: colors.primary + "44",
          opacity: userActionPending ? 0.6 : 1,
        }}
      >
        {isPending ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Text
            style={{
              fontSize: 13,
              fontFamily: "Inter_600SemiBold",
              color: colors.primary,
            }}
          >
            ↑ Make Admin
          </Text>
        )}
      </Pressable>
    );
  }

  return null;
}
