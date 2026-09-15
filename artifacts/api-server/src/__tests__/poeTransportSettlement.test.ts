const mockCreate = jest.fn();

jest.mock("openai", () => {
  const OpenAI = jest.fn(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  return { __esModule: true, default: OpenAI };
});

describe("Poe transport settlement ownership", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    mockCreate.mockReset();
    process.env.POE_API_KEY2 = "test-poe-key";
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps transport settlement pending after the response timeout", async () => {
    let resolveTransport!: (value: unknown) => void;
    mockCreate.mockImplementation(
      () => new Promise((resolve) => {
        resolveTransport = resolve;
      }),
    );
    const {
      createPoeChatCompletionWithSettlement,
      resetPoeClient,
    } = await import("@workspace/integrations-poe-server");
    resetPoeClient();

    const handle = createPoeChatCompletionWithSettlement(
      {
        model: "Claude-Sonnet-4.5",
        messages: [{ role: "user", content: "hi" }],
      },
      { timeoutMs: 10 },
    );
    let transportSettled = false;
    void handle.transportSettled.then(() => {
      transportSettled = true;
    });

    const responseOutcome = handle.response.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(10);
    expect((await responseOutcome) as { kind?: string }).toEqual(
      expect.objectContaining({ kind: "timeout" }),
    );
    expect(transportSettled).toBe(false);

    resolveTransport({ choices: [] });
    await handle.transportSettled;
    expect(transportSettled).toBe(true);
  });

  it("rejects unregistered models before creating the Poe client request", async () => {
    const {
      createPoeChatCompletion,
      createPoeChatCompletionWithSettlement,
      resetPoeClient,
    } = await import("@workspace/integrations-poe-server");
    resetPoeClient();

    await expect(createPoeChatCompletion({
      model: "not-registered",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toMatchObject({ kind: "invalid_request", status: 400 });

    const handle = createPoeChatCompletionWithSettlement({
      model: "not-registered",
      messages: [{ role: "user", content: "hi" }],
    });
    await expect(handle.response).rejects.toMatchObject({ kind: "invalid_request", status: 400 });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});