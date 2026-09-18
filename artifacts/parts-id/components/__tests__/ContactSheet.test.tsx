(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, render } from "@testing-library/react-native";
import { TextInput, View } from "react-native";

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));
jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#111",
    muted: "#eee",
    mutedForeground: "#666",
    border: "#ccc",
    primary: "#f59e0b",
    primaryForeground: "#fff",
    destructive: "#ef4444",
    success: "#10b981",
    warning: "#f59e0b",
  }),
}));
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001/api" }));
jest.mock("@/utils/appAuth", () => ({ fetchWithAuth: jest.fn() }));
jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/components/KeyboardAwareScrollViewCompat", () => ({
  KeyboardAwareScrollViewCompat: ({ children }: { children: React.ReactNode }) => (
    <View>{children}</View>
  ),
}));
jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: (props: React.ComponentProps<typeof TextInput>) => <TextInput {...props} />,
}));

import AsyncStorage from "@react-native-async-storage/async-storage";

import { ContactSheet } from "@/components/ContactSheet";
import { fetchWithAuth } from "@/utils/appAuth";

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const fetchMock = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

function response(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function change(result: Awaited<ReturnType<typeof render>>, label: string, value: string) {
  await act(async () => {
    result.getByLabelText(label).props.onChangeText(value);
  });
}

async function press(result: Awaited<ReturnType<typeof render>>, label: string) {
  await act(async () => {
    void result.getByLabelText(label).props.onPress();
    await Promise.resolve();
  });
}

describe("ContactSheet", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);
  });

  it("keeps entered text when the form is dismissed", async () => {
    const onClose = jest.fn();
    const result = await render(
      <ContactSheet visible onClose={onClose} senderToken="test-sender" />,
    );

    await settle();
    await change(result, "Contact subject", "Scanner issue");
    await change(result, "Contact message", "The scanner needs help.");
    await press(result, "Close Contact");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.getByLabelText("Contact subject")).toHaveProp("value", "Scanner issue");
    expect(result.getByLabelText("Contact message")).toHaveProp("value", "The scanner needs help.");
  });

  it("shows specific validation before making a request", async () => {
    const result = await render(
      <ContactSheet visible onClose={jest.fn()} senderToken="test-sender" />,
    );

    await settle();
    await press(result, "Send Contact message");

    expect(result.getByText("Enter a subject.")).toBeTruthy();
    expect(result.getByText("Enter a message.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the draft after a rate limit and confirms one successful retry", async () => {
    const onClose = jest.fn();
    fetchMock
      .mockResolvedValueOnce(response(429, { error: "Too many requests", retryAfterMs: 7_000 }))
      .mockResolvedValueOnce(response(201, { id: 42 }));
    const result = await render(
      <ContactSheet visible onClose={onClose} senderToken="test-sender" />,
    );

    await settle();
    await change(result, "Contact subject", "Rate limit");
    await change(result, "Contact message", "Please retry this.");
    await press(result, "Send Contact message");
    await settle();

    expect(result.getByText(/Support is receiving a lot of messages/)).toBeTruthy();
    expect(result.getByLabelText("Contact subject")).toHaveProp("value", "Rate limit");
    expect(result.getByLabelText("Contact message")).toHaveProp("value", "Please retry this.");

    await press(result, "Send Contact message");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.getByText("Message sent to support")).toBeTruthy();
    expect(result.getByText("Reference #42")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not duplicate a request while the first send is pending", async () => {
    let resolveRequest!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const result = await render(
      <ContactSheet visible onClose={jest.fn()} senderToken="test-sender" />,
    );

    await settle();
    await change(result, "Contact subject", "One request");
    await change(result, "Contact message", "Do not duplicate.");
    await act(async () => {
      void result.getByLabelText("Send Contact message").props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      void result.getByLabelText("Send Contact message").props.onPress();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveRequest(response(201, { id: 43 }));
    await settle();
    expect(result.getByText("Message sent to support")).toBeTruthy();
  });

  it("explains offline failures and leaves the form retryable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network request failed"));
    const result = await render(
      <ContactSheet visible onClose={jest.fn()} senderToken="test-sender" />,
    );

    await settle();
    await change(result, "Contact subject", "Offline");
    await change(result, "Contact message", "Keep this draft.");
    await press(result, "Send Contact message");
    await settle();

    expect(result.getByText(/You appear to be offline/)).toBeTruthy();
    expect(result.getByLabelText("Contact subject")).toHaveProp("value", "Offline");
    expect(result.getByLabelText("Contact message")).toHaveProp("value", "Keep this draft.");
  });
});