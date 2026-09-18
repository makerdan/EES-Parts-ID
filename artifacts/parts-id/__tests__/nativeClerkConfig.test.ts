import fs from "node:fs";
import path from "node:path";

describe("native Clerk configuration", () => {
  it("keeps the Clerk Expo config plugin enabled for iOS prebuilds", () => {
    const appConfig = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../app.json"), "utf8"),
    ) as { expo?: { plugins?: Array<string | [string, Record<string, unknown>]> } };
    const pluginNames = (appConfig.expo?.plugins ?? []).map((plugin) =>
      typeof plugin === "string" ? plugin : plugin[0],
    );

    expect(pluginNames).toContain("@clerk/expo");
  });
});