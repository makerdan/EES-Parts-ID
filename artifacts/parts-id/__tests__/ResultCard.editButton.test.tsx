/**
 * @jest-environment jsdom
 *
 * Verifies that the "✏️ Edit Part Details" button inside ResultCard:
 *   1. Appears when `onEditKeywords` is provided (admin path).
 *   2. Is absent when `onEditKeywords` is omitted (non-admin path).
 *   3. Calls `onEditKeywords` with the correct InventoryItem when pressed.
 *
 * The edit button lives in the expanded section of the card, so every test
 * that needs to assert its presence/absence clicks the card to expand it first.
 *
 * Mock strategy mirrors ResultCard.fontScaling.test.tsx:
 *   • Pressable → <div role="button"> with onClick wired to onPress.
 *   • Modal renders children when visible so the detail-variant sheet doesn't
 *     throw during render.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { InventoryItem, SearchResult } from '@workspace/api-client-react';

// ── react-native mock ──────────────────────────────────────────────────────
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

  const View = React.forwardRef(
    ({ children, style, ...rest }: Record<string, unknown>, ref: React.Ref<unknown>) =>
      React.createElement('div', { ref, style: flatStyle(style), ...rest }, children)
  );
  View.displayName = 'View';

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

  const ScrollView = React.forwardRef(
    ({ children, style, ...rest }: Record<string, unknown>, ref: React.Ref<unknown>) =>
      React.createElement('div', { ref, style: flatStyle(style), ...rest }, children)
  );
  ScrollView.displayName = 'ScrollView';

  // Render as <div role="button"> to avoid <button>-in-<button> nesting errors.
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

jest.mock('@/lib/refinement', () => ({
  splitHighlightSegments: (text: string) => [{ text, match: false }],
}));

jest.mock('@/lib/tradeSize', () => ({
  parseTradeSizeInches: () => null,
  formatInchesAsFraction: () => '',
  parseBreakerCatalog: () => null,
  isBreakerCatalog: () => false,
}));

// ── Import after mocks ─────────────────────────────────────────────────────
import { ResultCard } from '@/components/ResultCard';

// ── Fixture helpers ────────────────────────────────────────────────────────
function makeResult(overrides: Partial<InventoryItem> = {}): SearchResult {
  return {
    item: {
      id: 42,
      vendor: 'SQD',
      catalog: 'QO120',
      description: '20A 1-Pole QO Breaker',
      binLocations: ['B-3'],
      aiKeywords: ['breaker', 'qo'],
      vendorFullName: 'Schneider Electric',
      enrichedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      seriesName: null,
      tradeSize: null,
      ...overrides,
    },
    confidence: 0.95,
    matchReason: 'keyword',
    seriesLabel: undefined,
    variants: [],
  };
}

/** Click the outer card Pressable to toggle it open. */
function expandCard() {
  // Query explicitly by the accessibilityLabel added in Task #333 so this
  // helper is not sensitive to button ordering in the tree.
  fireEvent.click(screen.getByRole('button', { name: /— tap to expand$/i }));
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('ResultCard — Edit Part Details button visibility', () => {
  it('shows the Edit button when onEditKeywords is provided (admin)', () => {
    const onEdit = jest.fn();
    render(<ResultCard result={makeResult()} rank={1} onEditKeywords={onEdit} />);
    expandCard();
    expect(screen.getByText('✏️ Edit Part Details')).toBeTruthy();
  });

  it('hides the Edit button when onEditKeywords is omitted (non-admin)', () => {
    render(<ResultCard result={makeResult()} rank={1} />);
    expandCard();
    expect(screen.queryByText('✏️ Edit Part Details')).toBeNull();
  });

  it('hides the Edit button when onEditKeywords is explicitly undefined (non-admin)', () => {
    render(<ResultCard result={makeResult()} rank={1} onEditKeywords={undefined} />);
    expandCard();
    expect(screen.queryByText('✏️ Edit Part Details')).toBeNull();
  });

  it('calls onEditKeywords with the correct InventoryItem when pressed', () => {
    const onEdit = jest.fn();
    const result = makeResult({ catalog: 'QO240', id: 99 });
    render(<ResultCard result={result} rank={1} onEditKeywords={onEdit} />);
    expandCard();
    fireEvent.click(screen.getByText('✏️ Edit Part Details'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(result.item, expect.any(Function));
  });

  it('Edit button is visible before the card is expanded', () => {
    const onEdit = jest.fn();
    render(<ResultCard result={makeResult()} rank={1} onEditKeywords={onEdit} />);
    // Do NOT expand — button must still be in the DOM (always-visible footer)
    expect(screen.getByText('✏️ Edit Part Details')).toBeTruthy();
  });

  it('Edit button stays visible after collapsing the card', () => {
    const onEdit = jest.fn();
    render(<ResultCard result={makeResult()} rank={1} onEditKeywords={onEdit} />);
    expandCard(); // expand
    expect(screen.getByText('✏️ Edit Part Details')).toBeTruthy();
    expandCard(); // collapse (second click)
    // Button remains — it lives outside the expanded block
    expect(screen.getByText('✏️ Edit Part Details')).toBeTruthy();
  });

  it('tapping Edit on a collapsed card fires onEditKeywords with the correct item — no expand needed', () => {
    const onEdit = jest.fn();
    const result = makeResult({ catalog: 'QO130', id: 77 });
    render(<ResultCard result={result} rank={1} onEditKeywords={onEdit} />);

    // Card is in its default collapsed state — do NOT call expandCard().
    // The always-visible footer button must be reachable and functional.
    fireEvent.click(screen.getByText('✏️ Edit Part Details'));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(result.item, expect.any(Function));
  });
});

describe('ResultCard — Edit button inside related-sizes modal', () => {
  it('calls onEditKeywords with the variant item (not the parent item) when Edit is tapped inside the modal', () => {
    const onEdit = jest.fn();

    const parentResult = makeResult({ id: 42, catalog: 'QO120' });

    const variantItem: InventoryItem = {
      id: 55,
      vendor: 'SQD',
      catalog: 'QO240',
      description: '40A 2-Pole QO Breaker',
      binLocations: [],
      aiKeywords: [],
      vendorFullName: 'Schneider Electric',
      enrichedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      seriesName: null,
      tradeSize: null,
    };

    const resultWithVariant: SearchResult = {
      ...parentResult,
      variants: [variantItem],
    };

    render(<ResultCard result={resultWithVariant} rank={1} onEditKeywords={onEdit} />);

    // Open the related-sizes variants panel (always-visible toggle).
    fireEvent.click(screen.getByRole('button', { name: /related sizes/i }));

    // Tap the variant row to open the detail modal. The VariantRow accessibilityLabel
    // is "Open <vendor> <catalog>[, size …][, bin …]" (see ResultCard.tsx ~line 212).
    fireEvent.click(screen.getByRole('button', { name: /Open SQD QO240/i }));

    // The modal is now open. Both the parent card footer and the nested card inside
    // the modal render "✏️ Edit Part Details". Scope to the dialog to target the
    // nested card's button so we verify the correct item is forwarded.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByText('✏️ Edit Part Details'));

    // Must have been called with the variant's InventoryItem, not the parent's.
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(variantItem, expect.any(Function));
    expect(onEdit).not.toHaveBeenCalledWith(parentResult.item, expect.any(Function));
  });

  // ── Task #429: dismissing the modal must NOT trigger Edit ─────────────────
  // The modal contains a full-overlay backdrop Pressable and a "✕ Close"
  // Pressable, both of which call dismissDetail (and never onEditKeywords).
  // A regression where event propagation or button-overlap leaks a press into
  // the nested card's Edit handler would silently call onEditKeywords with
  // the wrong item. These tests guard that boundary.

  /** Open the variant detail modal. Returns the variant item used. */
  function openVariantModal(onEdit: jest.Mock): {
    parentItem: InventoryItem;
    variantItem: InventoryItem;
  } {
    const parentResult = makeResult({ id: 42, catalog: 'QO120' });
    const variantItem: InventoryItem = {
      id: 55,
      vendor: 'SQD',
      catalog: 'QO240',
      description: '40A 2-Pole QO Breaker',
      binLocations: [],
      aiKeywords: [],
      vendorFullName: 'Schneider Electric',
      enrichedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      seriesName: null,
      tradeSize: null,
    };
    const resultWithVariant: SearchResult = { ...parentResult, variants: [variantItem] };

    render(<ResultCard result={resultWithVariant} rank={1} onEditKeywords={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: /related sizes/i }));
    fireEvent.click(screen.getByRole('button', { name: /Open SQD QO240/i }));

    // Sanity check: modal is open before we exercise the dismiss path.
    expect(screen.getByRole('dialog')).toBeTruthy();
    return { parentItem: parentResult.item, variantItem };
  }

  it('does NOT call onEditKeywords when the backdrop is tapped to dismiss the modal', () => {
    const onEdit = jest.fn();
    openVariantModal(onEdit);

    // Backdrop Pressable has accessibilityLabel "Dismiss related size".
    fireEvent.click(screen.getByRole('button', { name: /Dismiss related size/i }));

    expect(onEdit).not.toHaveBeenCalled();
  });

  it('does NOT call onEditKeywords when the ✕ Close button is tapped to close the modal', () => {
    const onEdit = jest.fn();
    openVariantModal(onEdit);

    // The close button has accessibilityLabel "Close related size" (its
    // inner text is "✕ Close" — query by the a11y label so this is robust
    // to glyph changes).
    fireEvent.click(screen.getByRole('button', { name: /Close related size/i }));

    expect(onEdit).not.toHaveBeenCalled();
  });
});
