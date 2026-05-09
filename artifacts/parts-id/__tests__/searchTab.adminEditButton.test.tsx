/**
 * @jest-environment jsdom
 *
 * Renders the actual Search tab screen (app/(tabs)/index.tsx) and verifies
 * that BrowseByAisle receives `onEditKeywords` as a function when adminToken
 * is present in AppContext, and `undefined` when it is not.
 *
 * Flow:
 *   1. Render the full SearchScreen with all dependencies mocked.
 *   2. The "Browse by Aisle" entry button is visible in the initial state
 *      (no search results yet, browse overlay not open).
 *   3. Click it → `setAisleBrowseOpen(true)` → the BrowseByAisle component
 *      renders with the screen's `onEditKeywords={adminToken ? setEditItem : undefined}`.
 *   4. The BrowseByAisle spy exposes the prop via `data-has-edit`.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';

// ── Mutable per-test admin flag ────────────────────────────────────────────────
let mockAdminToken: string | null = 'admin-tok';

// ── react-native mock (extended with Animated, FlatList, Switch, etc.) ────────
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
        android_ripple: _ar,
        onEndReached: _oer,
        onEndReachedThreshold: _oert,
        ListFooterComponent: _lfc,
        ListHeaderComponent: _lhc,
        keyExtractor: _ke,
        data: _d,
        renderItem: _ri,
        refreshControl: _rc,
        stickyHeaderIndices: _shi2,
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
    React.useImperativeHandle(ref, () => ({ scrollTo: () => {}, scrollToOffset: () => {} }), []);
    const Host = makeHost('div');
    return React.createElement(Host, { ...props, ref: innerRef });
  });

  const Pressable = React.forwardRef(
    (
      {
        onPress,
        children,
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        style,
        hitSlop: _hs,
        android_ripple: _ar,
        disabled: _d,
        ...rest
      }: Record<string, unknown>,
      ref: React.Ref<unknown>
    ) => {
      const resolvedStyle =
        typeof style === 'function'
          ? flatStyle((style as (s: { pressed: boolean }) => unknown)({ pressed: false }))
          : flatStyle(style);
      return React.createElement(
        'div',
        {
          ref,
          role: (accessibilityRole as string) ?? 'button',
          'aria-label': accessibilityLabel,
          onClick: onPress,
          style: resolvedStyle,
          ...(accessibilityState &&
          typeof accessibilityState === 'object' &&
          'selected' in (accessibilityState as object)
            ? { 'aria-selected': (accessibilityState as { selected: boolean }).selected }
            : {}),
          ...rest,
        },
        typeof children === 'function'
          ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false })
          : (children as React.ReactNode)
      );
    }
  );
  Pressable.displayName = 'Pressable';

  // FlatList renders its items so search results would be visible, but for
  // these tests no results are present.
  function FlatList<T>(props: {
    data?: readonly T[] | null;
    renderItem?: (info: { item: T; index: number }) => React.ReactNode;
    keyExtractor?: (item: T, idx: number) => string;
    ListFooterComponent?: React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    contentContainerStyle?: unknown;
    onScroll?: unknown;
    scrollEventThrottle?: unknown;
    refreshControl?: React.ReactNode;
    [key: string]: unknown;
  }) {
    const items = props.data ?? [];
    return React.createElement(
      'div',
      { 'data-flatlist': true },
      props.ListHeaderComponent ?? null,
      ...items.map((item, idx) =>
        React.createElement(
          React.Fragment,
          { key: props.keyExtractor ? props.keyExtractor(item, idx) : String(idx) },
          props.renderItem ? props.renderItem({ item, index: idx }) : null
        )
      ),
      props.ListFooterComponent ?? null
    );
  }

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

  const StyleSheet = {
    create: <T extends object>(obj: T): T => obj,
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  const ActivityIndicator = makeHost('div');

  // Animated — minimal stub for Value + spring/timing + View
  const AnimatedValue = class {
    _val: number;
    constructor(v: number) {
      this._val = v;
    }
    setValue(_v: number) {}
    addListener(_cb: unknown) {
      return '';
    }
    removeListener(_id: string) {}
    interpolate(_cfg: unknown) {
      return this;
    }
  };
  const Animated = {
    Value: AnimatedValue,
    spring: () => ({ start: (cb?: () => void) => cb?.() }),
    timing: () => ({ start: (cb?: () => void) => cb?.() }),
    createAnimatedComponent: <T,>(C: T) => C,
    View: makeHost('div'),
    Text: makeHost('span'),
    FlatList,
  };

  const BackHandler = {
    addEventListener: (_e: string, _fn: () => boolean) => ({ remove: () => {} }),
  };

  const PanResponder = {
    create: (_cfg: Record<string, unknown>) => ({ panHandlers: {} }),
  };

  return {
    View,
    Text,
    ScrollView,
    TextInput: makeHost('input'),
    Pressable,
    FlatList,
    Modal,
    StyleSheet,
    ActivityIndicator,
    Image: makeHost('img'),
    SafeAreaView: makeHost('div'),
    KeyboardAvoidingView: makeHost('div'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o['web'] ?? o['default'] },
    Linking: { openURL: jest.fn() },
    Keyboard: { dismiss: jest.fn(), addListener: () => ({ remove: jest.fn() }) },
    Switch: makeHost('div'),
    RefreshControl: makeHost('div'),
    useWindowDimensions: () => ({ width: 375, height: 812 }),
    useColorScheme: () => 'light',
    BackHandler,
    PanResponder,
    Animated,
  };
});

// ── Dependency mocks ───────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/KeyboardAwareScrollViewCompat', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub({ children }: { children: React.ReactNode }) {
    return R.createElement('div', {}, children);
  }
  return { KeyboardAwareScrollViewCompat: Stub };
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    multiGet: jest.fn(async () => []),
    multiRemove: jest.fn(async () => undefined),
  },
}));

jest.mock('fuse.js', () => {
  return class FuseMock {
    search(_q: string) {
      return [];
    }
  };
});

jest.mock('expo-router', () => ({
  Stack: Object.assign(({ children }: { children: React.ReactNode }) => children, {
    Screen: () => null,
  }),
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    isFocused: () => true,
    // addListener returns an unsubscribe fn pushed into the unsubs array
    addListener: jest.fn(() => jest.fn()),
    getParent: () => null,
  }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('@workspace/api-client-react', () => ({
  useSearchInventory: () => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => ({ results: [] })),
    isPending: false,
    isError: false,
    isSuccess: false,
    data: undefined,
    reset: jest.fn(),
  }),
}));

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    border: '#ccc',
    card: '#fff',
    background: '#fff',
    foreground: '#000',
    muted: '#f4f4f5',
    mutedForeground: '#666',
    primary: '#2563eb',
    primaryForeground: '#fff',
    accent: '#f4f4f5',
    accentForeground: '#000',
    success: '#10b981',
    warning: '#f59e0b',
    destructive: '#dc2626',
    overlay: '#00000088',
  }),
}));

jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({
    adminToken: mockAdminToken,
    isAdmin: !!mockAdminToken,
    textFontScale: 1,
    settings: {
      defaultConfidenceThreshold: 60,
      textSize: 'medium',
      themeMode: 'system',
      shelfViewEnabled: false,
    },
  }),
  DEFAULT_SETTINGS: {
    defaultConfidenceThreshold: 60,
    textSize: 'medium',
    themeMode: 'system',
    shelfViewEnabled: false,
  },
}));

jest.mock('@/components/FilterPanel', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub() {
    return R.createElement('div', { 'data-testid': 'filter-panel' });
  }
  return {
    FilterPanel: Stub,
    ConfidenceSlider: Stub,
    CHIP_DIMS: { height: 32, gap: 8 },
  };
});

jest.mock('@/components/ResultCard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub() {
    return R.createElement('div', { 'data-testid': 'result-card' });
  }
  return { ResultCard: Stub };
});

jest.mock('@/components/SkeletonResultCard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub() {
    return R.createElement('div', { 'data-testid': 'skeleton-card' });
  }
  return { SkeletonResultCard: Stub };
});

jest.mock('@/components/ResultRefinementBar', () => ({
  ResultRefinementBar: () => null,
  applyRefinement: (results: unknown[]) => results,
  extractHighlightTokens: () => [],
}));

jest.mock('@/components/ReferenceModal', () => ({ ReferenceModal: () => null }));

jest.mock('@/components/RecordEditModal', () => ({ RecordEditModal: () => null }));

jest.mock('@/components/BrowseTaxonomy', () => {
  function Stub() {
    return null;
  }
  return { __esModule: true, default: Stub };
});

// BrowseByAisle spy — exposes onEditKeywords via data attribute.
jest.mock('@/components/BrowseByAisle', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function BrowseByAisleSpy({
    onEditKeywords,
    onClose,
  }: {
    onEditKeywords?: unknown;
    onClose?: () => void;
    [key: string]: unknown;
  }) {
    return R.createElement('div', {
      'data-testid': 'browse-by-aisle',
      'data-has-edit': onEditKeywords ? 'true' : 'false',
      onClick: onClose,
    });
  }
  return { BrowseByAisle: BrowseByAisleSpy };
});

jest.mock('@expo/vector-icons', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function IconStub({ name }: { name: string }) {
    return R.createElement('span', {}, name);
  }
  return { Feather: IconStub, MaterialCommunityIcons: IconStub };
});

jest.mock('@/styles/shared', () => ({ secondaryBtnBase: {} }));

jest.mock('@/lib/tradeSize', () => ({
  parseTradeSizeInches: () => null,
  isConduitOrPipe: () => false,
  formatInchesAsFraction: () => '',
}));

jest.mock('@/lib/syncInventory', () => ({
  syncAllInventory: jest.fn(async () => []),
}));

jest.mock('@/lib/updateFuseCache', () => ({
  FUSE_CACHE_KEY: 'parts_id_fuse_cache_v3',
  updateFuseCache: jest.fn(async () => undefined),
}));

jest.mock('expo-glass-effect', () => ({
  isLiquidGlassAvailable: () => false,
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { act, fireEvent, render, screen } from '@testing-library/react';
import SearchScreen from '../app/(tabs)/index';

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Search tab (index.tsx) — BrowseByAisle receives onEditKeywords based on adminToken', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('BrowseByAisle receives onEditKeywords when adminToken is set (admin)', async () => {
    mockAdminToken = 'admin-secret';

    await act(async () => {
      render(<SearchScreen />);
      await new Promise((r) => setTimeout(r, 0));
    });

    // Click the "Browse parts by aisle, section, and shelf" entry button
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /browse parts by aisle/i }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const spy = screen.getByTestId('browse-by-aisle');
    expect(spy.getAttribute('data-has-edit')).toBe('true');
  });

  it('BrowseByAisle receives undefined onEditKeywords when adminToken is null (non-admin)', async () => {
    mockAdminToken = null;

    await act(async () => {
      render(<SearchScreen />);
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /browse parts by aisle/i }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const spy = screen.getByTestId('browse-by-aisle');
    expect(spy.getAttribute('data-has-edit')).toBe('false');
  });
});
