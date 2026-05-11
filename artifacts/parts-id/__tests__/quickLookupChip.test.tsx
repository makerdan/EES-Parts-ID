/**
 * @jest-environment jsdom
 *
 * Verifies the core Quick Lookup promise: chip taps show answers instantly from
 * the server-side pre-fetch cache without ever triggering a loading spinner or
 * the SSE / POST /reference/ask path.
 *
 *   1. GET /reference/quick-lookups is called when the modal opens.
 *   2. After the pre-fetch settles, tapping a chip renders the cached answer
 *      immediately (no round-trip latency visible to the user).
 *   3. No ActivityIndicator is shown (loading state never entered).
 *   4. POST /reference/ask (and every other write) is never called.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';

// ── react-native mock (inline — global __mocks__/react-native.js omits Modal /
//    ActivityIndicator / KeyboardAvoidingView which ReferenceModal requires) ──
jest.mock('react-native', () => {
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

  const Modal = ({
    visible,
    children,
  }: {
    visible: boolean;
    children: React.ReactNode;
    animationType?: string;
    presentationStyle?: string;
    onRequestClose?: () => void;
  }) => (visible ? React.createElement('div', { role: 'dialog' }, children) : null);
  Modal.displayName = 'Modal';

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
    Modal,
    KeyboardAvoidingView: makeHost('div'),
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
    overlay: '#00000088',
  }),
}));

jest.mock('@/components/ErrorBanner', () => ({
  ErrorBanner: ({ message }: { message: string }) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').createElement('div', { role: 'alert' }, message),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ReferenceModal } from '../components/ReferenceModal';

// ── Helpers ───────────────────────────────────────────────────────────────────
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// The GFCI chip's canonical question (from QUICK_LOOKUP_CHIPS in ReferenceModal)
const GFCI_ANSWER =
  'GFCI stands for Ground Fault Circuit Interrupter. It monitors current flow and ' +
  'trips within milliseconds if it detects a ground fault, protecting against shock.';

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('Quick Lookup chips — instant answers from pre-fetch cache', () => {
  let origFetch: typeof global.fetch;

  beforeAll(() => {
    jest.setTimeout(20_000);
  });

  beforeEach(() => {
    origFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
    jest.clearAllMocks();
  });

  it('pre-fetches quick-lookup answers from GET /reference/quick-lookups when the modal opens', async () => {
    const fetchMock = jest.fn((url: unknown) => {
      if (typeof url === 'string' && url.includes('/reference/quick-lookups')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ label: 'GFCI', answer: GFCI_ANSWER }]),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`));
    }) as typeof global.fetch;
    global.fetch = fetchMock;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    await flush();

    const quickLookupCalls = (fetchMock as jest.Mock).mock.calls.filter(([url]: [string]) =>
      url.includes('/reference/quick-lookups')
    );
    expect(quickLookupCalls.length).toBeGreaterThanOrEqual(1);
    expect(quickLookupCalls[0][0]).toMatch(/\/reference\/quick-lookups$/);
  });

  it('tapping a chip shows the cached answer immediately — no ActivityIndicator, no POST call', async () => {
    const fetchMock = jest.fn((url: unknown, init?: RequestInit) => {
      const urlStr = String(url ?? '');
      // Pre-fetch endpoint — return the GFCI answer
      if (
        urlStr.includes('/reference/quick-lookups') &&
        (!init || init.method == null || init.method === 'GET')
      ) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ label: 'GFCI', answer: GFCI_ANSWER }]),
        } as Response);
      }
      // Any other call (POST /reference/ask, per-label lookup, etc.) should not happen
      return Promise.reject(
        new Error(`Unexpected fetch: ${urlStr} method=${init?.method ?? 'GET'}`)
      );
    }) as typeof global.fetch;
    global.fetch = fetchMock;

    render(<ReferenceModal open={true} onClose={() => {}} />);

    // Wait for the pre-fetch to populate the in-memory cache
    await flush();

    // Tap the GFCI chip
    const gfciChip = screen.getByText('GFCI');
    act(() => {
      fireEvent.click(gfciChip);
    });
    await flush();

    // Answer is visible immediately
    expect(screen.getByText((content) => content.includes('GFCI stands for'))).toBeTruthy();

    // No loading spinner — ActivityIndicator must be absent
    expect(screen.queryByLabelText('loading')).toBeNull();

    // No POST to /reference/ask was made
    const postCalls = (fetchMock as jest.Mock).mock.calls.filter(
      ([, init]: [string, RequestInit | undefined]) => init?.method === 'POST'
    );
    expect(postCalls).toHaveLength(0);
  });

  it('does not set loading state when a cached chip answer is displayed', async () => {
    const fetchMock = jest.fn((url: unknown) => {
      if (String(url).includes('/reference/quick-lookups')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve([
              { label: '1G', answer: 'A 1-gang box holds one device and measures 2x3 inches.' },
            ]),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected: ${String(url)}`));
    }) as typeof global.fetch;
    global.fetch = fetchMock;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    await flush();

    // Tap the 1G chip (also pre-seeded in the mock)
    act(() => {
      fireEvent.click(screen.getByText('1G'));
    });
    await flush();

    // Answer text rendered
    expect(screen.getByText((t) => t.includes('1-gang box'))).toBeTruthy();

    // ActivityIndicator never mounted
    expect(screen.queryByLabelText('loading')).toBeNull();
  });
});
