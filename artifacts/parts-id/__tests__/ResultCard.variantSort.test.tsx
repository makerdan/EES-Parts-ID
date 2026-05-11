/**
 * @jest-environment jsdom
 *
 * Verifies that breaker variants with non-standard catalog numbers (i.e. ones
 * that parseBreakerCatalog cannot parse) are still sorted amp-ascending when
 * the materialized `amperage` DB column is populated.
 *
 * Done looks like (Task #428):
 *   - Two breaker variants whose catalogs don't match the BR/QO regex but
 *     carry `amperage` DB fields render in amp-ascending order in the panel.
 *   - A variant with a parseable catalog is still sorted correctly alongside
 *     non-parseable ones (regex result beats DB field for that variant).
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
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o['web'] ?? o['default'] },
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

type InventoryItem = SearchResult['item'];

function makeVariant(
  id: number,
  catalog: string,
  amperage: number | null
): InventoryItem & { amperage: number | null } {
  return {
    id,
    vendor: 'ETN',
    catalog,
    description: `${amperage ?? '?'}A Custom Breaker`,
    binLocations: ['A-1'],
    aiKeywords: [],
    vendorFullName: null,
    enrichedAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    seriesName: null,
    tradeSize: null,
    amperage,
  } as InventoryItem & { amperage: number | null };
}

function makeResult(
  item: InventoryItem,
  variants: Array<InventoryItem & { amperage: number | null }>
): SearchResult {
  return {
    item,
    confidence: 0.9,
    matchReason: 'keyword',
    seriesLabel: undefined,
    variants: variants as unknown as SearchResult['variants'],
  };
}

describe('ResultCard — breaker variant sort by amperage (Task #428)', () => {
  it('sorts non-standard-catalog breaker variants amp-ascending via DB amperage field', () => {
    // These catalogs don't match the BR/QO/CH regex, so parseBreakerCatalog
    // returns null. The sort must fall back to the `amperage` DB column.
    const primaryItem = makeVariant(1, 'CUSTOM50', 50);
    const variant60 = makeVariant(2, 'CUSTOM60', 60);
    const variant30 = makeVariant(3, 'CUSTOM30', 30);

    render(
      <ResultCard
        result={makeResult(primaryItem, [variant60, variant30])}
        rank={0}
        categorySlug="Breaker"
      />
    );

    // Open the OTHER RATINGS panel
    const toggle = screen.getByRole('button', { name: /other ratings/i });
    fireEvent.click(toggle);

    // Both variants should be visible. Verify ordering by checking that the
    // 30A catalog appears before the 60A catalog in the DOM.
    const allCatalogs = screen.getAllByText(/CUSTOM\d+/);
    const catalogs = allCatalogs.map((el) => el.textContent);
    const idx30 = catalogs.findIndex((c) => c === 'CUSTOM30');
    const idx60 = catalogs.findIndex((c) => c === 'CUSTOM60');
    expect(idx30).toBeGreaterThanOrEqual(0);
    expect(idx60).toBeGreaterThanOrEqual(0);
    expect(idx30).toBeLessThan(idx60);
  });

  it('mixes parseable and non-parseable catalogs in the correct amp-ascending order', () => {
    // BR120 = 20A (parseable); CUSTOM40 amperage=40 (DB only); BR160 = 60A (parseable)
    const primaryItem = makeVariant(1, 'BR120', 20);
    const variantDb40 = makeVariant(2, 'CUSTOM40', 40);
    const variantParsed60 = makeVariant(3, 'BR160', 60);

    render(
      <ResultCard result={makeResult(primaryItem, [variantParsed60, variantDb40])} rank={0} />
    );

    const toggle = screen.getByRole('button', { name: /other ratings/i });
    fireEvent.click(toggle);

    // CUSTOM40 (40A via DB) should appear before BR160 (60A via regex)
    const allItems = screen.getAllByText(/CUSTOM40|BR160/);
    const texts = allItems.map((el) => el.textContent ?? '');
    // BR160 renders as "BR160 — 60A 1-Pole" (combined label); use includes().
    const idxCustom = texts.findIndex((t) => t.includes('CUSTOM40'));
    const idxBr160 = texts.findIndex((t) => t.includes('BR160'));
    expect(idxCustom).toBeGreaterThanOrEqual(0);
    expect(idxBr160).toBeGreaterThanOrEqual(0);
    expect(idxCustom).toBeLessThan(idxBr160);
  });

  it('places variants with null amperage and non-parseable catalog last', () => {
    // UNKNOWN has no amperage and no parseable catalog → sorts to Infinity (last)
    const primaryItem = makeVariant(1, 'BR150', 50);
    const variantUnknown = makeVariant(2, 'UNKNOWN', null);
    const variantKnown = makeVariant(3, 'CUSTOM20', 20);

    render(
      <ResultCard
        result={makeResult(primaryItem, [variantUnknown, variantKnown])}
        rank={0}
        categorySlug="Breaker"
      />
    );

    const toggle = screen.getByRole('button', { name: /other ratings/i });
    fireEvent.click(toggle);

    const allItems = screen.getAllByText(/CUSTOM20|UNKNOWN/);
    const texts = allItems.map((el) => el.textContent);
    const idxCustom = texts.findIndex((t) => t === 'CUSTOM20');
    const idxUnknown = texts.findIndex((t) => t === 'UNKNOWN');
    expect(idxCustom).toBeGreaterThanOrEqual(0);
    expect(idxUnknown).toBeGreaterThanOrEqual(0);
    expect(idxCustom).toBeLessThan(idxUnknown);
  });
});
