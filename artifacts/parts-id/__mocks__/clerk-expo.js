const React = require("react");

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

module.exports = {
  useAuth: mockUseAuth,
  useClerk: mockUseClerk,
  useSignIn: mockUseSignIn,
  useSignUp: mockUseSignUp,
  useUser: mockUseUser,
  ClerkProvider,
  ClerkLoaded,
  tokenCache: null,
};
