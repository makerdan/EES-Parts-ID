// Manual Jest mock for @workspace/integrations-gemini-ai
// Prevents the p-limit/yocto-queue ESM-only crash when jest runs in CJS mode.
const mockAi = {
  models: { generateContent: jest.fn() },
};
const getAiClient = jest.fn(() => mockAi);
const generateImage = jest.fn();
const batchProcess = jest.fn();
const batchProcessWithSSE = jest.fn();
const isRateLimitError = jest.fn(() => false);
module.exports = { ai: mockAi, getAiClient, generateImage, batchProcess, batchProcessWithSSE, isRateLimitError };
