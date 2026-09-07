/**
 * @jest-environment node
 */

const {
  isMetroReadyOutput,
  getMetroStartArgs,
} = require("../scripts/build.js") as {
  isMetroReadyOutput: (output: string) => boolean;
  getMetroStartArgs: (port: number) => string[];
};

describe("isMetroReadyOutput", () => {
  it.each([
    "Waiting on http://localhost:8081",
    "Waiting on http://127.0.0.1:19000",
    "Waiting on http://[::1]:8081",
    "Metro startup complete\nWaiting on https://localhost:8081",
  ])("accepts Expo's explicit startup signal: %s", (output) => {
    expect(isMetroReadyOutput(output)).toBe(true);
  });

  it.each([
    "Starting Metro Bundler",
    "Waiting for http://localhost:8081",
    "Waiting on http://example.com:8081",
    "Metro timeout",
  ])("does not accept unrelated output: %s", (output) => {
    expect(isMetroReadyOutput(output)).toBe(false);
  });
});

describe("getMetroStartArgs", () => {
  it("passes the exact validated port to Expo", () => {
    expect(getMetroStartArgs(19001)).toEqual([
      "exec",
      "expo",
      "start",
      "--no-dev",
      "--minify",
      "--localhost",
      "--port",
      "19001",
    ]);
  });
});