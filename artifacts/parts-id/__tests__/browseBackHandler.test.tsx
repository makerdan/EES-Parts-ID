/**
 * @jest-environment jsdom
 *
 * Tests for the Android hardware-back behavior of the Browse-mode UI:
 *   • BrowseTaxonomy: pop one level when drilled in; invoke onExitBrowse
 *     at root (Browse → Search); legacy bubble-through when the prop is
 *     omitted; iOS no-op.
 *   • BrowseByAisle: close the overlay at root, otherwise pop one level;
 *     and the BackHandler effect should NOT re-register on a no-op
 *     parent re-render (memoization guard for goBack/goHome).
 *
 * We override `react-native` per-file so we can capture BackHandler
 * listeners and flip Platform.OS between tests.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';
import { act, render, fireEvent, screen } from '@testing-library/react';
import type { InventoryItem } from '@workspace/api-client-react';
import type { CategoryTreeNode } from '@/lib/taxonomy';

// ── Mutable BackHandler/Platform state shared with the rn mock ──────────────
const platformRef = { OS: 'android' as 'android' | 'ios' | 'web' };
const backHandlerState = {
  handlers: [] as Array<() => boolean>, // eslint-disable-line @typescript-eslint/array-type
  addCount: 0,
  reset() {
    this.handlers.length = 0;
    this.addCount = 0;
  },
  pressBack(): boolean {
    // Newest listener wins, mirroring RN's BackHandler behaviour.
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const h = this.handlers[i]!;
      if (h()) return true;
    }
    return false;
  },
};

// ── react-native mock (per-file) ────────────────────────────────────────────
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

  // ScrollView needs an imperative handle so refs into it can call
  // scrollToEnd/scrollTo without a TypeError (BrowseTaxonomy does this on
  // its breadcrumb scroll view).
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
    addEventListener: (_evt: string, fn: () => boolean) => {
      backHandlerState.handlers.push(fn);
      backHandlerState.addCount += 1;
      return {
        remove: () => {
          const i = backHandlerState.handlers.indexOf(fn);
          if (i !== -1) backHandlerState.handlers.splice(i, 1);
        },
      };
    },
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
    Platform: {
      get OS() {
        return platformRef.OS;
      },
      select: <T,>(o: { android?: T; ios?: T; web?: T; default?: T }) =>
        o[platformRef.OS as 'android' | 'ios' | 'web'] ?? o.default,
    },
    useColorScheme: () => 'light',
  };
});

// ── AsyncStorage no-op mock so BrowseTaxonomy mount effect doesn't crash ────
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

// Prevent any accidental network call during BrowseTaxonomy mount.
beforeAll(() => {
  global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
});

// ── Theme + AppContext stubs to avoid pulling SecureStore/Appearance ────────
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

jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({ settings: { warehouseShelfView: false } }),
}));

// ── Imports under test (after all mocks) ────────────────────────────────────
import BrowseTaxonomy from '@/components/BrowseTaxonomy';
import { BrowseByAisle } from '@/components/BrowseByAisle';

// ── Fixtures ────────────────────────────────────────────────────────────────
const TREE: CategoryTreeNode[] = [
  {
    id: 1,
    slug: 'breakers',
    name: 'Breakers',
    level: 'category',
    sortOrder: 0,
    itemCount: 10,
    children: [
      {
        id: 2,
        slug: 'breakers-by-type',
        name: 'By Type',
        level: 'subcategory',
        sortOrder: 0,
        itemCount: 10,
        children: [],
      },
    ],
  },
];

function makeInventory(): InventoryItem[] {
  return [
    {
      id: 1,
      catalog: 'WIDGET-1',
      vendor: 'ACME',
      description: 'Test widget',
      binLocations: ['17-06-105'],
      keywords: [],
      aiKeywords: [],
      tradeSize: null,
      seriesId: null,
      seriesName: null,
      categoryId: null,
      subcategoryId: null,
      typeId: null,
    } as unknown as InventoryItem,
  ];
}

beforeEach(() => {
  backHandlerState.reset();
  platformRef.OS = 'android';
});

// ── BrowseTaxonomy tests ────────────────────────────────────────────────────
describe('BrowseTaxonomy back handler', () => {
  it('registers a single Android BackHandler listener on mount', () => {
    render(<BrowseTaxonomy onSelectNode={() => {}} initialTree={TREE} />);
    expect(backHandlerState.handlers).toHaveLength(1);
  });

  it('does NOT register a listener on iOS', () => {
    platformRef.OS = 'ios';
    render(<BrowseTaxonomy onSelectNode={() => {}} initialTree={TREE} />);
    expect(backHandlerState.handlers).toHaveLength(0);
  });

  it('at root with onExitBrowse provided: invokes the callback and consumes the event', () => {
    const onExitBrowse = jest.fn();
    render(
      <BrowseTaxonomy onSelectNode={() => {}} initialTree={TREE} onExitBrowse={onExitBrowse} />
    );
    let consumed = false;
    act(() => {
      consumed = backHandlerState.pressBack();
    });
    expect(consumed).toBe(true);
    expect(onExitBrowse).toHaveBeenCalledTimes(1);
  });

  it('at root WITHOUT onExitBrowse: returns false so the navigator handles it', () => {
    render(<BrowseTaxonomy onSelectNode={() => {}} initialTree={TREE} />);
    let consumed = true;
    act(() => {
      consumed = backHandlerState.pressBack();
    });
    expect(consumed).toBe(false);
  });

  it('drilled in: back press pops one level instead of exiting', () => {
    const onExitBrowse = jest.fn();
    render(
      <BrowseTaxonomy onSelectNode={() => {}} initialTree={TREE} onExitBrowse={onExitBrowse} />
    );
    // Drill into "Breakers" by clicking the row.
    act(() => {
      fireEvent.click(screen.getByText('Breakers'));
    });
    // First press should pop back to root and consume the event.
    let consumed = false;
    act(() => {
      consumed = backHandlerState.pressBack();
    });
    expect(consumed).toBe(true);
    expect(onExitBrowse).not.toHaveBeenCalled();
    // Second press is now at root → should invoke the exit callback.
    act(() => {
      consumed = backHandlerState.pressBack();
    });
    expect(consumed).toBe(true);
    expect(onExitBrowse).toHaveBeenCalledTimes(1);
  });
});

// ── BrowseByAisle tests ─────────────────────────────────────────────────────
describe('BrowseByAisle back handler', () => {
  it('at root: hardware back closes the overlay', () => {
    const onClose = jest.fn();
    render(
      <BrowseByAisle
        inventory={makeInventory()}
        cacheReady={true}
        onClose={onClose}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );
    let consumed = false;
    act(() => {
      consumed = backHandlerState.pressBack();
    });
    expect(consumed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('drilled in: hardware back pops one level instead of closing', () => {
    const onClose = jest.fn();
    render(
      <BrowseByAisle
        inventory={makeInventory()}
        cacheReady={true}
        onClose={onClose}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );
    // Drill into Aisle 17.
    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });
    let consumed = false;
    act(() => {
      consumed = backHandlerState.pressBack();
    });
    expect(consumed).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('memoizes goBack/goHome: a no-op parent re-render does NOT re-register the listener', () => {
    const onClose = jest.fn();
    const inv = makeInventory();
    const { rerender } = render(
      <BrowseByAisle
        inventory={inv}
        cacheReady={true}
        onClose={onClose}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );
    const initialAddCount = backHandlerState.addCount;
    // Re-render with the SAME prop references — level hasn't changed and
    // goBack/goHome are now memoized, so the BackHandler effect must skip.
    rerender(
      <BrowseByAisle
        inventory={inv}
        cacheReady={true}
        onClose={onClose}
        fontScale={1}
        onEditKeywords={() => {}}
      />
    );
    expect(backHandlerState.addCount).toBe(initialAddCount);
  });
});
