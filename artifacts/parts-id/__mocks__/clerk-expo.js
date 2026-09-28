const React = require("react");

const UPLOAD_SCREEN_CLERK_HOOKS = ["useAuth", "useClerk"];
const mockGetToken = jest.fn(() => Promise.resolve(null));
const mockSignOut = jest.fn(() => Promise.resolve());
const mockStartSSOFlow = jest.fn(() => Promise.resolve({}));

const mockUseAuth = jest.fn(() => ({
  isSignedIn: false,
  userId: null,
  getToken: mockGetToken,
  signOut: mockSignOut,
}));

const mockUseClerk = jest.fn(() => ({
  signOut: mockSignOut,
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

const mockUseSSO = jest.fn(() => ({
  startSSOFlow: mockStartSSOFlow,
}));

function ClerkProvider({ children }) {
  return React.createElement(React.Fragment, null, children);
}

function ClerkLoaded({ children }) {
  return React.createElement(React.Fragment, null, children);
}

function assertClerkMockContract(
  clerkMock,
  requiredHooks,
  harnessName = "Clerk test",
  contractName = "Clerk",
) {
  const missingHooks = requiredHooks.filter(
    (hookName) => typeof clerkMock?.[hookName] !== "function",
  );

  if (missingHooks.length > 0) {
    throw new Error(
      `[${harnessName}] ${contractName} mock contract is incomplete. ` +
        `Missing hook(s): ${missingHooks.join(", ")}. ` +
        "Use createClerkExpoMock(...) or provide every hook the mounted tree uses.",
    );
  }

  return clerkMock;
}

function assertUploadScreenClerkMock(clerkMock, harnessName = "UploadScreen test") {
  return assertClerkMockContract(
    clerkMock,
    UPLOAD_SCREEN_CLERK_HOOKS,
    harnessName,
    "UploadScreen Clerk",
  );
}

function createClerkExpoMock(overrides = {}) {
  return assertClerkMockContract(
    {
      useAuth: mockUseAuth,
      useClerk: mockUseClerk,
      useSignIn: mockUseSignIn,
      useSignUp: mockUseSignUp,
      useUser: mockUseUser,
      useSSO: mockUseSSO,
      ClerkProvider,
      ClerkLoaded,
      tokenCache: null,
      ...overrides,
    },
    UPLOAD_SCREEN_CLERK_HOOKS,
    "createClerkExpoMock",
  );
}

module.exports = {
  ...createClerkExpoMock(),
  assertClerkMockContract,
  assertUploadScreenClerkMock,
  createClerkExpoMock,
};
