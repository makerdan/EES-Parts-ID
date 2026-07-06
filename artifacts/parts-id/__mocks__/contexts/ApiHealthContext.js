const useApiHealth = jest.fn(() => ({
  status: "ok",
  restarting: false,
  triggerRestart: jest.fn().mockResolvedValue(undefined),
  checkStatus: jest.fn().mockResolvedValue(undefined),
  bots: {},
  probeSingleBot: jest.fn().mockResolvedValue(undefined),
  reportNetworkFailure: jest.fn(),
}));

const ApiHealthProvider = ({ children }) => children;

module.exports = { useApiHealth, ApiHealthProvider };
