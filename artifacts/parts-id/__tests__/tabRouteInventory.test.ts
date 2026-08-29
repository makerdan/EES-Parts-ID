import { existsSync, readFileSync } from "fs";
import { join } from "path";

const tabsDir = join(__dirname, "..", "app", "(tabs)");
const tabLayout = readFileSync(join(tabsDir, "_layout.tsx"), "utf8");

describe("tab route inventory", () => {
  it("keeps the primary Map tab while excluding the removed Map2 route", () => {
    expect(tabLayout).toMatch(/name\s*=\s*"map"/);
    expect(tabLayout).not.toMatch(/name\s*=\s*"map2"/i);
    expect(tabLayout).not.toMatch(/title\s*:\s*"map2"/i);
    expect(existsSync(join(tabsDir, "map.tsx"))).toBe(true);
    expect(existsSync(join(tabsDir, "map2.tsx"))).toBe(false);
  });
});