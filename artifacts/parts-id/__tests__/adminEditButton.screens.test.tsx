/**
 * @jest-environment jsdom
 *
 * BrowseByAisle — full drill-down test verifying that the "✏️ Edit Part Details"
 * button shows for admins and is hidden for non-admins.
 *
 * The full component is rendered and driven through its drill-down hierarchy
 * (Aisle → Section → bin slot tap → ResultCard expand → button presence) so
 * ResultCard actually renders in the DOM.
 *
 * Screen-level coverage for Search tab, Photo tab, and Scan screen lives in the
 * dedicated files that render those actual screen modules:
 *   - searchTab.adminEditButton.test.tsx
 *   - photo.adminEditButton.test.tsx
 *   - scan.adminEditButton.test.tsx
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { InventoryItem } from '@workspace/api-client-react';

// ── Mutable per-test context flag ─────────────────────────────────────────────
let mockAdminToken: string | null = 'admin-token-123';
let mockIsAdmin = true;

// ── react-native mock ──────────────────────────────────────────────────────────
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
          role: accessibilityRole ?? 'button',
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

  function FlatList<T>(props: {
    data?: readonly T[] | null;
    renderItem?: (info: { item: T; index: number }) => React.ReactNode;
    keyExtractor?: (item: T, idx: number) => string;
    ListFooterComponent?: React.ReactNode;
    contentContainerStyle?: unknown;
    onScroll?: unknown;
    scrollEventThrottle?: unknown;
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
    TextInput: makeHost('input'),
    Pressable,
    FlatList,
    Modal,
    StyleSheet,
    ActivityIndicator,
    BackHandler,
    PanResponder,
    Platform: {
      OS: 'web',
      select: (o: Record<string, unknown>) => o['web'] ?? o['default'],
    },
    useColorScheme: () => 'light',
    Image: makeHost('img'),
    SafeAreaView: makeHost('div'),
    Linking: { openURL: jest.fn() },
  };
});

// ── Common mocks ───────────────────────────────────────────────────────────────
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
    isAdmin: mockIsAdmin,
    textFontScale: 1,
    settings: { shelfViewEnabled: true },
  }),
}));

jest.mock('@/lib/refinement', () => ({
  splitHighlightSegments: (text: string) => [{ text, match: false }],
}));

jest.mock('@/lib/tradeSize', () => ({
  parseTradeSizeInches: () => null,
  formatInchesAsFraction: () => '',
}));

jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const Stub = ({ name }: { name: string }) => React.createElement('span', {}, name);
  return { Feather: Stub, MaterialCommunityIcons: Stub };
});

// ── Imports after mocks ────────────────────────────────────────────────────────
import { BrowseByAisle } from '@/components/BrowseByAisle';

// ── Shared fixture ─────────────────────────────────────────────────────────────
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

beforeEach(() => {
  mockAdminToken = 'admin-token-123';
  mockIsAdmin = true;
});

// ─────────────────────────────────────────────────────────────────────────────
// BrowseByAisle — full drill-down test
// ─────────────────────────────────────────────────────────────────────────────
describe('BrowseByAisle — Edit Part Details button via onEditKeywords prop', () => {
  const INVENTORY = [makeItem(1, '17-01-100')];

  /**
   * Drill: Aisle 17 → Section 01 → click bin slot (Bin 17-01-100) → expand
   * the ResultCard → assert button.
   */
  function drillToResultCard(onEditKeywords?: (item: InventoryItem) => void) {
    render(
      <BrowseByAisle
        inventory={INVENTORY}
        cacheReady={true}
        onClose={() => {}}
        fontScale={1}
        onEditKeywords={onEditKeywords}
      />
    );

    // ── Aisle level ──────────────────────────────────────────────────────────
    act(() => {
      fireEvent.click(screen.getByText(/Aisle 17/));
    });

    // ── Section level ────────────────────────────────────────────────────────
    act(() => {
      fireEvent.click(screen.getByText(/Section 01/));
    });

    // ── Shelf view: tap the bin slot to select the part ──────────────────────
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Bin 17-01-100: ITEM-1/ }));
    });

    // ── Expand the ResultCard to reveal the edit button area ─────────────────
    const buttons = screen.getAllByRole('button');
    act(() => {
      fireEvent.click(buttons[buttons.length - 1]);
    });
  }

  it('shows the Edit button when onEditKeywords is provided (admin)', () => {
    drillToResultCard(jest.fn());
    expect(screen.getByText('✏️ Edit Part Details')).toBeTruthy();
  });

  it('hides the Edit button when onEditKeywords is omitted (non-admin)', () => {
    drillToResultCard(undefined);
    expect(screen.queryByText('✏️ Edit Part Details')).toBeNull();
  });
});
