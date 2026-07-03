import { useEffect, useState, type ReactNode } from "react";
import { useAuth, useClerk } from "@clerk/react";
import { basePath } from "../auth/clerkConfig";

const API_BASE = `${window.location.origin}/api`;

type AdminStatus = "loading" | "admin" | "denied" | "error";

/** Shared centered message shell for the various blocked states. */
function GateShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#0d1117] px-4">
      <div className="w-full max-w-md rounded-2xl border border-[#30363d] bg-[#161b22] p-8 text-center shadow-2xl">
        {children}
      </div>
    </div>
  );
}

/**
 * Gates its children behind a signed-in Clerk admin account.
 *
 *   - Signed out              → prompt to sign in.
 *   - Signed in, checking     → loading state.
 *   - Signed in, not admin    → clear "admins only" message.
 *   - Signed in, admin        → renders children.
 *
 * When `requireAdmin` is false the gate only requires a signed-in user (used for
 * read-only tools that still need a Clerk session for API access).
 */
export function AdminGate({
  children,
  requireAdmin = true,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut, redirectToSignIn } = useClerk();
  const [status, setStatus] = useState<AdminStatus>("loading");

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    if (!requireAdmin) {
      setStatus("admin");
      return;
    }

    let cancelled = false;
    setStatus("loading");

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/me`, {
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) setStatus(res.status === 403 ? "denied" : "error");
          return;
        }
        const body = (await res.json()) as { isAdmin?: boolean };
        if (!cancelled) setStatus(body.isAdmin ? "admin" : "denied");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, requireAdmin]);

  if (!isLoaded) {
    return (
      <GateShell>
        <p className="text-sm text-[#8b949e]">Loading…</p>
      </GateShell>
    );
  }

  if (!isSignedIn) {
    return (
      <GateShell>
        <h1 className="mb-2 text-lg font-bold text-[#f9fafb]">Sign in required</h1>
        <p className="mb-6 text-sm leading-relaxed text-[#8b949e]">
          The Zone Editor is an internal admin tool. Please sign in with an admin
          account to continue.
        </p>
        <button
          type="button"
          onClick={() =>
            redirectToSignIn({ signInFallbackRedirectUrl: window.location.href })
          }
          className="w-full rounded-md bg-[#0070ff] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#005fd6]"
        >
          Sign in
        </button>
      </GateShell>
    );
  }

  if (status === "loading") {
    return (
      <GateShell>
        <p className="text-sm text-[#8b949e]">Checking permissions…</p>
      </GateShell>
    );
  }

  if (status === "denied") {
    return (
      <GateShell>
        <h1 className="mb-2 text-lg font-bold text-[#f9fafb]">Admins only</h1>
        <p className="mb-6 text-sm leading-relaxed text-[#8b949e]">
          Your account doesn&apos;t have admin access to the Zone Editor. Ask an
          administrator to grant you access, then reload this page.
        </p>
        <button
          type="button"
          onClick={() => signOut({ redirectUrl: basePath || "/" })}
          className="w-full rounded-md border border-[#30363d] bg-transparent px-4 py-2.5 text-sm font-semibold text-[#f9fafb] transition-colors hover:bg-[#21262d]"
        >
          Sign out
        </button>
      </GateShell>
    );
  }

  if (status === "error") {
    return (
      <GateShell>
        <h1 className="mb-2 text-lg font-bold text-[#f9fafb]">
          Couldn&apos;t verify access
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-[#8b949e]">
          We couldn&apos;t reach the server to confirm your permissions. Check that
          the API server is running and try again.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="w-full rounded-md bg-[#0070ff] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#005fd6]"
        >
          Retry
        </button>
      </GateShell>
    );
  }

  return <>{children}</>;
}
