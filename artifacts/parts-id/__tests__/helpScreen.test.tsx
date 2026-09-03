(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { HELP_ERROR_CODES, type HelpErrorCode } from "@workspace/api-zod";

const mockApp = {
  isAdmin: false,
  textFontScale: 1,
  registerLogoutHandler: jest.fn(() => () => {}),
};

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => mockApp,
}));
jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@/components/ReferenceModal", () => ({ ReferenceModal: () => null }));
jest.mock("@/components/ContactSheet", () => ({ ContactSheet: () => null }));
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
  saveHelpOrientationDismissed: jest.fn(async () => {}),
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
  useAuth: () => ({ userId: "worker-1" }),
}));

import HelpScreen from "@/app/(tabs)/help";
import { saveHelpOrientationDismissed } from "@/utils/helpStorage";
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
    jest.clearAllMocks();
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
});