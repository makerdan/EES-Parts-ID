const {
  assertClerkMockContract,
  assertUploadScreenClerkMock,
  createClerkExpoMock,
} = jest.requireActual("../__mocks__/clerk-expo");

describe("UploadScreen Clerk mock contract", () => {
  it("provides every Clerk hook used by the mounted UploadScreen tree", () => {
    expect(createClerkExpoMock()).toEqual(
      expect.objectContaining({
        useAuth: expect.any(Function),
        useClerk: expect.any(Function),
      }),
    );
  });

  it("reports the missing hook and harness when a local mock drifts", () => {
    expect(() =>
      assertUploadScreenClerkMock(
        { useAuth: jest.fn() },
        "driftedUploadHarness",
      ),
    ).toThrow(
      "[driftedUploadHarness] UploadScreen Clerk mock contract is incomplete. " +
        "Missing hook(s): useClerk.",
    );
  });

  it("reports named missing hooks for specialized rendered-screen contracts", () => {
    expect(() =>
      assertClerkMockContract(
        { useAuth: jest.fn() },
        ["useAuth", "useClerk", "useSSO"],
        "oauthButtonsResilience",
      ),
    ).toThrow(
      "[oauthButtonsResilience] Clerk mock contract is incomplete. " +
        "Missing hook(s): useClerk, useSSO.",
    );
  });

  it("includes OAuth hooks in the shared default factory for per-suite overrides", () => {
    expect(createClerkExpoMock()).toEqual(
      expect.objectContaining({
        useAuth: expect.any(Function),
        useClerk: expect.any(Function),
        useSSO: expect.any(Function),
      }),
    );
  });
});