/**
 * Extracted async logic for the User Management tab in upload.tsx.
 *
 * Separated so it can be unit-tested without mounting the full screen.
 *
 * fetchAdminUsers   — GET  /admin/users, populates the user list.
 * handleUserAction  — POST /admin/users/:clerkUserId/approve|ban|promote|demote,
 *                     then refreshes the list on success.
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
  showToast: (message: string, type: "error") => void;
  fetchUsers: () => Promise<void>;
};

/**
 * Fetches the full user list from GET /admin/users.
 *
 * Sets usersLoading while in flight. On success populates usersData.
 * On failure (network or non-ok HTTP) populates usersError.
 * The Authorization header is always set from adminToken.
 */
export async function fetchAdminUsers(deps: FetchAdminUsersDeps): Promise<void> {
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
  } catch (err) {
    setUsersError(err instanceof Error ? err.message : "Failed to load users");
  } finally {
    setUsersLoading(false);
  }
}

/**
 * Sends POST /admin/users/:clerkUserId/approve|ban|promote|demote.
 *
 * Guards against concurrent calls (userActionPending already set).
 * On success calls deps.fetchUsers() to refresh the list.
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
    await fetchUsers();
  } catch (err) {
    showToast(
      err instanceof Error ? err.message : `Failed to ${action} user`,
      "error",
    );
  } finally {
    setUserActionPending(null);
  }
}
