/**
 * @jest-environment jsdom
 *
 * Tests for the Prev/Next section navigation buttons in BrowseByAisle:
 *   • At the first section the Prev button is disabled and Next shows the
 *     correct next-section label.
 *   • Pressing Next advances to the next section (and clears the shelf crumb
 *     so the level drops back to "shelves" when navigating from the parts view).
 *   • At the last section the Next button is disabled and Prev shows the
 *     correct label.
 *   • The Unsorted synthetic section shows BOTH buttons disabled because the
 *     fake aisle that wraps it contains only a single section.
 *
 * A mutable `mockShelfViewEnabled` flag lets individual tests flip
 * `settings.shelfViewEnabled` (= `warehouseShelfView`) without re-hoisting the
 * entire jest.mock block — hoisting would lose the closure over the flag.
 *
 * Two distinct navigation surfaces are exercised:
 *   • SectionShelfView  – rendered at the "shelves" level when
 *     `warehouseShelfView` is true.  Drill path: Aisle → Section.
 *   • ShelfView         – rendered at the "parts" level when the
 *     `shelfViewEnabled` *prop* is true.  Drill path: Aisle → Section → Shelf.
 *     Used for the "shelf crumb cleared on Next" and "Unsorted" assertions.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';
import { act, render, fireEvent, screen } from '@testing-library/react';
import type { InventoryItem } from '@workspace/api-client-react';

// ── Mutable AppContext settings ──────────────────────────────────────────────
// Start with warehouseShelfView ON so most tests can drill straight to the
// "shelves" level and see SectionShelfView (which contains SectionNavBar).
let mockShelfViewEnabled = true;

// ── react-native mock (per-file, jsdom-compatible) ───────────────────────────
jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');

  function flatStyle(style: unknown): object | undefined {
    if (!style) return undefined;
    if (Array.isArray(style)) {
      return Object.assign({}, ...(style as unknown[]).filter(Boolean).map(flatStyle));
    }
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
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  const ActivityIndicator = makeHost('div');

  const BackHandler = {
    addEventListener: (_evt: string, _fn: () => boolean) => ({ remove: () => {} }),
  };

  // Minimal PanResponder stub — useSectionSwipe calls PanResponder.create()
  // once inside a useRef and spreads panHandlers onto the container View.
  // All we need is for .create() to return a stable object with an empty
  // panHandlers dict so the component mounts without crashing.
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

// ── Theme stub ────────────────────────────────────────────────────────────────
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

// ── AppContext stub (reads mutable flag so tests can override per-describe) ───
jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({ settings: { shelfViewEnabled: mockShelfViewEnabled } }),
}));

// ── Component under test ──────────────────────────────────────────────────────
import { BrowseByAisle } from '@/components/BrowseByAisle';

// ── Fixtures ──────────────────────────────────────────────────────────────────
/**
 * Returns a minimal InventoryItem that satisfies the type checker.
 * Bin format: `AA-SS-SHP` (aisle-section-shelfPosition).
 */
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
 * Three items spread across three sections in Aisle 17:
 *   Section 01 → Shelf 100 → Item 1
 *   Section 02 → Shelf 100 → Item 2
 *   Section 03 → Shelf 100 → Item 3
 */
function makeThreeSectionInventory(): InventoryItem[] {
  return [makeItem(1, '17-01-100'), makeItem(2, '17-02-100'), makeItem(3, '17-03-100')];
}

/** An item whose bin doesn't match the pattern → lands in Unsorted. */
function makeUnsortedInventory(): InventoryItem[] {
  return [{ ...makeItem(99, ''), binLocations: ['BADBIN'] } as unknown as InventoryItem];
}

/** Convenience: return the button as an HTMLButtonElement. */
function btn(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

// Reset per-test mutable state.
beforeEach(() => {
  mockShelfViewEnabled = true;
});

// ── Tests: SectionShelfView path (warehouseShelfView ON) ─────────────────────
// Drill depth: Aisle → Section.  SectionShelfView renders SectionNavBar.
describe('Prev/Next section navigation via SectionShelfView', () => {
  it('first section: Prev button is disabled, Next button shows the next section label', () => {
    render(
      <BrowseByAisle
        inventory={makeThreeSectionInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );

    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Section 01/));
    });

    expect(btn('No previous section').disabled).toBe(true);
    expect(btn('Next section: Section 02').disabled).toBe(false);
  });

  it('pressing Next advances to the next section', () => {
    render(
      <BrowseByAisle
        inventory={makeThreeSectionInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );

    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Section 01/));
    });

    act(() => {
      fireEvent.click(btn('Next section: Section 02'));
    });

    // After navigating, Prev points back to Section 01 and Next points to Section 03.
    expect(btn('Previous section: Section 01').disabled).toBe(false);
    expect(btn('Next section: Section 03').disabled).toBe(false);
  });

  it('last section: Next button is disabled, Prev button shows the previous section label', () => {
    render(
      <BrowseByAisle
        inventory={makeThreeSectionInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );

    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Section 03/));
    });

    expect(btn('Previous section: Section 02').disabled).toBe(false);
    expect(btn('No next section').disabled).toBe(true);
  });

  it('pressing Next at the last section does not change the section', () => {
    render(
      <BrowseByAisle
        inventory={makeThreeSectionInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );

    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Section 03/));
    });

    // Clicking a disabled button must not navigate away.
    act(() => {
      fireEvent.click(btn('No next section'));
    });

    // State must be unchanged — still showing the Section 03 boundary labels.
    expect(btn('No next section').disabled).toBe(true);
    expect(btn('Previous section: Section 02').disabled).toBe(false);
  });

  it('pressing Prev at the first section does not change the section', () => {
    render(
      <BrowseByAisle
        inventory={makeThreeSectionInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );

    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Section 01/));
    });

    act(() => {
      fireEvent.click(btn('No previous section'));
    });

    // Still on Section 01.
    expect(btn('No previous section').disabled).toBe(true);
    expect(btn('Next section: Section 02').disabled).toBe(false);
  });

  it('can navigate forward through all three sections in sequence', () => {
    render(
      <BrowseByAisle
        inventory={makeThreeSectionInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );

    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Section 01/));
    });

    // Section 01: no prev, next is Section 02.
    expect(btn('No previous section').disabled).toBe(true);
    expect(btn('Next section: Section 02').disabled).toBe(false);

    // Navigate to Section 02.
    act(() => {
      fireEvent.click(btn('Next section: Section 02'));
    });
    expect(btn('Previous section: Section 01').disabled).toBe(false);
    expect(btn('Next section: Section 03').disabled).toBe(false);

    // Navigate to Section 03.
    act(() => {
      fireEvent.click(btn('Next section: Section 03'));
    });
    expect(btn('Previous section: Section 02').disabled).toBe(false);
    expect(btn('No next section').disabled).toBe(true);
  });
});

// ── Tests: ShelfView path (warehouseShelfView OFF, shelfViewEnabled prop ON) ──
// Drill depth: Aisle → Section → Shelf.  ShelfView renders SectionNavBar.
// This path verifies that the shelf crumb is cleared when navigating sections.
describe('shelf crumb reset via ShelfView', () => {
  beforeEach(() => {
    // Disable warehouse shelf view so the "shelves" level shows a plain
    // FlatList of shelves — allowing us to click into a shelf and reach the
    // "parts" level where ShelfView (with SectionNavBar) is rendered when
    // the `shelfViewEnabled` prop is true.
    mockShelfViewEnabled = false;
  });

  it('pressing Next clears the shelf crumb (level reverts from parts to shelves)', () => {
    render(
      <BrowseByAisle
        inventory={makeThreeSectionInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={() => {}}
        shelfViewEnabled={true}
      />
    );

    // Drill: Aisle 17 → Section 01 → Shelf 100 (parts level / ShelfView).
    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Section 01/));
    });
    act(() => {
      fireEvent.click(screen.getByText(/Shelf 100/));
    });

    // We are now in ShelfView at the parts level.
    expect(btn('No previous section').disabled).toBe(true);
    expect(btn('Next section: Section 02').disabled).toBe(false);

    act(() => {
      fireEvent.click(btn('Next section: Section 02'));
    });

    // After navigating, shelf crumb is null → level drops to "shelves".
    // warehouseShelfView is false → plain FlatList of shelves shown, not
    // ShelfView.  Consequently the ShelfView's SectionNavBar is gone — if
    // queryByRole returns null the shelf crumb was successfully cleared.
    expect(screen.queryByRole('button', { name: 'Next section: Section 03' })).toBeNull();
    // The shelves list for Section 02 is visible in its place.
    expect(screen.getByText(/Shelf 100/)).toBeTruthy();
  });
});

// ── Tests: Unsorted synthetic section ────────────────────────────────────────
// Clicking "Unsorted" sets shelf immediately (level = parts).  ShelfView
// renders SectionNavBar; both labels are null because the fake aisle that
// wraps Unsorted has only a single section.
describe('Unsorted synthetic section', () => {
  beforeEach(() => {
    mockShelfViewEnabled = false;
  });

  it('both Prev and Next buttons are disabled for the Unsorted section', () => {
    render(
      <BrowseByAisle
        inventory={makeUnsortedInventory()}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={() => {}}
        shelfViewEnabled={true}
      />
    );

    // Click the Unsorted row — it jumps directly to the parts level with a
    // synthetic aisle that has exactly one section, so neither boundary can
    // be crossed.
    act(() => {
      fireEvent.click(screen.getByText('Unsorted'));
    });

    expect(btn('No previous section').disabled).toBe(true);
    expect(btn('No next section').disabled).toBe(true);
  });
});
