/**
 * @jest-environment jsdom
 *
 * Verifies that ResultCard sorts breaker variants correctly (Task #428).
 *
 * The key regression guard: variants whose catalog numbers don't match the
 * BREAKER_RE regex must still sort by amp rating when the materialized DB
 * `amperage` field is present — they must NOT float to the end.
 *
 * Sort order contract:
 *   1. Amperage ascending  (DB field preferred over regex parse)
 *   2. Pole count ascending (DB field preferred over regex parse)
 *   3. Catalog alpha when neither can be resolved
 *
 * Uses the real `parseBreakerCatalog` implementation (not mocked) so any
 * regex refactor that breaks extraction is caught here too.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SearchResult } from '@workspace/api-client-react';

jest.mock('react-native', () => {
  const React = require('react');

  function flatStyle(style: unknown): object | undefined {
    if (!style) return undefined;
    if (Array.isArray(style)) {
      return Object.assign({}, ...(style as unknown[]).filter(Boolean).map(flatStyle));
    }
    if (typeof style === 'function') return undefined;
    return style as object;
  }

  const Text = React.forwardRef(
    (
      {
        children,
        style,
        numberOfLines: _nl,
        ellipsizeMode: _em,
        allowFontScaling: _afs,
        ...rest
      }: Record<string, unknown>,
      ref: React.Ref<unknown>
    ) => React.createElement('span', { ref, style: flatStyle(style), ...rest }, children)
  );
  Text.displayName = 'Text';

  const View = React.forwardRef(
    ({ children, style, ...rest }: Record<string, unknown>, ref: React.Ref<unknown>) =>
      React.createElement('div', { ref, style: flatStyle(style), ...rest }, children)
  );
  View.displayName = 'View';

  const ScrollView = React.forwardRef(
    ({ children, style, ...rest }: Record<string, unknown>, ref: React.Ref<unknown>) =>
      React.createElement('div', { ref, style: flatStyle(style), ...rest }, children)
  );
  ScrollView.displayName = 'ScrollView';

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
          ? (children as (s: { pressed: boolean }) => unknown)({ pressed: false })
          : children
      );
    }
  );
  Pressable.displayName = 'Pressable';

  const Modal = ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? React.createElement('div', { role: 'dialog' }, children) : null;
  Modal.displayName = 'Modal';

  const StyleSheet = {
    create: (obj: object) => obj,
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  return {
    View,
    Text,
    ScrollView,
    TextInput: View,
    Pressable,
    Modal,
    StyleSheet,
    useWindowDimensions: () => ({ width: 375, height: 812, scale: 2, fontScale: 1 }),
    Animated: {
      Value: class {
        constructor(_v: number) {}
        setValue(_v: number) {}
        interpolate() {
          return this as unknown;
        }
      },
      View,
      Text,
      spring: () => ({
        start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }),
        stop: () => {},
        reset: () => {},
      }),
      timing: () => ({
        start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }),
        stop: () => {},
        reset: () => {},
      }),
      createAnimatedComponent: (C: unknown) => C,
      event: () => () => {},
      parallel: () => ({
        start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }),
        stop: () => {},
        reset: () => {},
      }),
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Platform: {
      OS: 'web',
      select: (o: Record<string, unknown>) => o['web'] ?? o['default'],
    },
  };
});

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
  }),
}));

jest.mock('@/lib/refinement', () => ({
  splitHighlightSegments: (text: string) => [{ text, match: false }],
}));

jest.mock('@/lib/tradeSize', () => jest.requireActual('@/lib/tradeSize'));

import { ResultCard } from '@/components/ResultCard';

type ItemExtras = { amperage?: number | null; poleCount?: number | null };

function makeVariant(
  id: number,
  catalog: string,
  extras: ItemExtras = {}
): SearchResult['item'] & ItemExtras {
  return {
    id,
    vendor: 'ETN',
    catalog,
    description: `Breaker ${catalog}`,
    binLocations: [`A-${id}`],
    aiKeywords: [],
    vendorFullName: null,
    enrichedAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    seriesName: null,
    tradeSize: null,
    ...extras,
  } as SearchResult['item'] & ItemExtras;
}

function makeResult(
  catalog: string,
  variants: (SearchResult['item'] & ItemExtras)[],
  extras: ItemExtras = {}
): SearchResult {
  const item = makeVariant(0, catalog, extras);
  return {
    item,
    confidence: 0.9,
    matchReason: 'keyword',
    seriesLabel: undefined,
    variants: variants as unknown as SearchResult['variants'],
  };
}

/**
 * Expand the variants panel and return catalog names in rendered order.
 *
 * VariantRow renders each entry as a Pressable with aria-label:
 *   "Open ETN CATALOG, bin A-N"   (when bin exists)
 *   "Open ETN CATALOG, no bin"    (when no bin)
 * We parse the catalog out of that pattern.
 */
function expandAndGetCatalogs(): string[] {
  // The variants toggle button has aria-label containing "OTHER RATINGS"
  const toggle = screen.getByRole('button', { name: /Other ratings/i });
  fireEvent.click(toggle);

  // Each variant row has aria-label "Open VENDOR CATALOG, ..."
  const rows = screen.getAllByRole('button', { name: /^Open /i });
  return rows.map((el) => {
    const label = el.getAttribute('aria-label') ?? '';
    // "Open ETN BR120 — 20A 1-Pole, bin A-1" or "Open ETN BR120, bin A-1"
    // We want the catalog token (third word), stopping before " — " or ","
    const afterVendor = label.replace(/^Open \S+ /, '');
    return afterVendor.split(/[ ,—]/)[0] ?? afterVendor;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ResultCard — breaker variant sort order (Task #428)', () => {
  it('sorts standard catalog variants by amperage ascending (regex-resolved)', () => {
    // BR150=50A, BR120=20A, BR130=30A → sorted: 20, 30, 50
    const variants = [makeVariant(1, 'BR150'), makeVariant(2, 'BR120'), makeVariant(3, 'BR130')];
    render(<ResultCard result={makeResult('BR115', variants)} rank={0} />);
    expect(expandAndGetCatalogs()).toEqual(['BR120', 'BR130', 'BR150']);
  });

  it('sorts unusual catalog variants by DB amperage field, not regex parse', () => {
    // CUSTOM60, CUSTOM15, CUSTOM30 don't match BREAKER_RE.
    // Without the fix all resolve to Infinity → sort by catalog alpha (C60,C15,C30).
    // With the fix they sort by DB amperage: 15 → 30 → 60.
    const variants = [
      makeVariant(1, 'CUSTOM60', { amperage: 60, poleCount: 1 }),
      makeVariant(2, 'CUSTOM15', { amperage: 15, poleCount: 1 }),
      makeVariant(3, 'CUSTOM30', { amperage: 30, poleCount: 1 }),
    ];
    render(
      <ResultCard
        result={makeResult('CUSTOM20', variants, { amperage: 20, poleCount: 1 })}
        rank={0}
        categorySlug="Breaker"
      />
    );
    expect(expandAndGetCatalogs()).toEqual(['CUSTOM15', 'CUSTOM30', 'CUSTOM60']);
  });

  it('mixes standard and unusual catalogs, sorting all by resolved amperage', () => {
    // BR130=regex 30A, ODDPART=DB 15A, QO250=regex 50A, WEIRDO=DB 40A
    // Expected order: ODDPART(15), BR130(30), WEIRDO(40), QO250(50)
    const variants = [
      makeVariant(1, 'BR130'),
      makeVariant(2, 'ODDPART', { amperage: 15, poleCount: 1 }),
      makeVariant(3, 'QO250'),
      makeVariant(4, 'WEIRDO', { amperage: 40, poleCount: 2 }),
    ];
    render(<ResultCard result={makeResult('BR120', variants)} rank={0} />);
    expect(expandAndGetCatalogs()).toEqual(['ODDPART', 'BR130', 'WEIRDO', 'QO250']);
  });

  it('uses pole count as secondary sort key when amperage is equal', () => {
    // BR220=20A 2-pole, BR120=20A 1-pole → 1-pole first
    const variants = [makeVariant(1, 'BR220'), makeVariant(2, 'BR120')];
    render(<ResultCard result={makeResult('BR130', variants)} rank={0} />);
    expect(expandAndGetCatalogs()).toEqual(['BR120', 'BR220']);
  });

  it('falls back to catalog alpha when neither amps nor poles can be resolved', () => {
    // ZZZ999, AAA001, MMM500 — no regex match, no DB fields
    const variants = [makeVariant(1, 'ZZZ999'), makeVariant(2, 'AAA001'), makeVariant(3, 'MMM500')];
    render(
      <ResultCard
        result={makeResult('CUSTOM', variants, { amperage: 20 })}
        rank={0}
        categorySlug="Breaker"
      />
    );
    expect(expandAndGetCatalogs()).toEqual(['AAA001', 'MMM500', 'ZZZ999']);
  });
});
