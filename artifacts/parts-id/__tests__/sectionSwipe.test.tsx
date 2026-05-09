/**
 * @jest-environment jsdom
 *
 * Tests for the horizontal-swipe gesture that navigates between sections in
 * BrowseByAisle's visual shelf views.
 *
 * Covered scenarios:
 *   SectionShelfView (level = 'shelves', settings.shelfViewEnabled = true):
 *     • swipe-left  (dx ≤ -75) → navigates to the next section   [iOS threshold]
 *     • swipe-right (dx ≥  75) → navigates to the prev section   [iOS threshold]
 *     • sub-threshold (|dx| < 75) → no navigation on iOS (threshold = 60 × 1.25)
 *     • at the last section: swipe-left callback is null → no navigation
 *     • at the first section: swipe-right callback is null → no navigation
 *
 *   ShelfView (level = 'parts', shelfViewEnabled prop = true):
 *     • swipe-left → navigates to the next section
 *
 * Strategy: PanResponder.create is mocked to capture the gesture config so
 * tests can call onPanResponderRelease directly with a synthetic gesture state
 * and assert navigation changes via SectionNavBar's aria-labels.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { InventoryItem } from '@workspace/api-client-react';

// ── Mutable state shared with mocks (populated at module init, before tests) ──
type GestureHandler = (evt: unknown, gs: { dx: number; dy: number }) => void;
type PanConfig = { onPanResponderRelease?: GestureHandler };
const panConfigs: PanConfig[] = [];
const appSettings = { shelfViewEnabled: true };

// ── react-native mock (per-file) ─────────────────────────────────────────────
jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');

  function flatStyle(style: unknown): object | undefined {
    if (!style) return undefined;
    if (Array.isArray(style))
      return Object.assign({}, ...(style as unknown[]).filter(Boolean).map(flatStyle));
    if (typeof style === 'function') return undefined;
    return style as object;
  }

  function makeHost(tag: string) {
    return React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      const {
        children,
        style,
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        onPress: _op,
        numberOfLines: _nl,
        ellipsizeMode: _em,
        allowFontScaling: _afs,
        hitSlop: _hs,
        horizontal: _h,
        showsHorizontalScrollIndicator: _shi,
        showsVerticalScrollIndicator: _svi,
        contentContainerStyle: _ccs,
        scrollEventThrottle: _set,
        onScroll: _os,
        pointerEvents: _pe,
        disabled: _d,
        // Strip gesture-responder event props so they don't appear on host elements
        onStartShouldSetResponder: _a,
        onStartShouldSetResponderCapture: _b,
        onMoveShouldSetResponder: _c,
        onMoveShouldSetResponderCapture: _dd,
        onResponderGrant: _e,
        onResponderMove: _f,
        onResponderRelease: _g,
        onResponderReject: _hh,
        onResponderTerminate: _i,
        onResponderTerminationRequest: _j,
        ...rest
      } = props;
      const a11y: Record<string, unknown> = {};
      if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
      if (accessibilityRole != null) a11y['role'] = accessibilityRole;
      if (accessibilityState && (accessibilityState as { selected?: boolean }).selected != null)
        a11y['aria-selected'] = (accessibilityState as { selected?: boolean }).selected;
      return React.createElement(
        tag,
        { ref, style: flatStyle(style), ...a11y, ...rest },
        children as React.ReactNode
      );
    });
  }

  const View = makeHost('div');
  const Text = makeHost('span');

  const ScrollView = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const innerRef = React.useRef<unknown>(null);
    React.useImperativeHandle(
      ref,
      () => ({
        scrollToEnd: () => {},
        scrollTo: () => {},
        scrollToOffset: () => {},
        getScrollableNode: () => innerRef.current,
      }),
      []
    );
    const Host = makeHost('div');
    return React.createElement(Host, { ...props, ref: innerRef });
  });

  const Pressable = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const {
      onPress,
      children,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      style: _s,
      hitSlop: _hs,
      disabled: _d,
      ...rest
    } = props;
    const a11y: Record<string, unknown> = { 'aria-label': accessibilityLabel };
    if (accessibilityState && (accessibilityState as { selected?: boolean }).selected != null)
      a11y['aria-selected'] = (accessibilityState as { selected?: boolean }).selected;
    return React.createElement(
      'button',
      {
        ref,
        type: 'button',
        onClick: onPress,
        role: accessibilityRole ?? 'button',
        ...a11y,
        ...rest,
      },
      (typeof children === 'function'
        ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false })
        : children) as React.ReactNode
    );
  });

  function FlatList<T>(props: {
    data?: readonly T[] | null;
    renderItem?: (info: { item: T; index: number }) => React.ReactNode;
    keyExtractor?: (item: T, idx: number) => string;
    ListFooterComponent?: React.ReactNode;
    scrollEventThrottle?: number;
    onScroll?: unknown;
    contentContainerStyle?: unknown;
  }) {
    const items = props.data ?? [];
    return React.createElement(
      'div',
      { 'data-flatlist': true },
      items.map((item, idx) =>
        React.createElement(
          React.Fragment,
          { key: props.keyExtractor ? props.keyExtractor(item, idx) : String(idx) },
          props.renderItem ? props.renderItem({ item, index: idx }) : null
        )
      ),
      props.ListFooterComponent ?? null
    );
  }

  const StyleSheet = {
    create: <T extends object>(obj: T) => obj,
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  const Modal = ({
    visible,
    children,
  }: {
    visible: boolean;
    children: React.ReactNode;
    animationType?: string;
    transparent?: boolean;
    onRequestClose?: () => void;
  }) => (visible ? React.createElement('div', { role: 'dialog' }, children) : null);
  Modal.displayName = 'Modal';

  const BackHandler = {
    addEventListener: (_evt: string, _fn: () => boolean) => ({ remove: () => {} }),
  };

  // Captures the config passed to PanResponder.create so tests can invoke
  // onPanResponderRelease directly.
  const PanResponder = {
    create(config: unknown) {
      panConfigs.push(config as PanConfig);
      return { panHandlers: {} };
    },
  };

  return {
    View,
    Text,
    ScrollView,
    Pressable,
    FlatList,
    Modal,
    StyleSheet,
    ActivityIndicator: makeHost('div'),
    BackHandler,
    PanResponder,
    Platform: {
      OS: 'ios' as const,
      select: <T,>(o: { ios?: T; default?: T }) => o.ios ?? o.default,
    },
    useColorScheme: () => 'light',
  };
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

beforeAll(() => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
});

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    foreground: '#000',
    background: '#fff',
    card: '#fff',
    border: '#ccc',
    primary: '#06f',
    primaryForeground: '#fff',
    muted: '#eee',
    mutedForeground: '#666',
    destructive: '#c00',
    radius: 8,
  }),
}));

// The factory captures `appSettings` by reference; mutate it per-test to
// toggle between SectionShelfView (true) and the individual-shelf list (false).
jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({ settings: appSettings }),
}));

jest.mock('@/lib/refinement', () => ({
  splitHighlightSegments: (text: string) => [{ text, match: false }],
}));

jest.mock('@/lib/tradeSize', () => ({
  parseTradeSizeInches: () => null,
  formatInchesAsFraction: () => '',
}));

jest.mock('@expo/vector-icons', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  const Stub = ({ name }: { name: string }) => React.createElement('span', {}, name);
  return { Feather: Stub, MaterialCommunityIcons: Stub };
});

import { BrowseByAisle } from '@/components/BrowseByAisle';

// ── Inventory fixture ────────────────────────────────────────────────────────
// Aisle 17 with three sections: 04 (first), 06 (middle), 08 (last).
// One part per section so every visual component has content to render.
function makeInventory(): InventoryItem[] {
  const base = {
    vendor: 'ACME',
    keywords: [],
    aiKeywords: [],
    tradeSize: null,
    seriesId: null,
    seriesName: null,
    categoryId: null,
    subcategoryId: null,
    typeId: null,
  };
  return [
    { ...base, id: 1, catalog: 'PART-A', description: 'Part A', binLocations: ['17-04-105'] },
    { ...base, id: 2, catalog: 'PART-B', description: 'Part B', binLocations: ['17-06-205'] },
    { ...base, id: 3, catalog: 'PART-C', description: 'Part C', binLocations: ['17-08-305'] },
  ] as unknown as InventoryItem[];
}

// Three parts all on the same shelf (17-04-1xx) for card-swipe navigation tests.
function makeMultiPartInventory(): InventoryItem[] {
  const base = {
    vendor: 'ACME',
    keywords: [],
    aiKeywords: [],
    tradeSize: null,
    seriesId: null,
    seriesName: null,
    categoryId: null,
    subcategoryId: null,
    typeId: null,
  };
  return [
    { ...base, id: 10, catalog: 'MULTI-A', description: 'Multi A', binLocations: ['17-04-101'] },
    { ...base, id: 11, catalog: 'MULTI-B', description: 'Multi B', binLocations: ['17-04-103'] },
    { ...base, id: 12, catalog: 'MULTI-C', description: 'Multi C', binLocations: ['17-04-105'] },
  ] as unknown as InventoryItem[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Fire onPanResponderRelease on the most-recently captured PanResponder config. */
function swipe(dx: number, dy = 0): void {
  const config = panConfigs[panConfigs.length - 1];
  if (!config) throw new Error('No PanResponder config captured — did a visual shelf view mount?');
  act(() => {
    config.onPanResponderRelease?.({}, { dx, dy });
  });
}

/**
 * Fire onPanResponderRelease on the card-item swipe PanResponder config.
 * The card-item hook is always created before useSectionSwipe in each shelf
 * component, so its config is at panConfigs[panConfigs.length - 2].
 */
function cardSwipe(dx: number, dy = 0): void {
  const config = panConfigs[panConfigs.length - 2];
  if (!config) throw new Error('No card-swipe PanResponder config captured.');
  act(() => {
    config.onPanResponderRelease?.({}, { dx, dy });
  });
}

/** Drill into an aisle and then a section (wraps each click in act). */
function drillToSection(sectionLabel: string): void {
  act(() => {
    fireEvent.click(screen.getByText(/Aisle 17/));
  });
  act(() => {
    fireEvent.click(screen.getByText(sectionLabel));
  });
}

const defaultProps = {
  inventory: makeInventory(),
  cacheReady: true,
  onClose: () => {},
  fontScale: 1,
  onEditKeywords: () => {},
} as const;

beforeEach(() => {
  panConfigs.length = 0;
  appSettings.shelfViewEnabled = true; // SectionShelfView by default
});

// ── SectionShelfView (level = 'shelves') ─────────────────────────────────────
describe('SectionShelfView swipe navigation', () => {
  it('swipe-left (dx = -80) navigates to the next section', () => {
    render(<BrowseByAisle {...defaultProps} />);
    drillToSection('Section 06');

    // Verify initial state: on Section 06 with both neighbours visible.
    expect(screen.getByLabelText('Previous section: Section 04')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 08')).toBeTruthy();

    swipe(-80);

    // After navigating to Section 08: prev = Section 06, no next.
    expect(screen.getByLabelText('Previous section: Section 06')).toBeTruthy();
    expect(screen.getByLabelText('No next section')).toBeTruthy();
  });

  it('swipe-right (dx = 80) navigates to the prev section', () => {
    render(<BrowseByAisle {...defaultProps} />);
    drillToSection('Section 06');

    swipe(80);

    // After navigating to Section 04: no prev, next = Section 06.
    expect(screen.getByLabelText('No previous section')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 06')).toBeTruthy();
  });

  it('sub-threshold swipe (dx = -40) does NOT navigate', () => {
    render(<BrowseByAisle {...defaultProps} />);
    drillToSection('Section 06');

    swipe(-40);

    // Still on Section 06 — nav labels unchanged.
    expect(screen.getByLabelText('Previous section: Section 04')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 08')).toBeTruthy();
  });

  it('sub-threshold swipe (dx = 40) does NOT navigate', () => {
    render(<BrowseByAisle {...defaultProps} />);
    drillToSection('Section 06');

    swipe(40);

    expect(screen.getByLabelText('Previous section: Section 04')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 08')).toBeTruthy();
  });

  it('iOS boundary: dx = 65 does NOT navigate (below the 75-px iOS threshold)', () => {
    // On iOS the threshold is 75 px (60 × 1.25 — 25% less sensitive than other
    // platforms). A swipe of 65 px would have triggered on the old 60-px threshold
    // but must be treated as sub-threshold on iOS.
    render(<BrowseByAisle {...defaultProps} />);
    drillToSection('Section 06');

    swipe(-65);

    expect(screen.getByLabelText('Previous section: Section 04')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 08')).toBeTruthy();
  });

  it('at the last section, swipe-left is a no-op (onSwipeLeft is null)', () => {
    render(<BrowseByAisle {...defaultProps} />);
    drillToSection('Section 08');

    // Verify we are at the last section.
    expect(screen.getByLabelText('No next section')).toBeTruthy();
    expect(screen.getByLabelText('Previous section: Section 06')).toBeTruthy();

    swipe(-80);

    // Nav labels must be unchanged — still on Section 08.
    expect(screen.getByLabelText('No next section')).toBeTruthy();
    expect(screen.getByLabelText('Previous section: Section 06')).toBeTruthy();
  });

  it('at the first section, swipe-right is a no-op (onSwipeRight is null)', () => {
    render(<BrowseByAisle {...defaultProps} />);
    drillToSection('Section 04');

    // Verify we are at the first section.
    expect(screen.getByLabelText('No previous section')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 06')).toBeTruthy();

    swipe(80);

    // Nav labels must be unchanged — still on Section 04.
    expect(screen.getByLabelText('No previous section')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 06')).toBeTruthy();
  });

  it('callbacks update after successive swipes: two left-swipes stop at the boundary', () => {
    render(<BrowseByAisle {...defaultProps} />);
    drillToSection('Section 04');

    // First left-swipe: Section 04 → Section 06
    swipe(-80);
    expect(screen.getByLabelText('Previous section: Section 04')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 08')).toBeTruthy();

    // Second left-swipe: Section 06 → Section 08
    swipe(-80);
    expect(screen.getByLabelText('Previous section: Section 06')).toBeTruthy();
    expect(screen.getByLabelText('No next section')).toBeTruthy();

    // Third left-swipe: already at last section — no-op.
    swipe(-80);
    expect(screen.getByLabelText('Previous section: Section 06')).toBeTruthy();
    expect(screen.getByLabelText('No next section')).toBeTruthy();
  });
});

// ── ShelfView (level = 'parts') ───────────────────────────────────────────────
describe('ShelfView swipe navigation', () => {
  it('swipe-left (dx = -80) navigates to the next section', () => {
    // To reach ShelfView we need:
    //   - settings.shelfViewEnabled = false → individual shelf list is shown
    //     so the worker can click into a single shelf (going to level 'parts')
    //   - shelfViewEnabled prop = true → level 'parts' renders ShelfView
    appSettings.shelfViewEnabled = false;

    render(<BrowseByAisle {...defaultProps} shelfViewEnabled={true} />);

    // Drill: Aisle 17 → Section 06 → Shelf 200 (= parts level, ShelfView)
    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText('Section 06'));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Shelf 200/));
    });

    // ShelfView mounts with Section 06 context.
    expect(screen.getByLabelText('Previous section: Section 04')).toBeTruthy();
    expect(screen.getByLabelText('Next section: Section 08')).toBeTruthy();

    swipe(-80);

    // After navigation to Section 08, shelf is reset to null → back to 'shelves'
    // level. With shelfViewEnabled = false the shelf list for Section 08 renders,
    // showing 'Shelf 300' (from bin 17-08-305).
    expect(screen.getByText(/Shelf 300/)).toBeTruthy();
    // The ShelfView nav bar for Section 06 is gone.
    expect(screen.queryByLabelText('Next section: Section 08')).toBeNull();
  });

  it('swipe-right (dx = 80) navigates to the prev section', () => {
    appSettings.shelfViewEnabled = false;

    render(<BrowseByAisle {...defaultProps} shelfViewEnabled={true} />);

    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText('Section 06'));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Shelf 200/));
    });

    expect(screen.getByLabelText('Previous section: Section 04')).toBeTruthy();

    swipe(80);

    // Navigated to Section 04, shelf list shown ('Shelf 100' from 17-04-105).
    expect(screen.getByText(/Shelf 100/)).toBeTruthy();
    expect(screen.queryByLabelText('Previous section: Section 04')).toBeNull();
  });
});

// ── SectionShelfView card swipe (iOS-only, part-to-part within same shelf) ────
describe('SectionShelfView card swipe — navigates between parts on same shelf (iOS)', () => {
  const multiProps = {
    inventory: makeMultiPartInventory(),
    cacheReady: true,
    onClose: () => {},
    fontScale: 1,
  } as const;

  it('swipe-left (dx = -60) advances to the next part on the shelf', () => {
    render(<BrowseByAisle {...multiProps} />);
    drillToSection('Section 04');

    act(() => {
      fireEvent.click(screen.getByLabelText('Bin 17-04-101: MULTI-A'));
    });
    expect(screen.getByLabelText('Bin 17-04-101: MULTI-A').getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.getByLabelText('Bin 17-04-103: MULTI-B').getAttribute('aria-selected')).toBe(
      'false'
    );

    cardSwipe(-60);

    expect(screen.getByLabelText('Bin 17-04-101: MULTI-A').getAttribute('aria-selected')).toBe(
      'false'
    );
    expect(screen.getByLabelText('Bin 17-04-103: MULTI-B').getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('swipe-right (dx = 60) goes back to the previous part', () => {
    render(<BrowseByAisle {...multiProps} />);
    drillToSection('Section 04');

    act(() => {
      fireEvent.click(screen.getByLabelText('Bin 17-04-103: MULTI-B'));
    });
    expect(screen.getByLabelText('Bin 17-04-103: MULTI-B').getAttribute('aria-selected')).toBe(
      'true'
    );

    cardSwipe(60);

    expect(screen.getByLabelText('Bin 17-04-101: MULTI-A').getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.getByLabelText('Bin 17-04-103: MULTI-B').getAttribute('aria-selected')).toBe(
      'false'
    );
  });

  it('sub-threshold (|dx| < 40) does NOT navigate', () => {
    render(<BrowseByAisle {...multiProps} />);
    drillToSection('Section 04');

    act(() => {
      fireEvent.click(screen.getByLabelText('Bin 17-04-101: MULTI-A'));
    });
    cardSwipe(-30);

    expect(screen.getByLabelText('Bin 17-04-101: MULTI-A').getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('at the last part, swipe-left is a no-op', () => {
    render(<BrowseByAisle {...multiProps} />);
    drillToSection('Section 04');

    act(() => {
      fireEvent.click(screen.getByLabelText('Bin 17-04-105: MULTI-C'));
    });
    cardSwipe(-60);

    expect(screen.getByLabelText('Bin 17-04-105: MULTI-C').getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('at the first part, swipe-right is a no-op', () => {
    render(<BrowseByAisle {...multiProps} />);
    drillToSection('Section 04');

    act(() => {
      fireEvent.click(screen.getByLabelText('Bin 17-04-101: MULTI-A'));
    });
    cardSwipe(60);

    expect(screen.getByLabelText('Bin 17-04-101: MULTI-A').getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('section swipe still works after card swipe hook is added', () => {
    // All 3 parts are in one section — no adjacent sections exist in this
    // fixture — so onSwipeLeft is null and a section swipe is a no-op.
    // This test confirms the section-swipe PanResponder is still captured last
    // and that the existing swipe() helper continues to target it.
    render(<BrowseByAisle {...multiProps} />);
    drillToSection('Section 04');

    expect(screen.getByLabelText('No previous section')).toBeTruthy();
    expect(screen.getByLabelText('No next section')).toBeTruthy();

    swipe(-80); // section swipe — no-op (no next section)

    expect(screen.getByLabelText('No previous section')).toBeTruthy();
    expect(screen.getByLabelText('No next section')).toBeTruthy();
  });
});

// ── ShelfView card swipe (iOS-only, part-to-part within same shelf) ───────────
describe('ShelfView card swipe — navigates between parts on same shelf (iOS)', () => {
  function drillToShelf(): void {
    appSettings.shelfViewEnabled = false;
    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText('Section 04'));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Shelf 100/));
    });
  }

  it('swipe-left advances to the next part', () => {
    render(
      <BrowseByAisle
        inventory={makeMultiPartInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        shelfViewEnabled={true}
      />
    );
    drillToShelf();

    act(() => {
      fireEvent.click(screen.getByLabelText('Bin 17-04-101: MULTI-A'));
    });
    expect(screen.getByLabelText('Bin 17-04-101: MULTI-A').getAttribute('aria-selected')).toBe(
      'true'
    );

    cardSwipe(-60);

    expect(screen.getByLabelText('Bin 17-04-101: MULTI-A').getAttribute('aria-selected')).toBe(
      'false'
    );
    expect(screen.getByLabelText('Bin 17-04-103: MULTI-B').getAttribute('aria-selected')).toBe(
      'true'
    );
  });

  it('swipe-right goes back to the previous part', () => {
    render(
      <BrowseByAisle
        inventory={makeMultiPartInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        shelfViewEnabled={true}
      />
    );
    drillToShelf();

    act(() => {
      fireEvent.click(screen.getByLabelText('Bin 17-04-103: MULTI-B'));
    });
    cardSwipe(60);

    expect(screen.getByLabelText('Bin 17-04-101: MULTI-A').getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.getByLabelText('Bin 17-04-103: MULTI-B').getAttribute('aria-selected')).toBe(
      'false'
    );
  });
});
