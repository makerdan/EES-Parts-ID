/**
 * @jest-environment jsdom
 *
 * Verifies that ResultCard shows a compact "20A 1-Pole" secondary label for
 * breaker items in the same header-right position that the trade-size label
 * occupies for conduit items.
 *
 * Done looks like (Task #426):
 *   - Breaker items (catalog matches BREAKER_RE) show "20A 1-Pole" label
 *   - Non-breaker items with a tradeSize show the tradeSize label
 *   - Non-breaker items without a tradeSize show neither label
 *   - The amp-only or pole-only degenerate cases are handled gracefully
 *
 * Uses the real `parseBreakerCatalog` implementation (not mocked) so any
 * regex refactor that breaks the pattern is caught here too.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
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

// Use real parseBreakerCatalog / parseTradeSizeInches so catalog-regex
// regressions are caught here and not silently swallowed by mocks.
jest.mock('@/lib/tradeSize', () => jest.requireActual('@/lib/tradeSize'));

import { ResultCard } from '@/components/ResultCard';

function makeResult(overrides: Partial<SearchResult['item']> = {}): SearchResult {
  return {
    item: {
      id: 1,
      vendor: 'ETN',
      catalog: 'BR120',
      description: '20A 1-Pole Circuit Breaker',
      binLocations: ['A-1'],
      aiKeywords: [],
      vendorFullName: null,
      enrichedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      seriesName: null,
      tradeSize: null,
      ...overrides,
    },
    confidence: 0.92,
    matchReason: 'keyword',
    seriesLabel: undefined,
    variants: [],
  };
}

describe('ResultCard — breaker compact rating label (Task #426)', () => {
  it('shows "20A 1-Pole" for a standard 1-pole 20A breaker catalog (BR120)', () => {
    render(<ResultCard result={makeResult({ catalog: 'BR120' })} rank={0} />);
    expect(screen.getByText('20A 1-Pole')).toBeTruthy();
  });

  it('shows "30A 2-Pole" for a 2-pole 30A breaker catalog (QO230)', () => {
    render(<ResultCard result={makeResult({ catalog: 'QO230' })} rank={0} />);
    expect(screen.getByText('30A 2-Pole')).toBeTruthy();
  });

  it('shows "100A 3-Pole" for a 3-pole 100A breaker catalog (CH3100)', () => {
    render(<ResultCard result={makeResult({ catalog: 'CH3100' })} rank={0} />);
    expect(screen.getByText('100A 3-Pole')).toBeTruthy();
  });

  it('prefers materialized amperage/poleCount DB fields over catalog parse', () => {
    // Simulate API response that has already resolved the attributes.
    const item = {
      ...makeResult({ catalog: 'BR120' }).item,
      amperage: 20,
      poleCount: 2,
    } as SearchResult['item'];
    render(<ResultCard result={{ ...makeResult(), item }} rank={0} />);
    // poleCount=2 from DB overrides catalog parse (catalog says 1-pole).
    expect(screen.getByText('20A 2-Pole')).toBeTruthy();
  });

  it('shows only amps when poleCount is null', () => {
    // Catalog regex can still supply poles, so use a non-breaker catalog to
    // isolate the amp-only case. Force isBreaker via categorySlug instead.
    const nonBreakerCatalog = {
      ...makeResult({ catalog: 'CUSTOM20' }).item,
      amperage: 20,
      poleCount: null,
    } as unknown as SearchResult['item'];
    render(
      <ResultCard
        result={{ ...makeResult(), item: nonBreakerCatalog }}
        rank={0}
        categorySlug="Breaker"
      />
    );
    expect(screen.getByText('20A')).toBeTruthy();
  });

  it('does NOT show the rating label for a non-breaker item', () => {
    render(
      <ResultCard
        result={makeResult({
          catalog: 'EMT12',
          description: '1/2 inch EMT conduit',
          tradeSize: '1/2"',
        })}
        rank={0}
      />
    );
    // Trade size label shows; the breaker compact label must be absent.
    // Use exact string match so we don't accidentally match description text.
    expect(screen.getByText('1/2"')).toBeTruthy();
    expect(screen.queryByText('20A 1-Pole')).toBeNull();
    expect(screen.queryByText('20A')).toBeNull();
  });

  it('does NOT show either label for a non-breaker item with no trade size', () => {
    render(
      <ResultCard
        result={makeResult({
          catalog: 'MISC001',
          description: 'Miscellaneous hardware part',
          tradeSize: null,
        })}
        rank={0}
      />
    );
    // Neither a rating label nor a trade-size label should render.
    expect(screen.queryByText('20A 1-Pole')).toBeNull();
    expect(screen.queryByText(/^\d+"$/)).toBeNull();
  });
});
