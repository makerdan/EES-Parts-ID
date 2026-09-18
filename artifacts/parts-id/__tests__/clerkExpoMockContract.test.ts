const {
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
});