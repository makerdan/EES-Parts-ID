import { useAuth } from "@clerk/expo";
import { useRouter, useSegments } from "expo-router";
import { useEffect } from "react";

import { useApp } from "@/contexts/AppContext";

/**
 * Handles all post-auth navigation decisions.
 *
 * Exempt routes (never redirected away from):
 *   - /login, /sign-up  — unauthenticated entry points
 *   - /sso-callback     — Clerk is still processing the OAuth token; redirecting
 *                         here would cause a double-redirect bug
 *
 * Once isSignedIn flips to true, the user is sent to the appropriate screen
 * based on their approvalStatus.
 */
export function AuthGate() {
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
    // Leave this route alone — Clerk is still processing the OAuth token params.
    const atSsoCallback = seg0 === "sso-callback";
    // Stack-level screens that are valid destinations for approved users.
    const atAdmin = seg0 === "admin";
    const atAdminInbox = seg0 === "admin-inbox";
    const atAdminAuditLog = seg0 === "admin-audit-log";
    const atAiLog = seg0 === "ai-log";
    const atCatalogReview = seg0 === "catalog-review";
    const atEditItem = seg0 === "edit-item";

    if (!isSignedIn) {
      if (!atLogin && !atSignUp && !atSsoCallback) router.replace({ pathname: "/login" });
    } else {
      if (approvalStatus === "loading" || approvalStatus === "idle") return;
      if (approvalStatus === "pending" && !atPending) {
        router.replace({ pathname: "/pending" });
      } else if (approvalStatus === "banned" && !atBanned) {
        router.replace({ pathname: "/banned" });
      } else if (
        approvalStatus === "approved" &&
        !inTabs &&
        !atAdmin &&
        !atAdminInbox &&
        !atAdminAuditLog &&
        !atAiLog &&
        !atCatalogReview &&
        !atEditItem
      ) {
        router.replace("/(tabs)");
      }
    }
  }, [isSignedIn, clerkLoaded, approvalStatus, segments, router]);

  return null;
}
