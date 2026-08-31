// React 19 requires this flag for act() to flush layout-driven updates.
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, render } from "@testing-library/react-native";

jest.mock("react-native-reanimated", () =>
  require("./helpers/mapMocks").createReanimatedMock(),
);

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  function makeChainable() {
    const obj: Record<string, (...args: unknown[]) => typeof obj> = {};
    [
      "onBegin", "onUpdate", "onEnd", "onFinalize",
      "onTouchesDown", "onTouchesUp", "onTouchesCancelled", "onTouchesMoved",
      "minDistance", "maxDistance", "minPointers", "maxPointers",
      "averageTouches", "enableTrackpadTwoFingerGesture",
      "simultaneousWithExternalGesture", "requireExternalGestureToFail",
      "blocksExternalGesture", "withTestId", "enabled",
      "shouldCancelWhenOutside", "hitSlop", "activeCursor",
      "runOnJS", "manualActivation", "numberOfTaps", "maxDuration",
      "maxDelay", "minNumberOfPointers",
    ].forEach((method) => { obj[method] = () => obj; });
    return obj;
  }
  return {
    Gesture: {
      Pan: makeChainable,
      Pinch: makeChainable,
      Tap: makeChainable,
      LongPress: makeChainable,
      Simultaneous: () => makeChainable(),
      Exclusive: () => makeChainable(),
      Race: () => makeChainable(),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

jest.mock("react-native-svg", () =>
  require("./helpers/mapMocks").createSvgMock(),
);
jest.mock("@expo/vector-icons", () =>
  require("./helpers/mapMocks").createVectorIconsMock(),
);
jest.mock("expo-asset", () =>
  require("./helpers/mapMocks").createExpoAssetMock(),
);
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
  },
}));
jest.mock("@/hooks/useColors", () =>
  require("./helpers/mapMocks").createUseColorsMock(),
);
jest.mock("@/utils/apiBase", () => ({ API_BASE: "" }));
jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: jest.fn(() => Promise.resolve({ ok: false })),
  setAuthTokenGetter: jest.fn(),
  onUnauthorized: jest.fn(),
}));
jest.mock("@/utils/floorPlan", () => ({
  warmupTiles: jest.fn(() => Promise.resolve()),
  tileApiUrl: jest.fn(() => ""),
}));
jest.mock("@/utils/tilePyramidCache", () => ({
  cleanStaleCacheDirs: jest.fn(() => Promise.resolve()),
  fetchTile: jest.fn(() => Promise.resolve("")),
  prefetchZoomLevel: jest.fn(() => Promise.resolve()),
}));

const WEB_SCENE_XML =
  '<svg viewBox="100 200 5000 3000"><path id="floor-plan" d="M100 200H5100V3200Z"/></svg>';
const WEB_SCENE_CACHE = {
  xml: WEB_SCENE_XML,
  innerXml: '<path id="floor-plan" d="M100 200H5100V3200Z"/>',
  uri: "",
  contentViewBox: { x: 100, y: 200, w: 5000, h: 3000 },
};
jest.mock("@/utils/floorPlanCache", () => ({
  getCachedData: jest.fn(() => WEB_SCENE_CACHE),
  getCachedHash: jest.fn(() => "web-scene-hash"),
  hasCachedData: jest.fn(() => true),
  getIfValid: jest.fn(() => WEB_SCENE_CACHE),
  initPersistRead: jest.fn(() => Promise.resolve()),
  resetForServerUpdate: jest.fn(),
  setCached: jest.fn(),
  setFallbackEmpty: jest.fn(),
}));

import { WarehouseMapView } from "@/components/WarehouseMapView";
import {
  createWebSvgScene,
  normalizeSvgViewBoxOrigin,
  sizeSvgRoot,
} from "@/utils/webSvgScene";

describe("web SVG scene contract", () => {
  it("keeps a zero-origin viewBox and exposes the shared frame", () => {
    const scene = createWebSvgScene(
      '<svg viewBox="0 0 6000 4000"><rect id="valid-floor" x="10" y="20" width="30" height="40"/></svg>',
      390,
      260,
    );

    expect(scene.contentViewBox).toEqual({ x: 0, y: 0, w: 6000, h: 4000 });
    expect(scene.normalizedViewBox).toEqual({ x: 0, y: 0, w: 6000, h: 4000 });
    expect(scene.viewBox).toBe("0 0 6000 4000");
    expect(scene.renderWidth).toBe(390);
    expect(scene.renderHeight).toBe(260);
    expect(scene.svgMarkup).toContain('viewBox="0 0 6000 4000"');
    expect(scene.svgMarkup).toContain('id="valid-floor"');
  });

  it("normalizes a non-zero origin without changing artwork coordinates", () => {
    const source =
      '<svg viewBox="100 200 5000 3000"><path id="warehouse-outline" d="M100 200H5100V3200Z"/></svg>';
    const normalized = normalizeSvgViewBoxOrigin(source);

    expect(normalized).toContain('viewBox="0 0 5000 3000"');
    expect(normalized).toContain('d="M100 200H5100V3200Z"');
    expect(normalized).not.toContain('viewBox="100 200 5000 3000"');

    const scene = createWebSvgScene(source, 500, 300);
    expect(scene.viewBox).toBe("0 0 5000 3000");
    expect(scene.contentViewBox).toEqual({ x: 100, y: 200, w: 5000, h: 3000 });
    expect(scene.normalizedViewBox).toEqual({ x: 0, y: 0, w: 5000, h: 3000 });
    expect(scene.svgMarkup).toContain('viewBox="0 0 5000 3000"');
  });

  it("rewrites existing dimensions and adds missing dimensions", () => {
    expect(
      sizeSvgRoot(
        '<svg viewBox="0 0 100 50" width="100%" height="50"><rect/></svg>',
        800,
        400,
      ),
    ).toContain('<svg viewBox="0 0 100 50" width="800" height="400">');

    expect(
      sizeSvgRoot('<svg viewBox="0 0 100 50"><rect/></svg>', 800, 400),
    ).toContain('<svg viewBox="0 0 100 50" width="800" height="400">');
  });

  it("removes unsafe markup and URI values while preserving valid SVG", () => {
    const unsafe =
      '<svg viewBox="0 0 100 50" onload="alert(1)">' +
      '<script>alert(2)</script>' +
      '<foreignObject><div>bad</div></foreignObject>' +
      '<rect id="valid-rect" width="10" height="10" onclick="alert(3)"/>' +
      '<a href="javascript:alert(4)"><path id="valid-path" d="M0 0"/></a>' +
      '<image href="data:text/html,bad"/>' +
      '</svg>';

    const safe = createWebSvgScene(unsafe, 200, 100).svgMarkup;

    expect(safe).toContain('id="valid-rect"');
    expect(safe).toContain('id="valid-path"');
    expect(safe).not.toMatch(/<script\b/i);
    expect(safe).not.toMatch(/foreignObject/i);
    expect(safe).not.toMatch(/\bonload\s*=/i);
    expect(safe).not.toMatch(/\bonclick\s*=/i);
    expect(safe).not.toMatch(/javascript:/i);
    expect(safe).not.toMatch(/data:text\/html/i);
  });
});

describe("WarehouseMapView — unified web floor-plan scene", () => {
  const zone = {
    id: 7,
    aisleId: "7",
    sectionNum: 0,
    isInventory: true,
    svgX: 240,
    svgY: 360,
    svgWidth: 300,
    svgHeight: 240,
    sortOrder: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  const originalPlatform = require("react-native").Platform.OS;

  beforeEach(() => {
    require("react-native").Platform.OS = "web";
  });

  afterEach(() => {
    require("react-native").Platform.OS = originalPlatform;
  });

  it("renders the floor plan and zones under one normalized SVG viewport", async () => {
    const result = await render(
      <WarehouseMapView
        zones={[zone]}
        zonesLoading={false}
        zonesError={false}
        onZonesRetry={jest.fn()}
        onZoneTap={jest.fn()}
        zoneAlignment={{ translateX: 12, translateY: -8, scale: 1.1 }}
        anchorTransform="matrix(1 0 0 1 4 6)"
      />,
    );

    const layoutNodes = result.root!.queryAll(
      (node) => typeof node.props.onLayout === "function",
      { includeSelf: true },
    );
    expect(layoutNodes.length).toBeGreaterThan(0);
    await act(async () => {
      layoutNodes[0]!.props.onLayout({
        nativeEvent: { layout: { width: 500, height: 800 } },
      });
    });

    const scenes = result.root!.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    );
    expect(scenes).toHaveLength(1);
    const scene = scenes[0]!;
    expect(scene.props.viewBox).toBe("0 0 5000 3000");
    expect(scene.props.width).toBe(500);
    expect(scene.props.height).toBe(300);

    const floorGroups = scene.queryAll(
      (node) =>
        node.type === "g" &&
        node.props.dangerouslySetInnerHTML !== undefined,
      { includeSelf: true },
    );
    expect(floorGroups).toHaveLength(1);
    expect(
      floorGroups[0]!.props.dangerouslySetInnerHTML.__html,
    ).toContain('id="floor-plan"');

    // The overlay rect is a descendant of the same outer SVG scene, not a
    // second surface layered over a separate floor-plan div.
    const zoneRects = scene.queryAll(
      (node) => node.type === "svg-rect",
      { includeSelf: true },
    );
    expect(zoneRects).toHaveLength(1);
    expect(scene.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )).toHaveLength(1);

    await result.unmount();
  });
});