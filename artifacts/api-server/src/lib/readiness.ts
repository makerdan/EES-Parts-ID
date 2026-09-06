type StartupReadinessStatus = "pending" | "ready" | "timed_out" | "failed";

type StartupReadiness = {
  status: StartupReadinessStatus;
};

let startupReadiness: StartupReadiness = { status: "pending" };

function get(): Readonly<StartupReadiness> {
  return startupReadiness;
}

function markReady(): void {
  startupReadiness = { status: "ready" };
}

function markTimedOut(): void {
  if (startupReadiness.status === "pending") {
    startupReadiness = { status: "timed_out" };
  }
}

function markFailed(): void {
  startupReadiness = { status: "failed" };
}

function reset(): void {
  startupReadiness = { status: "pending" };
}

export const appReadiness = {
  get,
  markReady,
  markTimedOut,
  markFailed,
  reset,
};