/**
 * @jest-environment node
 *
 * Regression tests: ResultCard must render both photo-slot thumbnails when
 * imageUrl + imageUrl2 are both present, exactly one thumbnail when only one
 * photo exists, and PhotoLightbox must show navigation buttons plus dot
 * indicators when more than one URI is supplied.
 *
 * Pattern mirrors zoneOverlaySelected.test.tsx — components are imported from
 * their real source files; all native/expo dependencies are mocked inline.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

// ─── react-native ─────────────────────────────────────────────────────────────

jest.mock("react-native", () => {
  const React = require("react");
  const noop = () => {};
  const Animated = {
    Value: class AnimatedValue {
      _value: number;
      constructor(v: number) { this._value = v; }
      setValue(v: number) { this._value = v; }
      interpolate() { return this; }
    },
    View: ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
      React.createElement("rn-animated-view", props, children),
    loop: () => ({ start: noop, stop: noop, reset: noop }),
    timing: () => ({ start: noop, stop: noop, reset: noop }),
  };
  const Easing = { linear: noop, ease: noop, in: () => noop, out: () => noop };
  return {
    Platform:     { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
    StyleSheet:   { create: (s: unknown) => s, flatten: (s: unknown) => s },
    View:         ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
                    React.createElement("rn-view", props, children),
    Text:         ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
                    React.createElement("rn-text", props, children),
    Pressable:    ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
                    React.createElement("rn-pressable", props, children),
    Image:        ({ uri, ...props }: { uri?: string; [k: string]: unknown }) =>
                    React.createElement("rn-image", { uri, ...props }),
    Modal:        ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
                    visible ? React.createElement("rn-modal", {}, children) : null,
    StatusBar:    () => null,
    ActivityIndicator: () => null,
    PixelRatio:   { get: () => 3 },
    useColorScheme: () => "light",
    AppState:     { currentState: "active", addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    Animated,
    Easing,
    LayoutAnimation: { configureNext: noop, Presets: { easeInEaseOut: {}, linear: {}, spring: {} } },
    UIManager: { setLayoutAnimationEnabledExperimental: noop },
  };
});

// ─── @expo/vector-icons ───────────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
  MaterialCommunityIcons: () => null,
}));

// ─── @react-native-async-storage/async-storage ───────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem:    jest.fn().mockResolvedValue(null),
  setItem:    jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

// ─── @/components/RetryImage ─────────────────────────────────────────────────
// Rendered as a unique tag so we can count/inspect instances.

jest.mock("@/components/RetryImage", () => {
  const React = require("react");
  return {
    RetryImage: ({ uri, ...props }: { uri: string; [k: string]: unknown }) =>
      React.createElement("retry-image", { uri, ...props }),
  };
});

// ─── @/components/PinIcon ────────────────────────────────────────────────────

jest.mock("@/components/PinIcon", () => {
  const React = require("react");
  return {
    PinIcon: () => React.createElement("pin-icon"),
  };
});

// ─── @/hooks/useColors ───────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── Suppress react-test-renderer deprecation warnings ───────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") ||
          msg.includes("Warning:"))
      ) return;
      origConsoleError(msg, ...args);
    },
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ─── Subjects under test ──────────────────────────────────────────────────────

import { ResultCard } from "@/components/ResultCard";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import type { SearchResult } from "@workspace/api-client-react";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeResult(photoOverrides: {
  imageUrl?: string;
  imageUrl2?: string;
  thumbnailUrl?: string;
  thumbnailUrl2?: string;
}): SearchResult {
  return {
    item: {
      id: 1,
      catalog: "ABC-123",
      vendor: "ACME",
      description: "Test part",
      binLocations: ["A1"],
      ...photoOverrides,
    },
    confidence: 0.9,
  } as unknown as SearchResult;
}

// =============================================================================
// ResultCard — photo-slot thumbnail rendering
// =============================================================================

describe("ResultCard — photo slot thumbnails", () => {
  it("renders two thumbnail Pressables when both imageUrl and imageUrl2 are present", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({ imageUrl: "https://example.com/img1.jpg", imageUrl2: "https://example.com/img2.jpg" })}
          rank={0}
        />,
      );
    });

    const pressables = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              typeof n.props.accessibilityLabel === "string" &&
              (n.props.accessibilityLabel as string).startsWith("View photo"),
      { deep: true },
    );

    expect(pressables).toHaveLength(2);
    expect(pressables[0]!.props.accessibilityLabel).toBe("View photo 1 for ABC-123");
    expect(pressables[1]!.props.accessibilityLabel).toBe("View photo 2 for ABC-123");

    await act(async () => { tree.unmount(); });
  });

  it("renders exactly one thumbnail Pressable when only imageUrl is present", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({ imageUrl: "https://example.com/img1.jpg" })}
          rank={0}
        />,
      );
    });

    const pressables = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              typeof n.props.accessibilityLabel === "string" &&
              (n.props.accessibilityLabel as string).startsWith("View photo"),
      { deep: true },
    );

    expect(pressables).toHaveLength(1);
    expect(pressables[0]!.props.accessibilityLabel).toBe("View photo 1 for ABC-123");

    await act(async () => { tree.unmount(); });
  });

  it("uses thumbnailUrl2 as slot 2 when imageUrl2 is absent", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({ imageUrl: "https://example.com/img1.jpg", thumbnailUrl2: "https://example.com/thumb2.jpg" })}
          rank={0}
        />,
      );
    });

    const pressables = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              typeof n.props.accessibilityLabel === "string" &&
              (n.props.accessibilityLabel as string).startsWith("View photo"),
      { deep: true },
    );

    expect(pressables).toHaveLength(2);

    await act(async () => { tree.unmount(); });
  });

  it("renders two RetryImage instances (one per slot) when both photos are present", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({ imageUrl: "https://example.com/img1.jpg", imageUrl2: "https://example.com/img2.jpg" })}
          rank={0}
        />,
      );
    });

    // Find only the header-thumbnail retry-images (not inside the expanded section
    // which is not rendered by default). Both slots live inside the thumbnailRow View
    // which is inside the headerRight View.
    const images = tree.root.findAll(
      (n) => (n.type as string) === "retry-image",
      { deep: true },
    );

    // At minimum two images must be present (slot 1 + slot 2).
    // The expanded section is collapsed so only header thumbnails render.
    expect(images.length).toBeGreaterThanOrEqual(2);

    const uris = images.map((n) => n.props.uri as string);
    expect(uris).toContain("https://example.com/img1.jpg");
    expect(uris).toContain("https://example.com/img2.jpg");

    await act(async () => { tree.unmount(); });
  });

  it("renders only one RetryImage when only imageUrl is present (no phantom slot)", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ResultCard
          result={makeResult({ imageUrl: "https://example.com/img1.jpg" })}
          rank={0}
        />,
      );
    });

    const images = tree.root.findAll(
      (n) => (n.type as string) === "retry-image",
      { deep: true },
    );

    // Only one image in the collapsed card (no second slot, no expanded section).
    expect(images).toHaveLength(1);
    expect(images[0]!.props.uri).toBe("https://example.com/img1.jpg");

    await act(async () => { tree.unmount(); });
  });
});

// =============================================================================
// PhotoLightbox — navigation buttons and dot indicators
// =============================================================================

describe("PhotoLightbox — navigation and dot indicators", () => {
  it("renders a Next button and dot indicators when two URIs are supplied", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <PhotoLightbox
          uris={["https://example.com/img1.jpg", "https://example.com/img2.jpg"]}
          initialIndex={0}
          onClose={jest.fn()}
        />,
      );
    });

    // Next navigation button must be present (at index 0, hasPrev=false, hasNext=true).
    const nextBtn = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              n.props.accessibilityLabel === "Next photo",
      { deep: true },
    );
    expect(nextBtn).toHaveLength(1);

    // Prev button must NOT be present when initialIndex=0.
    const prevBtn = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              n.props.accessibilityLabel === "Previous photo",
      { deep: true },
    );
    expect(prevBtn).toHaveLength(0);

    await act(async () => { tree.unmount(); });
  });

  it("renders a Previous button when initialIndex points to the last URI", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <PhotoLightbox
          uris={["https://example.com/img1.jpg", "https://example.com/img2.jpg"]}
          initialIndex={1}
          onClose={jest.fn()}
        />,
      );
    });

    const prevBtn = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              n.props.accessibilityLabel === "Previous photo",
      { deep: true },
    );
    expect(prevBtn).toHaveLength(1);

    // At last index there is no Next button.
    const nextBtn = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              n.props.accessibilityLabel === "Next photo",
      { deep: true },
    );
    expect(nextBtn).toHaveLength(0);

    await act(async () => { tree.unmount(); });
  });

  it("renders dot indicators equal to the number of URIs when more than one is supplied", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <PhotoLightbox
          uris={["https://example.com/img1.jpg", "https://example.com/img2.jpg"]}
          initialIndex={0}
          onClose={jest.fn()}
        />,
      );
    });

    // Each dot is an rn-view whose style prop is an array that includes
    // the `styles.dot` object (width: 7, height: 7, borderRadius: 3.5).
    // StyleSheet.create is mocked to return the object as-is so the full
    // style array is preserved on the node.
    const dotViews = tree.root.findAll(
      (n) => {
        if ((n.type as string) !== "rn-view") return false;
        const style = n.props.style;
        if (!Array.isArray(style)) return false;
        return style.some(
          (s: unknown) =>
            s !== null &&
            typeof s === "object" &&
            (s as Record<string, unknown>).width === 7 &&
            (s as Record<string, unknown>).height === 7,
        );
      },
      { deep: true },
    );

    // There are two URIs so two dots must be rendered.
    expect(dotViews).toHaveLength(2);

    await act(async () => { tree.unmount(); });
  });

  it("renders no navigation buttons or dot indicators when only one URI is supplied", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <PhotoLightbox
          uris={["https://example.com/img1.jpg"]}
          initialIndex={0}
          onClose={jest.fn()}
        />,
      );
    });

    const nextBtn = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              n.props.accessibilityLabel === "Next photo",
      { deep: true },
    );
    expect(nextBtn).toHaveLength(0);

    const prevBtn = tree.root.findAll(
      (n) => (n.type as string) === "rn-pressable" &&
              n.props.accessibilityLabel === "Previous photo",
      { deep: true },
    );
    expect(prevBtn).toHaveLength(0);

    const dotViews = tree.root.findAll(
      (n) => {
        if ((n.type as string) !== "rn-view") return false;
        const style = n.props.style as Record<string, unknown> | undefined;
        if (!style) return false;
        const bg = style.backgroundColor as string | undefined;
        return bg === "#fff" || bg === "rgba(255,255,255,0.35)";
      },
      { deep: true },
    );
    expect(dotViews).toHaveLength(0);

    await act(async () => { tree.unmount(); });
  });

  it("renders no content (returns null) when uris is empty", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <PhotoLightbox
          uris={[]}
          initialIndex={0}
          onClose={jest.fn()}
        />,
      );
    });

    // Modal visible=false → mock returns null → nothing in the tree.
    const modal = tree.root.findAll(
      (n) => (n.type as string) === "rn-modal",
      { deep: true },
    );
    expect(modal).toHaveLength(0);

    await act(async () => { tree.unmount(); });
  });
});
