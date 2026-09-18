/**
 * Extracted async logic for the User Management tab in upload.tsx.
 *
 * Separated so it can be unit-tested without mounting the full screen.
 *
 * fetchAdminUsers   — GET    /admin/users, populates the user list.
 * handleUserAction  — POST   /admin/users/:clerkUserId/approve|ban|promote|demote,
 *                     then refreshes the list on success.
 * deleteAdminUser   — DELETE /admin/users/:clerkUserId, hard-deletes the DB row.
 */

export type UserRole = "admin" | "user";

export type UserAction = "approve" | "ban" | "promote" | "demote";

export type UserRow = {
  clerkUserId: string;
  email: string;
  status: "pending" | "approved" | "banned";
  role?: UserRole;
  createdAt: string;
};

export type FetchAdminUsersResult =
  | { ok: true }
  | { ok: false; error: string };

export type FetchAdminUsersDeps = {
  apiBase: string;
  adminToken: string;
  setUsersLoading: (v: boolean) => void;
  setUsersError: (v: string | null) => void;
  setUsersData: (v: Array<UserRow>) => void;
};

export type HandleUserActionDeps = {
  apiBase: string;
  adminToken: string;
  userActionPending: string | null;
  setUserActionPending: (v: string | null) => void;
  showToast: (message: string, type: "info" | "success" | "error") => void;
  fetchUsers: () => Promise<FetchAdminUsersResult | void>;
};

export type DeleteAdminUserDeps = {
  apiBase: string;
  adminToken: string;
  setUserActionPending: (v: string | null) => void;
  showToast: (message: string, type: "info" | "success" | "error") => void;
  showWarning: (message: string) => void;
  removeUser: (clerkUserId: string) => void;
};

/**
 * Fetches the full user list from GET /admin/users.
 *
 * Sets usersLoading while in flight. On success populates usersData.
 * On failure (network or non-ok HTTP) populates usersError.
 * The Authorization header is always set from adminToken.
 */
export async function fetchAdminUsers(deps: FetchAdminUsersDeps): Promise<FetchAdminUsersResult> {
  const { apiBase, adminToken, setUsersLoading, setUsersError, setUsersData } = deps;
  setUsersLoading(true);
  setUsersError(null);
  try {
    const resp = await fetch(`${apiBase}/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json()) as { users: Array<UserRow> };
    setUsersData(body.users);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Failed to load users";
    setUsersError(error);
    return { ok: false, error };
  } finally {
    setUsersLoading(false);
  }
}

/**
 * Sends POST /admin/users/:clerkUserId/approve|ban|promote|demote.
 *
 * Guards against concurrent calls (userActionPending already set).
 * On success calls deps.fetchUsers() to refresh the list. A failed refresh is
 * reported separately from the already-completed mutation so the admin is not
 * encouraged to repeat the action.
 * On failure shows a toast via deps.showToast().
 * The Authorization header is always set from adminToken.
 */
export async function handleUserAction(
  clerkUserId: string,
  action: UserAction,
  deps: HandleUserActionDeps,
): Promise<void> {
  const {
    apiBase,
    adminToken,
    userActionPending,
    setUserActionPending,
    showToast,
    fetchUsers,
  } = deps;

  if (userActionPending) return;
  setUserActionPending(clerkUserId);
  try {
    const resp = await fetch(`${apiBase}/admin/users/${clerkUserId}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await resp.json().catch(() => null);

    let refreshResult: FetchAdminUsersResult | void;
    try {
      refreshResult = await fetchUsers();
    } catch {
      refreshResult = { ok: false, error: "Refresh request failed" };
    }

    const actionLabel = {
      approve: "Approve",
      ban: "Ban",
      promote: "Promote",
      demote: "Demote",
    }[action];
    if (refreshResult && !refreshResult.ok) {
      showToast(
        `${actionLabel} completed, but the People list could not be refreshed. Tap Retry to sync.`,
        "error",
      );
    } else {
      showToast(`${actionLabel} completed.`, "success");
    }
  } catch (err) {
    showToast(
      err instanceof Error ? err.message : `Failed to ${action} user`,
      "error",
    );
  } finally {
    setUserActionPending(null);
  }
}

/**
 * Sends DELETE /admin/users/:clerkUserId to hard-delete the DB row.
 *
 * Sets userActionPending while in flight to disable other action buttons.
 * On success calls deps.removeUser() to remove the user from local state.
 * On failure shows a toast via deps.showToast().
 *
 * Partial-success: when the server returns { deleted: true, clerkDeleted: false }
 * the DB row was removed but Clerk deletion failed. removeUser() is still called
 * (the row is gone) and deps.showWarning() is called with the reason so the UI
 * can show a visible warning banner.
 */
export async function deleteAdminUser(
  clerkUserId: string,
  deps: DeleteAdminUserDeps,
): Promise<void> {
  const { apiBase, adminToken, setUserActionPending, showToast, showWarning, removeUser } = deps;

  setUserActionPending(clerkUserId);
  try {
    const resp = await fetch(`${apiBase}/admin/users/${clerkUserId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${resp.status}`);
    }
    const body = await resp.json().catch(() => ({})) as {
      deleted?: boolean;
      clerkDeleted?: boolean;
      clerkError?: string;
    };
    if (body.deleted !== true) {
      throw new Error("The server did not confirm that the user was removed");
    }
    removeUser(clerkUserId);
    if (body.clerkDeleted === false) {
      showWarning(
        body.clerkError
          ? `User removed from the app but Clerk deletion failed: ${body.clerkError}`
          : "User removed from the app but could not be deleted from Clerk — they may still be able to sign in.",
      );
    } else {
      showToast("User removed.", "success");
    }
  } catch (err) {
    showToast(
      err instanceof Error ? err.message : "Failed to delete user",
      "error",
    );
  } finally {
    setUserActionPending(null);
  }
}
