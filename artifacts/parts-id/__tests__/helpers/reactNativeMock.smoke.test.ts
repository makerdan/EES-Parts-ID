/**
 * Smoke test for the canonical react-native mock.
 *
 * Every Parts ID source file and native test import is scanned for runtime
 * named imports from react-native. If a component or test starts using a
 * native export that is missing from __mocks__/react-native.js, this test
 * fails at the mock boundary instead of allowing a mounted component to crash
 * before its assertions run.
 */

import * as fs from "fs";
import * as path from "path";
import type * as React from "react";

const ARTIFACT_ROOT = path.resolve(__dirname, "../..");
const NATIVE_MOCK_PATH = path.resolve(ARTIFACT_ROOT, "__mocks__/react-native.js");
const IGNORED_DIRS = new Set([
  "node_modules",
  "__mocks__",
  ".expo",
  "dist",
  "build",
  "coverage",
]);

// These legacy imports are used only as TypeScript annotations in source
// files. They are erased from the runtime bundle and therefore do not belong
// in a JavaScript mock contract.
const TYPE_ONLY_NATIVE_EXPORTS = new Set([
  "AppStateStatus",
  "LayoutChangeEvent",
  "ScrollViewProps",
]);

type NativeMock = Record<string, unknown>;

const REQUIRED_CALLABLE_NATIVE_APIS = [
  "Alert.alert",
  "Animated.Value",
  "Animated.Value.prototype.interpolate",
  "Animated.Value.prototype.setValue",
  "Animated.createAnimatedComponent",
  "Animated.loop",
  "Animated.parallel",
  "Animated.sequence",
  "Animated.spring",
  "Animated.timing",
  "Appearance.addChangeListener",
  "Appearance.getColorScheme",
  "Appearance.setColorScheme",
  "AppState.addEventListener",
  "BackHandler.addEventListener",
  "Dimensions.addEventListener",
  "Dimensions.get",
  "Easing.in",
  "Easing.inOut",
  "Easing.linear",
  "Easing.out",
  "Keyboard.addListener",
  "Keyboard.dismiss",
  "LayoutAnimation.configureNext",
  "Linking.addEventListener",
  "Linking.canOpenURL",
  "Linking.getInitialURL",
  "Linking.openSettings",
  "Linking.openURL",
  "PanResponder.create",
  "PixelRatio.get",
  "PixelRatio.roundToNearestPixel",
  "Platform.select",
  "Share.share",
  "StatusBar.setBackgroundColor",
  "StatusBar.setBarStyle",
  "StatusBar.setHidden",
  "StatusBar.setTranslucent",
  "StyleSheet.create",
  "StyleSheet.flatten",
  "UIManager.getViewManagerConfig",
  "UIManager.setLayoutAnimationEnabledExperimental",
] as const;

const REQUIRED_DEFINED_NATIVE_APIS = [
  "Animated.View",
  "LayoutAnimation.Presets.easeInEaseOut",
  "Platform.OS",
  "StyleSheet.absoluteFill",
  "StyleSheet.absoluteFillObject",
  "StyleSheet.hairlineWidth",
] as const;

function getApiPath(nativeMock: NativeMock, apiPath: string): unknown {
  let value: unknown = nativeMock;
  for (const segment of apiPath.split(".")) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function assertNestedNativeContract(nativeMock: NativeMock): void {
  const missing: string[] = [
    ...REQUIRED_CALLABLE_NATIVE_APIS.filter(
      (apiPath) => typeof getApiPath(nativeMock, apiPath) !== "function",
    ),
    ...REQUIRED_DEFINED_NATIVE_APIS.filter(
      (apiPath) => getApiPath(nativeMock, apiPath) === undefined,
    ),
  ];

  const appStateSubscription = (
    getApiPath(nativeMock, "AppState.addEventListener") as
      | ((event: string, listener: () => void) => { remove?: unknown })
      | undefined
  )?.("change", () => {});
  if (typeof appStateSubscription?.remove !== "function") {
    missing.push("AppState.addEventListener(...).remove");
  }

  const animated = nativeMock.Animated as {
    Value: new (value: number) => unknown;
    loop: (animation: unknown) => unknown;
    parallel: (animations: unknown[]) => unknown;
    sequence: (animations: unknown[]) => unknown;
    spring: (value: unknown, config: object) => unknown;
    timing: (value: unknown, config: object) => unknown;
  };
  const animationFactoryNames = [
    "Value",
    "loop",
    "parallel",
    "sequence",
    "spring",
    "timing",
  ] as const;
  if (animationFactoryNames.every((name) => typeof animated?.[name] === "function")) {
    const value = new animated.Value(0);
    const animationFactories = [
      ["Animated.loop(...)", () => animated.loop(animated.timing(value, {}))],
      ["Animated.parallel(...)", () => animated.parallel([animated.spring(value, {})])],
      ["Animated.sequence(...)", () => animated.sequence([animated.timing(value, {})])],
      ["Animated.spring(...)", () => animated.spring(value, {})],
      ["Animated.timing(...)", () => animated.timing(value, {})],
    ] as const;
    for (const [apiPath, createAnimation] of animationFactories) {
      const handle = createAnimation() as Record<string, unknown>;
      for (const method of ["start", "stop", "reset"]) {
        if (typeof handle?.[method] !== "function") {
          missing.push(`${apiPath}.${method}`);
        }
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Canonical react-native mock has missing or invalid nested API path(s): ${missing.sort().join(", ")}`,
    );
  }
}

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, files);
    } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Read named imports without attempting to parse the whole TypeScript AST.
 * Each import declaration is collected line-by-line until its react-native
 * source clause is reached. This deliberately ignores type-only bindings
 * because they do not exist at runtime.
 */
function collectNativeImports(source: string): Set<string> {
  const names = new Set<string>();
  const lines = source.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (!/^\s*import\b/.test(lines[lineIndex] ?? "")) continue;

    let declaration = lines[lineIndex] ?? "";
    while (
      lineIndex + 1 < lines.length &&
      !/;\s*$/.test(declaration) &&
      !/\s+from\s+["'][^"']+["']\s*$/.test(declaration)
    ) {
      declaration += `\n${lines[++lineIndex]}`;
    }

    const match = declaration.match(
      /^\s*import\s+([\s\S]*?)\s+from\s+["']react-native["']\s*;?\s*$/,
    );
    if (!match) continue;
    const clause = match[1] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    const named = clause.match(/\{([\s\S]*)\}/)?.[1] ?? "";
    for (const binding of named.split(",")) {
      const trimmed = binding.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const importedName = (trimmed.split(/\s+as\s+/)[0] ?? trimmed).trim();
      if (!TYPE_ONLY_NATIVE_EXPORTS.has(importedName)) names.add(importedName);
    }
  }

  return names;
}

describe("canonical react-native mock smoke", () => {
  it("exports every runtime named API imported by shipped Parts ID sources", () => {
    const expected = new Set<string>();
    for (const file of collectSourceFiles(ARTIFACT_ROOT)) {
      for (const name of collectNativeImports(fs.readFileSync(file, "utf8"))) {
        expected.add(name);
      }
    }

    const nativeMock = require(NATIVE_MOCK_PATH) as Record<string, unknown>;
    const missing = [...expected].filter((name) => !(name in nativeMock)).sort();

    expect(expected.size).toBeGreaterThan(0);
    if (missing.length > 0) {
      throw new Error(
        `Canonical react-native mock is missing runtime export(s): ${missing.join(", ")}`,
      );
    }
    expect(missing).toEqual([]);
  });

  it("keeps the gesture API callable for components that use PanResponder", () => {
    const nativeMock = require(NATIVE_MOCK_PATH) as {
      PanResponder?: { create?: unknown };
    };

    expect(typeof nativeMock.PanResponder?.create).toBe("function");
  });

  it("provides every nested runtime API used by shipped Parts ID sources", () => {
    const nativeMock = require(NATIVE_MOCK_PATH) as NativeMock;

    expect(() => assertNestedNativeContract(nativeMock)).not.toThrow();
  });

  it("names the missing nested API path in its diagnostic", () => {
    const nativeMock = require(NATIVE_MOCK_PATH) as NativeMock;
    const driftingMock = {
      ...nativeMock,
      Appearance: {
        ...(nativeMock.Appearance as Record<string, unknown>),
        setColorScheme: undefined,
      },
    };

    expect(() => assertNestedNativeContract(driftingMock)).toThrow(
      "Canonical react-native mock has missing or invalid nested API path(s): Appearance.setColorScheme",
    );
  });

  it("rejects non-callable values at callable API paths", () => {
    const nativeMock = require(NATIVE_MOCK_PATH) as NativeMock;
    const driftingMock = {
      ...nativeMock,
      Animated: {
        ...(nativeMock.Animated as Record<string, unknown>),
        parallel: {},
      },
    };

    expect(() => assertNestedNativeContract(driftingMock)).toThrow(
      "Animated.parallel",
    );
  });

  it("preserves Modal callbacks for tests that invoke native close behavior", () => {
    const nativeMock = require(NATIVE_MOCK_PATH) as {
      Modal: (props: Record<string, unknown>) => React.ReactElement;
    };
    const onRequestClose = jest.fn();

    const modal = nativeMock.Modal({
      children: null,
      visible: true,
      onRequestClose,
    });

    expect((modal.props as Record<string, unknown>).onRequestClose).toBe(onRequestClose);
  });

  it("requires every inline react-native factory to start from the canonical mock", () => {
    const driftingFactories: string[] = [];
    for (const file of collectSourceFiles(path.resolve(ARTIFACT_ROOT, "__tests__"))) {
      const source = fs.readFileSync(file, "utf8");
      if (
        /jest\.mock\(\s*["']react-native["']/.test(source) &&
        !source.includes("createReactNativeMock")
      ) {
        driftingFactories.push(path.relative(ARTIFACT_ROOT, file));
      }
    }

    if (driftingFactories.length > 0) {
      throw new Error(
        `Inline react-native mock factories must delegate to createReactNativeMock(): ${driftingFactories.join(", ")}`,
      );
    }
    expect(driftingFactories).toEqual([]);
  });
});
