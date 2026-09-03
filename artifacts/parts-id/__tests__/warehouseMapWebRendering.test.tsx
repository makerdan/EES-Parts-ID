// React 19 requires this flag for act() to flush layout-driven updates.
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, render } from "@testing-library/react-native";

jest.mock("react-native-reanimated", () =>
  require("./helpers/mapMocks").createReanimatedMockWithPropsCallback(),
);

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  function makeChainable() {
    const obj: Record<string, (...args: Array<unknown>) => typeof obj> = {};
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
      Simultaneous: (..._args: Array<unknown>) => makeChainable(),
      Exclusive: (..._args: Array<unknown>) => makeChainable(),
      Race: (..._args: Array<unknown>) => makeChainable(),
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
const mockAssetLoadAsync = jest.fn();
jest.mock("expo-asset", () => ({
  Asset: {
    fromModule: () => ({ downloadAsync: async () => {}, localUri: "", uri: "" }),
    loadAsync: (...args: Array<unknown>) => mockAssetLoadAsync(...args),
  },
}));
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
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://test.local/api" }));
const mockFetchWithAuth = jest.fn();
jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: (...args: Array<unknown>) => mockFetchWithAuth(...args),
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
  '<svg viewBox="100 200 5000 3000" onload="bad()">' +
  '<script>alert(1)</script>' +
  '<path id="floor-plan" d="M100 200H5100V3200Z"/>' +
  '<foreignObject><div>bad</div></foreignObject>' +
  '</svg>';
const WEB_SCENE_CACHE = {
  xml: WEB_SCENE_XML,
  innerXml:
    '<script>alert(1)</script><path id="floor-plan" d="M100 200H5100V3200Z"/>' +
    '<foreignObject><div>bad</div></foreignObject>',
  uri: "",
  contentViewBox: { x: 100, y: 200, w: 5000, h: 3000 },
};
const HOT_SWAP_XML =
  '<svg viewBox="0 0 6000 4000"><path id="floor-plan-b" d="M0 0H6000V4000Z"/></svg>';
type MockWebCache = typeof WEB_SCENE_CACHE | {
  xml: string;
  innerXml: string;
  uri: string;
  contentViewBox?: { x: number; y: number; w: number; h: number };
} | null;
let mockCache: MockWebCache = WEB_SCENE_CACHE;
let mockCacheHash: string | null = "web-scene-hash";
jest.mock("@/utils/floorPlanCache", () => ({
  getCachedData: jest.fn(() => mockCache),
  getCachedHash: jest.fn(() => mockCacheHash),
  hasCachedData: jest.fn(() => mockCache !== null),
  getIfValid: jest.fn((hash: string) =>
    mockCache !== null && mockCacheHash === hash ? mockCache : null,
  ),
  initPersistRead: jest.fn(() => Promise.resolve()),
  resetForServerUpdate: jest.fn(() => {
    mockCache = null;
    mockCacheHash = null;
  }),
  setCached: jest.fn((hash: string, data: MockWebCache) => {
    mockCache = data;
    mockCacheHash = hash;
  }),
  setFallbackEmpty: jest.fn(() => {
    mockCache = { xml: "", innerXml: "", uri: "" };
    mockCacheHash = null;
  }),
}));

import { WarehouseMapView } from "@/components/WarehouseMapView";
import {
  createWebSvgScene,
  normalizeSvgViewBoxOrigin,
  sizeSvgRoot,
} from "@/utils/webSvgScene";

async function flushPromises(ticks = 12) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

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
    jest.useFakeTimers();
    require("react-native").Platform.OS = "web";
    mockCache = WEB_SCENE_CACHE;
    mockCacheHash = "web-scene-hash";
    mockFetchWithAuth.mockReset();
    mockFetchWithAuth.mockResolvedValue({ ok: false });
    mockAssetLoadAsync.mockReset();
    mockAssetLoadAsync.mockResolvedValue([{ hash: "bundle-hash", localUri: "", uri: "" }]);
  });

  afterEach(() => {
    jest.useRealTimers();
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
    expect(
      floorGroups[0]!.props.dangerouslySetInnerHTML.__html,
    ).not.toMatch(/script|foreignObject|onload/i);

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

  it("does not render unsafe cached markup even though valid floor-plan artwork survives", async () => {
    const result = await render(
      <WarehouseMapView
        zones={[zone]}
        zonesLoading={false}
        zonesError={false}
        onZonesRetry={jest.fn()}
        onZoneTap={jest.fn()}
      />,
    );

    const layoutNode = result.root!.queryAll(
      (node) => typeof node.props.onLayout === "function",
      { includeSelf: true },
    )[0]!;
    await act(async () => {
      layoutNode.props.onLayout({
        nativeEvent: { layout: { width: 500, height: 800 } },
      });
    });

    const scene = result.root!.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )[0]!;
    const floorGroup = scene.queryAll(
      (node) => node.type === "g" && node.props.dangerouslySetInnerHTML !== undefined,
      { includeSelf: true },
    )[0]!;
    const html = floorGroup.props.dangerouslySetInnerHTML.__html as string;

    expect(html).toContain('id="floor-plan"');
    expect(html).not.toMatch(/<script\b|<foreignObject\b|onload\s*=/i);

    await result.unmount();
  });

  it("keeps a zero-origin floor plan and zone overlay in one equal-sized SVG scene", async () => {
    mockCache = {
      xml: '<svg viewBox="0 0 6000 4000"><path id="zero-origin-floor-plan"/></svg>',
      innerXml: '<path id="zero-origin-floor-plan"/>',
      uri: "",
      contentViewBox: { x: 0, y: 0, w: 6000, h: 4000 },
    };
    mockCacheHash = "zero-origin-hash";

    const result = await render(
      <WarehouseMapView
        zones={[zone]}
        zonesLoading={false}
        zonesError={false}
        onZonesRetry={jest.fn()}
        onZoneTap={jest.fn()}
      />,
    );
    const layoutNode = result.root!.queryAll(
      (node) => typeof node.props.onLayout === "function",
      { includeSelf: true },
    )[0]!;
    await act(async () => {
      layoutNode.props.onLayout({
        nativeEvent: { layout: { width: 500, height: 800 } },
      });
    });

    const scene = result.root!.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )[0]!;
    expect(scene.props.viewBox).toBe("0 0 6000 4000");
    expect(scene.props.width).toBe(500);
    expect(scene.props.height).toBe(500 / (6000 / 4000));
    expect(scene.queryAll(
      (node) => node.type === "g" && node.props.dangerouslySetInnerHTML !== undefined,
      { includeSelf: true },
    )[0]!.props.dangerouslySetInnerHTML.__html).toContain("zero-origin-floor-plan");
    expect(scene.queryAll(
      (node) => node.type === "svg-rect",
      { includeSelf: true },
    )).toHaveLength(1);
    expect(scene.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )).toHaveLength(1);

    await result.unmount();
  });

  it("refetches when cached web data has no usable XML instead of leaving the scene blank", async () => {
    mockCache = { xml: "", innerXml: "", uri: "", contentViewBox: { x: 0, y: 0, w: 6000, h: 4000 } };
    mockCacheHash = "empty-cache-hash";
    mockFetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "empty-cache-hash" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "empty-cache-hash" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => HOT_SWAP_XML,
      });

    const result = await render(
      <WarehouseMapView
        zones={[]}
        zonesLoading={false}
        zonesError={false}
        onZonesRetry={jest.fn()}
        onZoneTap={jest.fn()}
      />,
    );
    const layoutNode = result.root!.queryAll(
      (node) => typeof node.props.onLayout === "function",
      { includeSelf: true },
    )[0]!;
    await act(async () => {
      layoutNode.props.onLayout({
        nativeEvent: { layout: { width: 500, height: 800 } },
      });
    });
    await flushPromises(16);

    const scene = result.root!.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )[0]!;
    expect(scene).toBeDefined();
    expect(scene.props.viewBox).toBe("0 0 6000 4000");
    expect(scene.queryAll(
      (node) => node.type === "g" && node.props.dangerouslySetInnerHTML !== undefined,
      { includeSelf: true },
    )[0]!.props.dangerouslySetInnerHTML.__html).toContain("floor-plan-b");
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(3);

    await result.unmount();
  });

  it("keeps the floor plan and overlays under the same pan/zoom transform contract", async () => {
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
    const layoutNode = result.root!.queryAll(
      (node) => typeof node.props.onLayout === "function",
      { includeSelf: true },
    )[0]!;
    await act(async () => {
      layoutNode.props.onLayout({
        nativeEvent: { layout: { width: 500, height: 800 } },
      });
    });

    const scene = result.root!.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )[0]!;
    const floorGroup = scene.queryAll(
      (node) => node.type === "g" && node.props.dangerouslySetInnerHTML !== undefined,
      { includeSelf: true },
    )[0]!;
    const transformedGroups = scene.queryAll(
      (node) => node.type === "svg-g" && typeof node.props.transform === "string",
      { includeSelf: true },
    );
    const animatedMap = result.root!.queryAll(
      (node) => node.type === "rn-reanimated-view",
      { includeSelf: true },
    )[0]!;

    expect(floorGroup.parent?.type).toBe("svg-svg");
    expect(transformedGroups.map((node) => node.props.transform)).toEqual([
      "matrix(1 0 0 1 4 6)",
      "translate(12, -8) scale(1.1)",
    ]);
    const animatedStyle = (animatedMap.props.style as Array<Record<string, unknown>>)
      .find((style) => Array.isArray(style.transform));
    expect(animatedStyle?.transform).toEqual([
      expect.objectContaining({ translateX: expect.any(Number) }),
      expect.objectContaining({ translateY: expect.any(Number) }),
      expect.objectContaining({ scale: expect.any(Number) }),
    ]);
    expect(scene.parent?.type).toBe("rn-reanimated-view");

    await result.unmount();
  });

  it("shows a retry state after server and bundle loads fail, then replaces it with a valid scene on retry", async () => {
    mockCache = null;
    mockCacheHash = null;
    mockFetchWithAuth.mockResolvedValue({ ok: false });
    mockAssetLoadAsync.mockRejectedValue(new Error("bundle unavailable"));

    const result = await render(
      <WarehouseMapView
        zones={[]}
        zonesLoading={false}
        zonesError={false}
        onZonesRetry={jest.fn()}
        onZoneTap={jest.fn()}
      />,
    );
    const layoutNode = result.root!.queryAll(
      (node) => typeof node.props.onLayout === "function",
      { includeSelf: true },
    )[0]!;
    await act(async () => {
      layoutNode.props.onLayout({
        nativeEvent: { layout: { width: 500, height: 800 } },
      });
    });
    await flushPromises();

    expect(result.root!.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )).toHaveLength(0);
    const retry = result.root!.queryAll(
      (node) => node.type === "rn-pressable" &&
        node.props.accessibilityLabel === "Retry loading floor plan",
      { includeSelf: true },
    )[0]!;
    expect(retry).toBeDefined();

    mockFetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "retry-hash" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => HOT_SWAP_XML,
      });
    await act(async () => {
      retry.props.onPress();
    });
    await flushPromises(16);

    const scene = result.root!.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )[0]!;
    expect(scene).toBeDefined();
    expect(scene.props.viewBox).toBe("0 0 6000 4000");
    expect(scene.queryAll(
      (node) => node.type === "g" && node.props.dangerouslySetInnerHTML !== undefined,
      { includeSelf: true },
    )[0]!.props.dangerouslySetInnerHTML.__html).toContain("floor-plan-b");

    await result.unmount();
  });

  it("reloads the web scene after the server floor-plan hash changes", async () => {
    mockCache = {
      xml: '<svg viewBox="0 0 6000 4000"><path id="floor-plan-a"/></svg>',
      innerXml: '<path id="floor-plan-a"/>',
      uri: "",
      contentViewBox: { x: 0, y: 0, w: 6000, h: 4000 },
    };
    mockCacheHash = "hash-a";
    mockFetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "hash-a" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "hash-b" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: "hash-b" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => WEB_SCENE_XML,
      });

    const result = await render(
      <WarehouseMapView
        zones={[zone]}
        zonesLoading={false}
        zonesError={false}
        onZonesRetry={jest.fn()}
        onZoneTap={jest.fn()}
      />,
    );
    const layoutNode = result.root!.queryAll(
      (node) => typeof node.props.onLayout === "function",
      { includeSelf: true },
    )[0]!;
    await act(async () => {
      layoutNode.props.onLayout({
        nativeEvent: { layout: { width: 500, height: 800 } },
      });
    });
    await flushPromises(6);

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await flushPromises(16);

    const scene = result.root!.queryAll(
      (node) => node.type === "svg-svg" && node.props.viewBox !== undefined,
      { includeSelf: true },
    )[0]!;
    expect(scene.props.viewBox).toBe("0 0 5000 3000");
    expect(scene.props.width).toBe(500);
    expect(scene.props.height).toBe(300);
    expect(scene.queryAll(
      (node) => node.type === "g" && node.props.dangerouslySetInnerHTML !== undefined,
      { includeSelf: true },
    )[0]!.props.dangerouslySetInnerHTML.__html).toContain("floor-plan");
    expect(scene.queryAll(
      (node) => node.type === "svg-rect",
      { includeSelf: true },
    )).toHaveLength(1);

    await result.unmount();
  });
});