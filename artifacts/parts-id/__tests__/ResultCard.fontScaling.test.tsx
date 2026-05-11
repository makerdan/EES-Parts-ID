/**
 * @jest-environment jsdom
 *
 * Verifies that every scaled Text element in ResultCard carries
 * `allowFontScaling={false}` so system font-size preferences can't
 * overflow the card layout at large fontScale values (e.g. 1.18×).
 *
 * Strategy: override the react-native Text mock for this file to render
 * a `data-allow-font-scaling` attribute into the DOM.  This lets us
 * count and inspect every text node that opt-in or out of OS scaling
 * without relying on React Native internals.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { SearchResult } from '@workspace/api-client-react';

// ── react-native mock (file-level override) ────────────────────────────────
// Key decisions:
//   • Text    — forwards allowFontScaling as data-allow-font-scaling so we can
//               query it; style arrays are flattened before hitting the DOM
//   • View    — renders as <div>; style arrays flattened
//   • Pressable — renders as <div role="button"> to avoid <button>-in-<button>
//               nesting errors caused by the series badge Pressable inside the
//               outer card Pressable
//   • Modal   — renders children when visible so the detail-variant modal
//               doesn't throw during render
jest.mock('react-native', () => {
  const React = require('react');

  // Flatten RN style arrays into a plain object usable by the DOM.
  function flatStyle(style: unknown): object | undefined {
    if (!style) return undefined;
    if (Array.isArray(style)) {
      return Object.assign({}, ...(style as unknown[]).filter(Boolean).map(flatStyle));
    }
    if (typeof style === 'function') return undefined; // animated/pressable fn styles
    return style as object;
  }

  const Text = React.forwardRef(
    (
      {
        allowFontScaling,
        children,
        style,
        numberOfLines: _nl,
        ellipsizeMode: _em,
        ...rest
      }: Record<string, unknown>,
      ref: React.Ref<unknown>
    ) =>
      React.createElement(
        'span',
        {
          ref,
          'data-allow-font-scaling': String(allowFontScaling ?? true),
          style: flatStyle(style),
          ...rest,
        },
        children
      )
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

  // Use <div role="button"> instead of <button> so nested Pressables (e.g.
  // the series badge inside the card outer press area) don't violate the
  // HTML rule that <button> cannot contain <button>.
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

  // Modal: render children inline so expanded card content is testable
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
      Value: class { constructor(_v: number) {} setValue(_v: number) {} interpolate() { return this as unknown; } },
      View,
      Text,
      spring: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }), stop: () => {}, reset: () => {} }),
      timing: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }), stop: () => {}, reset: () => {} }),
      createAnimatedComponent: (C: unknown) => C,
      event: () => () => {},
      parallel: () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb?.({ finished: true }), stop: () => {}, reset: () => {} }),
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o['web'] ?? o['default'] },
  };
});

// ── Auxiliary mocks ────────────────────────────────────────────────────────
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

// Return a single non-matching segment so HighlightedText renders a bare
// string — keeps Text-element counts clean and avoids highlight inline spans.
jest.mock('@/lib/refinement', () => ({
  splitHighlightSegments: (text: string) => [{ text, match: false }],
}));

jest.mock('@/lib/tradeSize', () => ({
  parseTradeSizeInches: () => null,
  formatInchesAsFraction: () => '',
}));

// ── Import after mocks are registered ─────────────────────────────────────
import { ResultCard } from '@/components/ResultCard';

// ── Fixture helpers ────────────────────────────────────────────────────────
function makeResult(overrides: Partial<SearchResult['item']> = {}): SearchResult {
  return {
    item: {
      id: 1,
      vendor: 'ETN',
      catalog: 'BR120',
      description: '20A 1-Pole Circuit Breaker',
      binLocations: ['A-1'],
      aiKeywords: ['breaker', 'eaton'],
      vendorFullName: 'Eaton Corporation',
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

// ── Tests ──────────────────────────────────────────────────────────────────
describe('ResultCard — allowFontScaling', () => {
  const FONT_SCALE = 1.18;

  it('vendor Text has allowFontScaling={false} at 1.18× scale', () => {
    render(<ResultCard result={makeResult()} rank={0} fontScale={FONT_SCALE} />);
    const vendorNode = screen.getByText('ETN');
    expect(vendorNode.getAttribute('data-allow-font-scaling')).toBe('false');
  });

  it('catalog Text has allowFontScaling={false} at 1.18× scale', () => {
    render(<ResultCard result={makeResult()} rank={0} fontScale={FONT_SCALE} />);
    const catalogNode = screen.getByText('BR120');
    expect(catalogNode.getAttribute('data-allow-font-scaling')).toBe('false');
  });

  it('description Text has allowFontScaling={false} at 1.18× scale', () => {
    render(<ResultCard result={makeResult()} rank={0} fontScale={FONT_SCALE} />);
    const descNode = screen.getByText('20A 1-Pole Circuit Breaker');
    expect(descNode.getAttribute('data-allow-font-scaling')).toBe('false');
  });

  it('series badge Text has allowFontScaling={false} at 1.18× scale', () => {
    const result = makeResult({ seriesName: 'BR Series' });
    render(<ResultCard result={result} rank={0} fontScale={FONT_SCALE} />);
    // seriesName set but no variants → badge reads "Part of BR Series"
    const badgeNode = screen.getByText('Part of BR Series');
    expect(badgeNode.getAttribute('data-allow-font-scaling')).toBe('false');
  });

  it('all four key scaled Text nodes carry allowFontScaling={false} together', () => {
    // Single render that exercises all four guarded elements at once.
    // seriesName set so the badge is present; no variants so no toggle needed.
    const result = makeResult({ seriesName: 'BR Series' });
    render(<ResultCard result={result} rank={0} fontScale={FONT_SCALE} />);

    const nodes = {
      vendor: screen.getByText('ETN'),
      catalog: screen.getByText('BR120'),
      description: screen.getByText('20A 1-Pole Circuit Breaker'),
      seriesBadge: screen.getByText('Part of BR Series'),
    };

    for (const [name, node] of Object.entries(nodes)) {
      expect({ name, value: node.getAttribute('data-allow-font-scaling') }).toEqual({
        name,
        value: 'false',
      });
    }
  });
});
