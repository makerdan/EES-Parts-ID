import { useAuth } from "@clerk/expo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { LogoutHandler } from "@/utils/logoutRegistry";
import { prependEntry, type ScanEntry } from "@/utils/scanHistory";
import {
  prependQueryHistory,
  prependViewedHistory,
  type ViewedEntry,
} from "@/utils/searchHistory";
import { discardLegacyUserHistoryStorage } from "@/utils/sessionStorage";
import { reportStorageError } from "@/utils/storageErrorReporter";
import {
  EMPTY_USER_HISTORY,
  loadUserHistory,
  updateUserHistory,
  type UserHistoryPatch,
  type UserHistorySnapshot,
} from "@/utils/userHistoryApi";

type HistoryStatus = "idle" | "loading" | "ready" | "error";
type HistoryCollection = keyof UserHistorySnapshot;

interface OwnedHistoryState {
  userId: string | null;
  status: HistoryStatus;
  data: UserHistorySnapshot;
}

interface HistoryIdentity {
  userId: string | null;
  generation: number;
}

interface UserHistoryContextValue {
  history: UserHistorySnapshot;
  status: HistoryStatus;
  recordQuery: (query: string) => Promise<void>;
  clearQueries: () => Promise<void>;
  recordViewed: (entry: Omit<ViewedEntry, "timestamp">) => Promise<void>;
  clearViewed: () => Promise<void>;
  recordScan: (entry: ScanEntry) => Promise<void>;
  clearScans: () => Promise<void>;
}

const EMPTY_STATE: OwnedHistoryState = {
  userId: null,
  status: "idle",
  data: EMPTY_USER_HISTORY,
};

const UserHistoryContext = createContext<UserHistoryContextValue | null>(null);

interface UserHistoryProviderProps {
  isAuthenticated: boolean;
  registerLogoutHandler: (handler: LogoutHandler) => () => void;
  children: React.ReactNode;
}

export function UserHistoryProvider({
  isAuthenticated,
  registerLogoutHandler,
  children,
}: UserHistoryProviderProps) {
  const { isSignedIn, isLoaded, userId, getToken } = useAuth();
  const activeUserId =
    isLoaded && isSignedIn && isAuthenticated ? (userId ?? null) : null;
  const [ownedState, setOwnedState] = useState<OwnedHistoryState>(EMPTY_STATE);
  const ownedStateRef = useRef(ownedState);
  const identityRef = useRef<HistoryIdentity>({ userId: null, generation: 0 });
  const tokenGetterRef = useRef(getToken);
  const activeRequestsRef = useRef(new Set<AbortController>());
  const writeQueuesRef = useRef(new Map<string, Promise<void>>());
  const historyRevisionRef = useRef(0);

  useEffect(() => {
    tokenGetterRef.current = getToken;
  }, [getToken]);

  const publishState = useCallback((next: OwnedHistoryState) => {
    ownedStateRef.current = next;
    setOwnedState(next);
  }, []);

  const abortActiveRequests = useCallback(() => {
    for (const controller of activeRequestsRef.current) {
      controller.abort();
    }
    activeRequestsRef.current.clear();
  }, []);

  const isCurrentIdentity = useCallback((identity: HistoryIdentity) => (
    identity.userId !== null &&
    identityRef.current.userId === identity.userId &&
    identityRef.current.generation === identity.generation
  ), []);

  useEffect(() => {
    discardLegacyUserHistoryStorage((keys) => AsyncStorage.multiRemove(keys)).catch((err) => {
      reportStorageError("Could not discard legacy history", err);
    });
  }, []);

  useLayoutEffect(() => {
    if (identityRef.current.userId === activeUserId) return;

    identityRef.current = {
      userId: activeUserId,
      generation: identityRef.current.generation + 1,
    };
    historyRevisionRef.current += 1;
    abortActiveRequests();
    publishState({
      userId: activeUserId,
      status: activeUserId ? "loading" : "idle",
      data: EMPTY_USER_HISTORY,
    });
  }, [activeUserId, abortActiveRequests, publishState]);

  const resetForLogout = useCallback(() => {
    identityRef.current = {
      userId: null,
      generation: identityRef.current.generation + 1,
    };
    historyRevisionRef.current += 1;
    abortActiveRequests();
    publishState(EMPTY_STATE);
  }, [abortActiveRequests, publishState]);

  useEffect(
    () => registerLogoutHandler(resetForLogout),
    [registerLogoutHandler, resetForLogout],
  );

  useEffect(() => {
    if (!activeUserId || identityRef.current.userId !== activeUserId) return;
    const identity = { ...identityRef.current };
    const revision = historyRevisionRef.current;
    const controller = new AbortController();
    const activeRequests = activeRequestsRef.current;
    activeRequests.add(controller);

    void (async () => {
      try {
        const token = await tokenGetterRef.current();
        if (controller.signal.aborted || !isCurrentIdentity(identity)) return;
        if (!token) throw new Error("No authenticated history token");
        const history = await loadUserHistory(token, controller.signal);
        if (
          !controller.signal.aborted &&
          isCurrentIdentity(identity) &&
          historyRevisionRef.current === revision
        ) {
          publishState({ userId: identity.userId, status: "ready", data: history });
        }
      } catch {
        if (
          !controller.signal.aborted &&
          isCurrentIdentity(identity) &&
          historyRevisionRef.current === revision
        ) {
          publishState({
            userId: identity.userId,
            status: "error",
            data: EMPTY_USER_HISTORY,
          });
        }
      } finally {
        activeRequests.delete(controller);
      }
    })();

    return () => {
      controller.abort();
      activeRequests.delete(controller);
    };
  }, [activeUserId, isCurrentIdentity, publishState]);

  useEffect(() => () => abortActiveRequests(), [abortActiveRequests]);

  const mutateCollection = useCallback(
    async <K extends HistoryCollection,>(
      collection: K,
      update: (current: UserHistorySnapshot[K]) => UserHistorySnapshot[K],
    ): Promise<void> => {
      const identity = { ...identityRef.current };
      if (!identity.userId) return;
      historyRevisionRef.current += 1;

      const queueKey = `${identity.userId}:${collection}`;
      const previous = writeQueuesRef.current.get(queueKey) ?? Promise.resolve();
      const operation = previous.then(async () => {
        if (!isCurrentIdentity(identity)) return;

        const controller = new AbortController();
        activeRequestsRef.current.add(controller);
        try {
          let current = ownedStateRef.current;
          let token: string | null = null;
          if (current.userId !== identity.userId || current.status !== "ready") {
            publishState({
              userId: identity.userId,
              status: "loading",
              data: current.userId === identity.userId ? current.data : EMPTY_USER_HISTORY,
            });
            token = await tokenGetterRef.current();
            if (controller.signal.aborted || !isCurrentIdentity(identity)) return;
            if (!token) throw new Error("No authenticated history token");
            const loaded = await loadUserHistory(token, controller.signal);
            if (controller.signal.aborted || !isCurrentIdentity(identity)) return;
            current = { userId: identity.userId, status: "ready", data: loaded };
            publishState(current);
          }

          const nextCollection = update(current.data[collection]);
          token ??= await tokenGetterRef.current();
          if (controller.signal.aborted || !isCurrentIdentity(identity)) return;
          if (!token) throw new Error("No authenticated history token");

          const patch = { [collection]: nextCollection } as UserHistoryPatch;
          const updated = await updateUserHistory(patch, token, controller.signal);
          if (!controller.signal.aborted && isCurrentIdentity(identity)) {
            const latest = ownedStateRef.current;
            publishState({
              userId: identity.userId,
              status: "ready",
              data: { ...latest.data, [collection]: updated[collection] },
            });
          }
        } catch (err) {
          if (!controller.signal.aborted && isCurrentIdentity(identity)) {
            const current = ownedStateRef.current;
            publishState({
              userId: identity.userId,
              status: current.userId === identity.userId && current.status === "ready"
                ? "ready"
                : "error",
              data: current.userId === identity.userId
                ? current.data
                : EMPTY_USER_HISTORY,
            });
          }
          throw err;
        } finally {
          activeRequestsRef.current.delete(controller);
        }
      });
      const settled = operation.then(() => undefined, () => undefined);
      writeQueuesRef.current.set(queueKey, settled);
      try {
        await operation;
      } finally {
        if (writeQueuesRef.current.get(queueKey) === settled) {
          writeQueuesRef.current.delete(queueKey);
        }
      }
    },
    [isCurrentIdentity, publishState],
  );

  const recordQuery = useCallback((query: string) => {
    if (!query.trim()) return Promise.resolve();
    return mutateCollection("queryHistory", (current) => prependQueryHistory(current, query));
  }, [mutateCollection]);
  const clearQueries = useCallback(
    () => mutateCollection("queryHistory", () => []),
    [mutateCollection],
  );
  const recordViewed = useCallback(
    (entry: Omit<ViewedEntry, "timestamp">) =>
      mutateCollection("viewedHistory", (current) => prependViewedHistory(current, entry)),
    [mutateCollection],
  );
  const clearViewed = useCallback(
    () => mutateCollection("viewedHistory", () => []),
    [mutateCollection],
  );
  const recordScan = useCallback(
    (entry: ScanEntry) =>
      mutateCollection("scanHistory", (current) => prependEntry(current, entry)),
    [mutateCollection],
  );
  const clearScans = useCallback(
    () => mutateCollection("scanHistory", () => []),
    [mutateCollection],
  );

  const visibleState = useMemo<OwnedHistoryState>(
    () => ownedState.userId === activeUserId
      ? ownedState
      : {
          userId: activeUserId,
          status: activeUserId ? "loading" : "idle",
          data: EMPTY_USER_HISTORY,
        },
    [activeUserId, ownedState],
  );
  const contextValue = useMemo<UserHistoryContextValue>(() => ({
    history: visibleState.data,
    status: visibleState.status,
    recordQuery,
    clearQueries,
    recordViewed,
    clearViewed,
    recordScan,
    clearScans,
  }), [
    visibleState,
    recordQuery,
    clearQueries,
    recordViewed,
    clearViewed,
    recordScan,
    clearScans,
  ]);

  return (
    <UserHistoryContext.Provider value={contextValue}>
      {children}
    </UserHistoryContext.Provider>
  );
}

export function useUserHistory(): UserHistoryContextValue {
  const context = useContext(UserHistoryContext);
  if (!context) throw new Error("useUserHistory must be used inside UserHistoryProvider");
  return context;
}