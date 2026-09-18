(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { HELP_ERROR_CODE, HELP_ERROR_CODES, type HelpErrorCode } from "@workspace/api-zod";

const mockApp = {
  isAdmin: false,
  textFontScale: 1,
  registerLogoutHandler: jest.fn(() => () => {}),
};
const mockAuth = { userId: "worker-1" };
const mockContactSheet = jest.fn();

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockApp,
}));
jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/ContactSheet", () => ({
  ContactSheet: (props: Record<string, unknown>) => {
    mockContactSheet(props);
    return null;
  },
}));
jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: (props: Record<string, unknown>) => {
    const R = require("react");
    return R.createElement("rn-text-input", props);
  },
}));
jest.mock("@/utils/helpStorage", () => ({
  readCachedGeneralHelp: jest.fn(async () => null),
  writeCachedGeneralHelp: jest.fn(async () => {}),
  readHelpOrientationDismissed: jest.fn(async () => false),
  saveHelpOrientationDismissed: jest.fn(async () => true),
}));
jest.mock("@/utils/helpApi", () => ({
  fetchHelpRecords: jest.fn(async (audience: "general" | "admin") => ({
    schemaVersion: "1.0",
    contentVersion: "1.0.0",
    audience,
    records: [{
      id: audience === "admin" ? "help.admin" : "help.general",
      audience,
      workflow: audience === "admin" ? "admin-workflow" : "general-workflow",
      title: audience === "admin" ? "Admin workflow" : "Search workflow",
      summary: "A tested Help record.",
      body: "Follow the guide.",
      prerequisites: ["An approved account"],
      steps: ["Open the workflow"],
      outcomes: ["The workflow completes"],
      recovery: ["Retry"],
      limitations: ["Offline data may be old"],
      revision: { contentVersion: "1.0.0", revisedAt: "2026-09-01", source: "verified-product-workflow" },
    }],
  })),
  askHelpQuestion: jest.fn(),
  HelpApiError: class HelpApiError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

jest.mock("@clerk/expo", () => ({
  useAuth: () => mockAuth,
}));

import HelpScreen from "@/app/(tabs)/help";
import { readCachedGeneralHelp, readHelpOrientationDismissed, saveHelpOrientationDismissed } from "@/utils/helpStorage";
import { askHelpQuestion, fetchHelpRecords, HelpApiError } from "@/utils/helpApi";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Help screen", () => {
  const expectedErrorTitles: Record<HelpErrorCode, string> = {
    HELP_UNSUPPORTED: "That topic is outside Help",
    HELP_RATE_LIMITED: "Help is receiving a lot of questions",
    HELP_AUTHORIZATION_UNAVAILABLE: "Help assistant unavailable",
    HELP_TIMEOUT: "Help took too long to respond",
    HELP_PROVIDER_UNAVAILABLE: "Help assistant unavailable",
    HELP_PROVIDER_RATE_LIMITED: "Help is receiving a lot of questions",
    HELP_INVALID_REQUEST: "Help assistant unavailable",
  };

  beforeEach(() => {
    mockApp.isAdmin = false;
    mockAuth.userId = "worker-1";
    jest.clearAllMocks();
    (readCachedGeneralHelp as jest.Mock).mockImplementation(async () => null);
    (readHelpOrientationDismissed as jest.Mock).mockImplementation(async () => false);
    (saveHelpOrientationDismissed as jest.Mock).mockImplementation(async () => true);
    (askHelpQuestion as jest.Mock).mockResolvedValue("Open the Search tab and follow the guide.");
  });

  it("exposes an accessible, non-blocking intro that can be dismissed and reopened", async () => {
    const result = await render(<HelpScreen />);
    await settle();

    expect(result.getByText("Start here")).toBeTruthy();
    const dismiss = result.getByLabelText("Dismiss Help introduction");
    await act(async () => fireEvent.press(dismiss));
    expect(saveHelpOrientationDismissed).toHaveBeenCalledTimes(1);
    expect(result.queryByText("Start here")).toBeNull();

    await act(async () => fireEvent.press(result.getByLabelText("Show Help introduction")));
    expect(result.getByText("Start here")).toBeTruthy();
  });

  it("does not request admin content for a worker", async () => {
    await render(<HelpScreen />);
    await settle();
    expect(fetchHelpRecords).toHaveBeenCalledWith("general", expect.any(AbortSignal));
    expect(fetchHelpRecords).not.toHaveBeenCalledWith("admin", expect.anything());
  });

  it("labels cached general Help as offline and keeps a retry path", async () => {
    (fetchHelpRecords as jest.Mock).mockRejectedValueOnce(new Error("network unavailable"));
    (readCachedGeneralHelp as jest.Mock).mockResolvedValueOnce({
      schemaVersion: "1.0",
      contentVersion: "1.0.0",
      audience: "general",
      records: [{
        id: "help.cached",
        audience: "general",
        workflow: "cached-workflow",
        title: "Cached workflow",
        summary: "Recently cached Help.",
        body: "Follow the cached guide.",
        prerequisites: ["An approved account"],
        steps: ["Open the workflow"],
        outcomes: ["The workflow completes"],
        recovery: ["Retry when online"],
        limitations: ["This content may be old"],
        revision: { contentVersion: "1.0.0", revisedAt: "2026-09-01", source: "verified-product-workflow" },
      }],
    });
    const result = await render(<HelpScreen />);
    await settle();

    expect(result.getByText("You’re offline — showing recently cached Help.")).toBeTruthy();
    expect(result.getByText("Cached workflow")).toBeTruthy();
    expect(result.getByLabelText("Retry Help content")).toBeTruthy();
  });

  it("shows a retryable failure instead of an empty success state on a clean first run", async () => {
    (fetchHelpRecords as jest.Mock).mockRejectedValueOnce(new Error("network unavailable"));
    const result = await render(<HelpScreen />);
    await settle();

    expect(result.getByText("Help is unavailable")).toBeTruthy();
    expect(result.getByText("Help content could not be loaded. Check your connection and retry.")).toBeTruthy();
    expect(result.getByText("Retry Help")).toBeTruthy();
    expect(result.queryByText("Using Parts ID")).toBeNull();
  });

  it("keeps general Help usable and exposes a retry when admin content fails", async () => {
    mockApp.isAdmin = true;
    (fetchHelpRecords as jest.Mock).mockImplementation(async (audience: "general" | "admin") => {
      if (audience === "admin") {
        throw new HelpApiError(HELP_ERROR_CODE.AUTHORIZATION_UNAVAILABLE, "Admin authorization expired.", 403);
      }
      return {
        schemaVersion: "1.0",
        contentVersion: "1.0.0",
        audience,
        records: [{
          id: "help.general",
          audience,
          workflow: "general-workflow",
          title: "Search workflow",
          summary: "A tested Help record.",
          body: "Follow the guide.",
          prerequisites: ["An approved account"],
          steps: ["Open the workflow"],
          outcomes: ["The workflow completes"],
          recovery: ["Retry"],
          limitations: ["Offline data may be old"],
          revision: { contentVersion: "1.0.0", revisedAt: "2026-09-01", source: "verified-product-workflow" },
        }],
      };
    });
    const result = await render(<HelpScreen />);
    await settle();

    expect(result.getByText("Search workflow")).toBeTruthy();
    expect(result.getByText("Administrator guidance needs authorization")).toBeTruthy();
    expect(result.getByText("Your admin session could not be verified. Retry after your connection or session recovers.")).toBeTruthy();
    await act(async () => fireEvent.press(result.getByLabelText("Retry administrator guidance")));
    await settle();
    expect(fetchHelpRecords).toHaveBeenCalledWith("admin", expect.any(AbortSignal));
  });

  it("keeps the intro visible and offers a retry when its preference cannot be saved", async () => {
    (saveHelpOrientationDismissed as jest.Mock).mockResolvedValueOnce(false);
    const result = await render(<HelpScreen />);
    await settle();

    await act(async () => fireEvent.press(result.getByLabelText("Dismiss Help introduction")));
    await settle();

    expect(result.getByText("Start here")).toBeTruthy();
    expect(result.getByText("Your intro preference could not be saved. Keep it open and try again.")).toBeTruthy();
    expect(result.getByLabelText("Retry saving Help introduction")).toBeTruthy();
    expect(result.getByText("Retry save")).toBeTruthy();
  });

  it("resets account-scoped intro state when the signed-in user changes", async () => {
    (readHelpOrientationDismissed as jest.Mock).mockImplementation(async (userId: string) => userId === "worker-1");
    const result = await render(<HelpScreen />);
    await settle();
    expect(result.queryByText("Start here")).toBeNull();

    mockAuth.userId = "worker-2";
    await result.rerender(<HelpScreen />);
    await settle();

    expect(result.getByText("Start here")).toBeTruthy();
  });

  it("clears the privileged section when the live role is lost", async () => {
    mockApp.isAdmin = true;
    const result = await render(<HelpScreen />);
    await settle();
    expect(result.getByText("Administrator guidance")).toBeTruthy();

    mockApp.isAdmin = false;
    await result.rerender(<HelpScreen />);
    await settle();
    expect(result.queryByText("Administrator guidance")).toBeNull();
    expect(result.queryByText("Admin workflow")).toBeNull();
  });

  it.each(HELP_ERROR_CODES)("shows recovery controls for %s", async (code) => {
    (askHelpQuestion as jest.Mock).mockRejectedValueOnce(new HelpApiError(code, "The assistant could not answer."));
    const result = await render(<HelpScreen />);
    await settle();
    await act(async () => fireEvent.changeText(result.getByLabelText("Ask a Help question"), "How do I search?"));
    await act(async () => fireEvent.press(result.getByLabelText("Send Help question")));
    await settle();

    expect(result.getByText(expectedErrorTitles[code])).toBeTruthy();
    expect(result.getByText("Retry")).toBeTruthy();
    expect(result.getByText("Contact support")).toBeTruthy();
  });

  it("keeps completed context and hides provider details when a later question fails", async () => {
    (askHelpQuestion as jest.Mock)
      .mockResolvedValueOnce("Open the Search tab.")
      .mockRejectedValueOnce(new HelpApiError(
        "HELP_PROVIDER_UNAVAILABLE",
        "provider secret and hidden prompt",
      ));
    const result = await render(<HelpScreen />);
    await settle();

    await act(async () => fireEvent.changeText(result.getByLabelText("Ask a Help question"), "How do I search?"));
    await act(async () => fireEvent.press(result.getByLabelText("Send Help question")));
    await settle();
    expect(result.getByText("Open the Search tab.")).toBeTruthy();

    await act(async () => fireEvent.changeText(result.getByLabelText("Ask a Help question"), "Why is this unavailable?"));
    await act(async () => fireEvent.press(result.getByLabelText("Send Help question")));
    await settle();

    expect(result.getByText("Open the Search tab.")).toBeTruthy();
    expect(result.getByText("Check your connection and try again. Contact support if the provider is unavailable.")).toBeTruthy();
    expect(result.queryByText("provider secret and hidden prompt")).toBeNull();
    expect(result.getByRole("alert")).toBeTruthy();
  });

  it("cancels an in-flight question without leaving a spinner or discarding context", async () => {
    let resolveRequest!: (answer: string) => void;
    (askHelpQuestion as jest.Mock).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveRequest = resolve; }),
    );
    const result = await render(<HelpScreen />);
    await settle();

    await act(async () => fireEvent.changeText(result.getByLabelText("Ask a Help question"), "How do I search?"));
    await act(async () => fireEvent.press(result.getByLabelText("Send Help question")));
    expect(result.getByLabelText("Cancel Help question")).toBeTruthy();

    await act(async () => fireEvent.press(result.getByLabelText("Cancel Help question")));
    expect(result.queryByText("Checking the Help guide…")).toBeNull();
    expect(result.queryByLabelText("Cancel Help question")).toBeNull();

    await act(async () => resolveRequest("late answer"));
    await settle();
    expect(result.queryByText("late answer")).toBeNull();
  });

  it("passes only the failed question into the contact handoff", async () => {
    (askHelpQuestion as jest.Mock).mockRejectedValueOnce(new HelpApiError(
      "HELP_PROVIDER_UNAVAILABLE",
      "provider secret and hidden prompt",
    ));
    const result = await render(<HelpScreen />);
    await settle();

    await act(async () => fireEvent.changeText(result.getByLabelText("Ask a Help question"), "How do I search?"));
    await act(async () => fireEvent.press(result.getByLabelText("Send Help question")));
    await settle();
    await act(async () => fireEvent.press(result.getByText("Contact support")));

    expect(mockContactSheet).toHaveBeenLastCalledWith(expect.objectContaining({
      visible: true,
      initialSubject: "Help assistant question",
      initialBody: "Question for Help assistant:\nHow do I search?",
    }));
    expect(JSON.stringify(mockContactSheet.mock.calls.at(-1))).not.toContain("provider secret");
    expect(JSON.stringify(mockContactSheet.mock.calls.at(-1))).not.toContain("hidden prompt");
  });
});