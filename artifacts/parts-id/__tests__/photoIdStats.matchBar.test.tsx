/**
 * @jest-environment jsdom
 *
 * Verifies that tapping a MatchBar segment (or legend label) opens the Photo
 * Events modal with the correct `initialMatchType` pre-filter, and that the
 * drill-down button label reflects the active filter.
 *
 *   1. Tapping "Filter by descriptive match type" bar segment sets
 *      initialMatchType="descriptive" on PhotoEventsModal and shows the modal.
 *   2. Tapping "Filter events by Catalog N" legend item sets
 *      initialMatchType="catalog_exact".
 *   3. Tapping the "Total scans" KPI clears the filter (initialMatchType
 *      becomes undefined) and still shows the modal.
 *   4. Drill-down button label reads "View N descriptive scans →" while the
 *      descriptive filter is active and "View individual events →" when no
 *      filter is selected.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';

// ── Mutable mock placed before jest.mock calls ────────────────────────────────
const mockGetPhotoStats = jest.fn();

// ── @workspace/api-client-react mock ─────────────────────────────────────────
jest.mock('@workspace/api-client-react', () => ({
  getPhotoStats: (...args: unknown[]) => mockGetPhotoStats(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

// ── PhotoEventsModal mock — renders initialMatchType as a DOM attribute so
//    tests can inspect which filter was passed without needing a spy fn ────────
jest.mock('@/components/PhotoEventsModal', () => ({
  __esModule: true,
  default: ({
    visible,
    initialMatchType,
  }: {
    visible: boolean;
    initialMatchType?: string;
    onClose: () => void;
    adminHeaders: Record<string, string>;
    onExpiredSession: () => void;
    windowHours: number;
  }) => {
    if (!visible) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react').createElement('div', {
      'data-testid': 'photo-events-modal',
      'data-match-type': initialMatchType ?? '',
    });
  },
}));

// ── react-native mock ─────────────────────────────────────────────────────────
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
        behavior: _bh,
        keyboardShouldPersistTaps: _kspt,
        keyboardVerticalOffset: _kvo,
        onLayout: _ol,
        returnKeyType: _rkt,
        onSubmitEditing: _ose,
        multiline: _ml,
        placeholderTextColor: _ptc,
        ...rest
      } = props;
      const a11y: Record<string, unknown> = {};
      if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
      if (accessibilityRole != null) a11y['role'] = accessibilityRole;
      return React.createElement(
        tag,
        { ref, style: flatStyle(style), ...a11y, ...rest },
        children as React.ReactNode
      );
    });
  }

  const ScrollView = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: () => {}, scrollToOffset: () => {} }), []);
    const { children, style, contentContainerStyle: _ccs, ...rest } = props;
    return React.createElement(
      'div',
      { ref, style: flatStyle(style), ...rest },
      children as React.ReactNode
    );
  });

  const Pressable = React.forwardRef(
    (
      {
        onPress,
        children,
        accessibilityLabel,
        accessibilityRole,
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
          ...rest,
        },
        typeof children === 'function'
          ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false })
          : (children as React.ReactNode)
      );
    }
  );
  Pressable.displayName = 'Pressable';

  const StyleSheet = {
    create: <T extends object>(obj: T): T => obj,
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  const ActivityIndicator = ({ testID, ...rest }: Record<string, unknown>) =>
    React.createElement('div', {
      'data-testid': testID ?? 'activity-indicator',
      'aria-label': 'loading',
      ...rest,
    });
  ActivityIndicator.displayName = 'ActivityIndicator';

  return {
    View: makeHost('div'),
    Text: makeHost('span'),
    ScrollView,
    TextInput: makeHost('input'),
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o['web'] ?? o['default'] },
  };
});

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    border: '#e2e8f0',
    card: '#fff',
    background: '#fff',
    foreground: '#0f172a',
    muted: '#f1f5f9',
    mutedForeground: '#64748b',
    primary: '#2563eb',
    primaryForeground: '#fff',
    success: '#10b981',
    warning: '#f59e0b',
    destructive: '#ef4444',
  }),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { act, fireEvent, render, screen } from '@testing-library/react';
import PhotoIdStatsSection from '../components/PhotoIdStatsSection';
import type { PhotoStatsResponse } from '@workspace/api-client-react';

// ── Helpers ───────────────────────────────────────────────────────────────────
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Stats with non-zero catalog/attribute/descriptive counts so all MatchBar
// segments render and the drill-down button shows concrete numbers.
const STATS: PhotoStatsResponse = {
  windowHours: 24,
  totalScans: 18,
  parseSuccessRate: 0.95,
  confirmationRate: 0.8,
  matchTypeDistribution: { catalogExact: 10, attributeMatch: 5, descriptive: 3 },
  avgLatencyMs: 1200,
  p95LatencyMs: 2500,
  topConfirmedParts: [],
};

const ADMIN_HEADERS = { Authorization: 'Bearer test-token' };

async function renderExpanded() {
  mockGetPhotoStats.mockResolvedValue(STATS);
  render(<PhotoIdStatsSection adminHeaders={ADMIN_HEADERS} onExpiredSession={() => {}} />);
  act(() => {
    fireEvent.click(screen.getByLabelText('Expand Photo ID stats'));
  });
  await flush();
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('PhotoIdStatsSection — MatchBar segment / legend opens events modal pre-filtered', () => {
  beforeAll(() => {
    jest.setTimeout(20_000);
  });

  beforeEach(() => {
    mockGetPhotoStats.mockReset();
  });

  it('tapping the Descriptive bar segment opens the modal with initialMatchType="descriptive"', async () => {
    await renderExpanded();

    // Modal must be closed initially
    expect(screen.queryByTestId('photo-events-modal')).toBeNull();

    act(() => {
      fireEvent.click(screen.getByLabelText('Filter by descriptive match type'));
    });

    const modal = screen.getByTestId('photo-events-modal');
    expect(modal).toBeTruthy();
    expect(modal.getAttribute('data-match-type')).toBe('descriptive');
  });

  it('tapping the Catalog legend item opens the modal with initialMatchType="catalog_exact"', async () => {
    await renderExpanded();

    act(() => {
      // Legend label is "Catalog 10" (number appended by the component)
      fireEvent.click(screen.getByLabelText('Filter events by Catalog 10'));
    });

    const modal = screen.getByTestId('photo-events-modal');
    expect(modal.getAttribute('data-match-type')).toBe('catalog_exact');
  });

  it('tapping the Attribute bar segment opens the modal with initialMatchType="attribute_match"', async () => {
    await renderExpanded();

    act(() => {
      fireEvent.click(screen.getByLabelText('Filter by attribute match type'));
    });

    const modal = screen.getByTestId('photo-events-modal');
    expect(modal.getAttribute('data-match-type')).toBe('attribute_match');
  });

  it('tapping the "Total scans" KPI opens the modal with no filter (initialMatchType undefined)', async () => {
    await renderExpanded();

    // First set a filter so we can verify it is cleared
    act(() => {
      fireEvent.click(screen.getByLabelText('Filter by descriptive match type'));
    });
    expect(screen.getByTestId('photo-events-modal').getAttribute('data-match-type')).toBe(
      'descriptive'
    );

    // Tap "Total scans" — clears the filter
    act(() => {
      fireEvent.click(screen.getByLabelText('View events for Total scans'));
    });

    const modal = screen.getByTestId('photo-events-modal');
    // initialMatchType = undefined → rendered as empty string by the mock
    expect(modal.getAttribute('data-match-type')).toBe('');
  });

  it('drill-down button shows "View 3 descriptive scans →" after tapping descriptive segment', async () => {
    await renderExpanded();

    // Before any selection the default button label is "View individual events →"
    expect(screen.getByText('View individual events →')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByLabelText('Filter by descriptive match type'));
    });

    // Label updates to include the filtered count (3 descriptive)
    expect(screen.getByText('View 3 descriptive scans →')).toBeTruthy();
    expect(screen.queryByText('View individual events →')).toBeNull();
  });

  it('drill-down button reverts to "View individual events →" after pressing Total scans', async () => {
    await renderExpanded();

    // Set a filter first
    act(() => {
      fireEvent.click(screen.getByLabelText('Filter by descriptive match type'));
    });
    expect(screen.getByText('View 3 descriptive scans →')).toBeTruthy();

    // Clear by pressing Total scans KPI
    act(() => {
      fireEvent.click(screen.getByLabelText('View events for Total scans'));
    });

    expect(screen.getByText('View individual events →')).toBeTruthy();
    expect(screen.queryByText('View 3 descriptive scans →')).toBeNull();
  });
});
