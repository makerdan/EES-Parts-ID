// CJS mock stub for @workspace/integrations-gemini-ai.
// Used by jest.config.cjs moduleNameMapper to prevent the p-limit ESM crash.
const mockAi = {
  models: {
    generateContent: jest.fn(),
  },
};
const getAiClient = jest.fn(() => mockAi);
const generateImage = jest.fn();
const batchProcess = jest.fn();
const batchProcessWithSSE = jest.fn();
const isRateLimitError = jest.fn(() => false);

module.exports = { ai: mockAi, getAiClient, generateImage, batchProcess, batchProcessWithSSE, isRateLimitError };
