/**
 * @jest-environment jsdom
 *
 * Asserts that shelf divider planks (the thin 2-px horizontal lines rendered
 * between shelves in SectionShelfView) pick up colors.foreground from the
 * active color scheme — not the '#000000' fallback baked into the static
 * sectionStyles.shelfPlank base style.
 *
 * Strategy: the react-native View mock exposes the resolved backgroundColor of
 * each element as a `data-bg` attribute. This lets the test query colour values
 * directly from the DOM without fighting jsdom's CSS normalisation (hex → rgb).
 *
 * Fixture: two items with different shelf-hundreds in the same aisle+section
 * (bins '01-01-100' and '01-01-200') produce two shelves in Section 01.
 * After shelves are reversed to ascending order, shelfIdx 1 (shelf 200) satisfies
 * `shelfIdx > 0` and triggers the between-shelf shelfPlank divider.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';
import { act, render, fireEvent, screen } from '@testing-library/react';
import type { InventoryItem } from '@workspace/api-client-react';

// ── Mutable foreground colour (swapped per describe block) ────────────────────
let mockForeground = '#1a1a1a'; // light palette value

// ── react-native mock — View exposes resolved backgroundColor as data-bg ─────
jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');

  function flatStyle(style: unknown): Record<string, unknown> | undefined {
    if (!style) return undefined;
    if (Array.isArray(style)) {
      return Object.assign({}, ...(style as unknown[]).filter(Boolean).map(flatStyle));
    }
    if (typeof style === 'function') return undefined;
    return style as Record<string, unknown>;
  }

  const View = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const {
      children,
      style,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      onPress: _op,
      hitSlop: _hs,
      pointerEvents: _pe,
      ...rest
    } = props;
    const flat = flatStyle(style);
    const bg = flat?.backgroundColor as string | undefined;
    const a11y: Record<string, unknown> = {};
    if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
    if (accessibilityRole != null) a11y['role'] = accessibilityRole;
    if (accessibilityState && (accessibilityState as { selected?: boolean }).selected != null) {
      a11y['aria-selected'] = (accessibilityState as { selected?: boolean }).selected;
    }
    return React.createElement(
      'div',
      {
        ref,
        style: flat,
        ...(bg != null ? { 'data-bg': bg } : {}),
        ...a11y,
        ...rest,
      },
      children as React.ReactNode
    );
  });

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
        ...rest
      } = props;
      const a11y: Record<string, unknown> = {};
      if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
      if (accessibilityRole != null) a11y['role'] = accessibilityRole;
      if (accessibilityState && (accessibilityState as { selected?: boolean }).selected != null) {
        a11y['aria-selected'] = (accessibilityState as { selected?: boolean }).selected;
      }
      return React.createElement(
        tag,
        { ref, style, ...a11y, ...rest },
        children as React.ReactNode
      );
    });
  }

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
    return React.createElement('div', { ref: innerRef, ...props });
  });

  const Pressable = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const {
      onPress,
      children,
      disabled,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      style: _s,
      hitSlop: _hs,
      ...rest
    } = props;
    const a11y: Record<string, unknown> = { 'aria-label': accessibilityLabel };
    if (accessibilityState && (accessibilityState as { selected?: boolean }).selected != null) {
      a11y['aria-selected'] = (accessibilityState as { selected?: boolean }).selected;
    }
    return React.createElement(
      'button',
      {
        ref,
        type: 'button',
        onClick: disabled ? undefined : onPress,
        disabled: Boolean(disabled),
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
    flatten: (style: unknown) => {
      if (Array.isArray(style)) return Object.assign({}, ...(style as unknown[]).filter(Boolean));
      return style ?? {};
    },
    hairlineWidth: 1,
    absoluteFill: {},
  };

  const ActivityIndicator = makeHost('div');

  const BackHandler = {
    addEventListener: (_evt: string, _fn: () => boolean) => ({ remove: () => {} }),
  };

  const PanResponder = {
    create: (_config: Record<string, unknown>) => ({ panHandlers: {} }),
  };

  return {
    View,
    Text,
    ScrollView,
    Pressable,
    FlatList,
    StyleSheet,
    ActivityIndicator,
    BackHandler,
    PanResponder,
    Platform: {
      OS: 'ios',
      select: <T,>(o: { android?: T; ios?: T; web?: T; default?: T }) => o['ios'] ?? o.default,
    },
    useColorScheme: () => 'light',
  };
});

// ── AsyncStorage no-op ────────────────────────────────────────────────────────
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

// Prevent accidental network calls.
beforeAll(() => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
});

// ── Theme stub — foreground is mutable so tests can switch schemes ────────────
jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    foreground: mockForeground,
    background: '#f5f5f0',
    card: '#ffffff',
    border: '#d1d5db',
    primary: '#f59e0b',
    primaryForeground: '#ffffff',
    muted: '#e5e7eb',
    mutedForeground: '#6b7280',
    destructive: '#ef4444',
    radius: 8,
  }),
}));

// ── AppContext stub (warehouseShelfView ON so drill stops at Section level) ───
jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({ settings: { shelfViewEnabled: true } }),
}));

// ── Component under test ──────────────────────────────────────────────────────
import { BrowseByAisle } from '@/components/BrowseByAisle';

// ── Fixture ───────────────────────────────────────────────────────────────────
function makeItem(id: number, bin: string): InventoryItem {
  return {
    id,
    catalog: `ITEM-${id}`,
    vendor: 'ACME',
    description: `Part ${id}`,
    binLocations: [bin],
    keywords: [],
    aiKeywords: [],
    tradeSize: null,
    seriesId: null,
    seriesName: null,
    categoryId: null,
    subcategoryId: null,
    typeId: null,
  } as unknown as InventoryItem;
}

/**
 * Two items in Aisle 01, Section 01 but on different shelf levels.
 * After aisleHierarchy builds the tree (shelves sorted DESC then reversed to ASC),
 * shelves = [100, 200]. SectionShelfView renders a shelfPlank divider before
 * shelfIdx 1 (shelf 200) because `shelfIdx > 0` is satisfied.
 */
function makeTwoShelfInventory(): InventoryItem[] {
  return [makeItem(1, '01-01-100'), makeItem(2, '01-01-200')];
}

/** Drill into Section 01 of Aisle 01 (the SectionShelfView level). */
function drillToSection(inventory: InventoryItem[]) {
  render(
    <BrowseByAisle
      inventory={inventory}
      cacheReady={true}
      onClose={() => {}}
      fontScale={1}
      onEditKeywords={() => {}}
    />
  );
  act(() => {
    fireEvent.click(screen.getByText(/Aisle 01/));
  });
  act(() => {
    fireEvent.click(screen.getByText(/Section 01/));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SectionShelfView shelfPlank dividers — light color scheme', () => {
  beforeEach(() => {
    mockForeground = '#1a1a1a'; // colors.light.foreground
  });

  it('renders at least one shelfPlank divider between shelves', () => {
    drillToSection(makeTwoShelfInventory());
    const planks = document.querySelectorAll(`[data-bg="${mockForeground}"]`);
    expect(planks.length).toBeGreaterThanOrEqual(1);
  });

  it('shelfPlank divider uses colors.foreground (#1a1a1a), not the hardcoded #000000 base', () => {
    drillToSection(makeTwoShelfInventory());
    // No element should carry the raw '#000000' base value — the inline override wins.
    const hardcodedPlanks = document.querySelectorAll('[data-bg="#000000"]');
    expect(hardcodedPlanks.length).toBe(0);
    // At least one element carries the correct foreground colour.
    const themedPlanks = document.querySelectorAll(`[data-bg="${mockForeground}"]`);
    expect(themedPlanks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SectionShelfView shelfPlank dividers — dark color scheme', () => {
  beforeEach(() => {
    mockForeground = '#f9fafb'; // colors.dark.foreground
  });

  it('renders at least one shelfPlank divider between shelves', () => {
    drillToSection(makeTwoShelfInventory());
    const planks = document.querySelectorAll(`[data-bg="${mockForeground}"]`);
    expect(planks.length).toBeGreaterThanOrEqual(1);
  });

  it('shelfPlank divider uses colors.foreground (#f9fafb), not the hardcoded #000000 base', () => {
    drillToSection(makeTwoShelfInventory());
    const hardcodedPlanks = document.querySelectorAll('[data-bg="#000000"]');
    expect(hardcodedPlanks.length).toBe(0);
    const themedPlanks = document.querySelectorAll(`[data-bg="${mockForeground}"]`);
    expect(themedPlanks.length).toBeGreaterThanOrEqual(1);
  });
});
