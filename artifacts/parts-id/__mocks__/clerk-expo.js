const React = require("react");

const UPLOAD_SCREEN_CLERK_HOOKS = ["useAuth", "useClerk"];

const mockUseAuth = jest.fn(() => ({
  isSignedIn: false,
  userId: null,
  getToken: jest.fn(() => Promise.resolve(null)),
  signOut: jest.fn(() => Promise.resolve()),
}));

const mockUseClerk = jest.fn(() => ({
  signOut: jest.fn(() => Promise.resolve()),
}));

const mockUseSignIn = jest.fn(() => ({
  signIn: {
    password: jest.fn(() => Promise.resolve({ error: null })),
    status: "idle",
    finalize: jest.fn(() => Promise.resolve()),
    reset: jest.fn(() => Promise.resolve()),
    mfa: {
      sendEmailCode: jest.fn(() => Promise.resolve()),
      verifyEmailCode: jest.fn(() => Promise.resolve()),
    },
    supportedSecondFactors: [],
  },
  errors: { fields: {} },
  fetchStatus: "idle",
}));

const mockUseSignUp = jest.fn(() => ({
  signUp: {
    password: jest.fn(() => Promise.resolve({ error: null })),
    status: "idle",
    finalize: jest.fn(() => Promise.resolve()),
    reset: jest.fn(() => Promise.resolve()),
    unverifiedFields: [],
    missingFields: [],
    verifications: {
      sendEmailCode: jest.fn(() => Promise.resolve()),
      verifyEmailCode: jest.fn(() => Promise.resolve()),
    },
  },
  errors: { fields: {} },
  fetchStatus: "idle",
}));

const mockUseUser = jest.fn(() => ({
  user: null,
  isLoaded: true,
}));

function ClerkProvider({ children }) {
  return React.createElement(React.Fragment, null, children);
}

function ClerkLoaded({ children }) {
  return React.createElement(React.Fragment, null, children);
}

function assertUploadScreenClerkMock(clerkMock, harnessName = "UploadScreen test") {
  const missingHooks = UPLOAD_SCREEN_CLERK_HOOKS.filter(
    (hookName) => typeof clerkMock?.[hookName] !== "function",
  );

  if (missingHooks.length > 0) {
    throw new Error(
      `[${harnessName}] UploadScreen Clerk mock contract is incomplete. ` +
        `Missing hook(s): ${missingHooks.join(", ")}. ` +
        "Use createClerkExpoMock(...) or provide every hook the mounted UploadScreen tree uses.",
    );
  }

  return clerkMock;
}

function createClerkExpoMock(overrides = {}) {
  return assertUploadScreenClerkMock(
    {
      useAuth: mockUseAuth,
      useClerk: mockUseClerk,
      useSignIn: mockUseSignIn,
      useSignUp: mockUseSignUp,
      useUser: mockUseUser,
      ClerkProvider,
      ClerkLoaded,
      tokenCache: null,
      ...overrides,
    },
    "createClerkExpoMock",
  );
}

module.exports = {
  ...createClerkExpoMock(),
  assertUploadScreenClerkMock,
  createClerkExpoMock,
};
