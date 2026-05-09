/**
 * @jest-environment jsdom
 *
 * Verifies that PhotoIdStatsSection re-fetches stats whenever the admin
 * changes the window selector chip, and that the dashboard updates correctly.
 *
 *   1. Expanding the section triggers an initial fetch with windowHours=24.
 *   2. Tapping the 7d chip triggers a new fetch with windowHours=168.
 *   3. Tapping the 30d chip triggers a new fetch with windowHours=720.
 *   4. After each window switch the updated stats are displayed and the stale
 *      total from the previous window is no longer shown.
 *   5. While a new request is in-flight (stats not yet replaced) the loading
 *      indicator appears when switching from the collapsed initial state.
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

// ── PhotoEventsModal mock (avoid pulling in complex fetch/modal dependencies) ─
jest.mock('@/components/PhotoEventsModal', () => ({
  __esModule: true,
  default: () => null,
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

function makeStats(totalScans: number, windowHours = 24): PhotoStatsResponse {
  return {
    windowHours,
    totalScans,
    parseSuccessRate: 0.95,
    confirmationRate: 0.8,
    matchTypeDistribution: { catalogExact: 10, attributeMatch: 5, descriptive: 3 },
    avgLatencyMs: 1200,
    p95LatencyMs: 2500,
    topConfirmedParts: [],
  };
}

const ADMIN_HEADERS = { Authorization: 'Bearer test-token' };

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('PhotoIdStatsSection — window selector triggers re-fetch', () => {
  beforeEach(() => {
    mockGetPhotoStats.mockReset();
  });

  it('fetches with windowHours=24 when the section is first expanded', async () => {
    mockGetPhotoStats.mockResolvedValue(makeStats(42, 24));

    render(<PhotoIdStatsSection adminHeaders={ADMIN_HEADERS} onExpiredSession={() => {}} />);

    // Panel is collapsed — no fetch yet
    expect(mockGetPhotoStats).not.toHaveBeenCalled();

    // Expand the panel
    const expandBtn = screen.getByLabelText('Expand Photo ID stats');
    act(() => {
      fireEvent.click(expandBtn);
    });
    await flush();

    expect(mockGetPhotoStats).toHaveBeenCalledTimes(1);
    expect(mockGetPhotoStats).toHaveBeenCalledWith(
      { windowHours: 24 },
      expect.objectContaining({ headers: ADMIN_HEADERS })
    );

    // Stats rendered
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('re-fetches with windowHours=168 when the 7d chip is tapped', async () => {
    mockGetPhotoStats
      .mockResolvedValueOnce(makeStats(42, 24))
      .mockResolvedValueOnce(makeStats(300, 168));

    render(<PhotoIdStatsSection adminHeaders={ADMIN_HEADERS} onExpiredSession={() => {}} />);

    // Expand
    act(() => {
      fireEvent.click(screen.getByLabelText('Expand Photo ID stats'));
    });
    await flush();

    // Initial 24h data shown
    expect(screen.getByText('42')).toBeTruthy();
    expect(mockGetPhotoStats).toHaveBeenCalledTimes(1);

    // Switch to 7d
    act(() => {
      fireEvent.click(screen.getByLabelText('Show last 7d'));
    });
    await flush();

    expect(mockGetPhotoStats).toHaveBeenCalledTimes(2);
    expect(mockGetPhotoStats).toHaveBeenLastCalledWith(
      { windowHours: 168 },
      expect.objectContaining({ headers: ADMIN_HEADERS })
    );

    // New data (300 scans) now shown; stale 42 no longer present
    expect(screen.getByText('300')).toBeTruthy();
    expect(screen.queryByText('42')).toBeNull();
  });

  it('re-fetches with windowHours=720 when the 30d chip is tapped', async () => {
    mockGetPhotoStats
      .mockResolvedValueOnce(makeStats(42, 24))
      .mockResolvedValueOnce(makeStats(1500, 720));

    render(<PhotoIdStatsSection adminHeaders={ADMIN_HEADERS} onExpiredSession={() => {}} />);

    act(() => {
      fireEvent.click(screen.getByLabelText('Expand Photo ID stats'));
    });
    await flush();

    expect(screen.getByText('42')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByLabelText('Show last 30d'));
    });
    await flush();

    expect(mockGetPhotoStats).toHaveBeenCalledTimes(2);
    expect(mockGetPhotoStats).toHaveBeenLastCalledWith(
      { windowHours: 720 },
      expect.objectContaining({ headers: ADMIN_HEADERS })
    );

    expect(screen.getByText('1,500')).toBeTruthy();
    expect(screen.queryByText('42')).toBeNull();
  });

  it('shows a loading indicator on first expand before stats arrive', async () => {
    let resolveStats!: (v: PhotoStatsResponse) => void;
    const pendingStats = new Promise<PhotoStatsResponse>((resolve) => {
      resolveStats = resolve;
    });
    mockGetPhotoStats.mockReturnValue(pendingStats);

    render(<PhotoIdStatsSection adminHeaders={ADMIN_HEADERS} onExpiredSession={() => {}} />);

    act(() => {
      fireEvent.click(screen.getByLabelText('Expand Photo ID stats'));
    });
    // Flush without resolving — loader should be visible
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByLabelText('loading')).toBeTruthy();

    // Resolve the fetch and confirm loader disappears
    await act(async () => {
      resolveStats(makeStats(7, 24));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByLabelText('loading')).toBeNull();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('hides stale 24h data and shows a loading indicator while the 7d request is in-flight', async () => {
    // Resolve initial 24h fetch immediately
    mockGetPhotoStats.mockResolvedValueOnce(makeStats(42, 24));

    // Second call (7d) stays pending until we manually resolve it
    let resolve7d!: (v: PhotoStatsResponse) => void;
    const pending7d = new Promise<PhotoStatsResponse>((resolve) => {
      resolve7d = resolve;
    });
    mockGetPhotoStats.mockReturnValueOnce(pending7d);

    render(<PhotoIdStatsSection adminHeaders={ADMIN_HEADERS} onExpiredSession={() => {}} />);

    // Expand and wait for 24h stats to render
    act(() => {
      fireEvent.click(screen.getByLabelText('Expand Photo ID stats'));
    });
    await flush();

    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.queryByLabelText('loading')).toBeNull();

    // Switch to 7d — chip press clears stats (setStats(null)) before windowHours changes
    act(() => {
      fireEvent.click(screen.getByLabelText('Show last 7d'));
    });
    // One tick to let the state updates flush (stats=null, loading=true)
    await act(async () => {
      await Promise.resolve();
    });

    // Stale 24h total must be gone
    expect(screen.queryByText('42')).toBeNull();
    // Loading indicator must be visible (loading=true && stats=null)
    expect(screen.getByLabelText('loading')).toBeTruthy();

    // Resolve the 7d request
    await act(async () => {
      resolve7d(makeStats(300, 168));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Loader gone, new data shown
    expect(screen.queryByLabelText('loading')).toBeNull();
    expect(screen.getByText('300')).toBeTruthy();

    // Confirm the second call used windowHours=168
    expect(mockGetPhotoStats).toHaveBeenCalledTimes(2);
    expect(mockGetPhotoStats).toHaveBeenLastCalledWith(
      { windowHours: 168 },
      expect.objectContaining({ headers: ADMIN_HEADERS })
    );
  });

  it('tapping the already-active chip does not clear stats or trigger a re-fetch', async () => {
    mockGetPhotoStats.mockResolvedValueOnce(makeStats(42, 24));

    render(<PhotoIdStatsSection adminHeaders={ADMIN_HEADERS} onExpiredSession={() => {}} />);

    act(() => {
      fireEvent.click(screen.getByLabelText('Expand Photo ID stats'));
    });
    await flush();

    // Initial stats visible
    expect(screen.getByText('42')).toBeTruthy();
    expect(mockGetPhotoStats).toHaveBeenCalledTimes(1);

    // Tap the active 24h chip again
    act(() => {
      fireEvent.click(screen.getByLabelText('Show last 24h'));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Stats must still be visible — no blank state
    expect(screen.getByText('42')).toBeTruthy();
    // No extra fetch
    expect(mockGetPhotoStats).toHaveBeenCalledTimes(1);
    // No loading indicator
    expect(screen.queryByLabelText('loading')).toBeNull();
  });

  it('calls onExpiredSession and does not show an error banner on 401', async () => {
    const { ApiError } = jest.requireMock('@workspace/api-client-react') as {
      ApiError: new (msg: string, status: number) => Error & { status: number };
    };
    mockGetPhotoStats.mockRejectedValue(new ApiError('Unauthorized', 401));

    const onExpiredSession = jest.fn();
    render(
      <PhotoIdStatsSection adminHeaders={ADMIN_HEADERS} onExpiredSession={onExpiredSession} />
    );

    act(() => {
      fireEvent.click(screen.getByLabelText('Expand Photo ID stats'));
    });
    await flush();

    expect(onExpiredSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/error/i)).toBeNull();
  });
});
