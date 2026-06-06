const mockNetInfo = {
  addEventListener: jest.fn(() => () => {}),
  fetch: jest.fn().mockResolvedValue({ isConnected: true, isInternetReachable: true }),
  useNetInfo: jest.fn(() => ({ isConnected: true, isInternetReachable: true })),
};

module.exports = { ...mockNetInfo, default: mockNetInfo };
