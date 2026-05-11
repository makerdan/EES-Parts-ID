/**
 * @jest-environment jsdom
 *
 * Guards the iOS JSON-mode fix: askQuestion() must call
 * POST /reference/ask?stream=false with Accept: application/json
 * and correctly set the answer state from the returned { answer } JSON body.
 *
 * React Native's fetch does not expose ReadableStream on response bodies on
 * iOS, so the component switched from SSE streaming to a plain JSON round-trip
 * (stream=false). A regression here would silently break all AI answers on iOS
 * while appearing fine in Android and web environments.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';

// ── react-native mock ─────────────────────────────────────────────────────────
jest.mock('react-native', () => {
  const R = require('react') as typeof import('react');

  function flatStyle(style: unknown): object | undefined {
    if (!style) return undefined;
    if (Array.isArray(style))
      return Object.assign({}, ...(style as unknown[]).filter(Boolean).map(flatStyle));
    if (typeof style === 'function') return undefined;
    return style as object;
  }

  function makeHost(tag: string) {
    return R.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      const {
        children,
        style,
        accessibilityLabel,
        accessibilityRole,
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
        ...rest
      } = props;
      const a11y: Record<string, unknown> = {};
      if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
      if (accessibilityRole != null) a11y['role'] = accessibilityRole;
      return R.createElement(
        tag,
        { ref, style: flatStyle(style), ...a11y, ...rest },
        children as React.ReactNode
      );
    });
  }

  const ScrollView = R.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    R.useImperativeHandle(ref, () => ({ scrollTo: () => {}, scrollToOffset: () => {} }), []);
    const {
      children,
      style,
      contentContainerStyle: _ccs,
      keyboardShouldPersistTaps: _kspt,
      scrollEventThrottle: _set,
      onScroll: _os,
      showsVerticalScrollIndicator: _svi,
      showsHorizontalScrollIndicator: _shi,
      ...rest
    } = props;
    return R.createElement(
      'div',
      { ref, style: flatStyle(style), ...rest },
      children as React.ReactNode
    );
  });

  const TextInput = R.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const {
      value,
      onChangeText,
      placeholder,
      accessibilityLabel,
      style,
      placeholderTextColor: _ptc,
      multiline: _ml,
      returnKeyType: _rkt,
      onSubmitEditing: _ose,
      autoCorrect: _ac,
      autoCapitalize: _aca,
      ...rest
    } = props;
    return R.createElement('input', {
      ref,
      value: (value as string) ?? '',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        if (typeof onChangeText === 'function')
          (onChangeText as (t: string) => void)(e.target.value);
      },
      placeholder: placeholder as string,
      'aria-label': accessibilityLabel as string,
      style: flatStyle(style),
      ...rest,
    });
  });
  TextInput.displayName = 'TextInput';

  const Pressable = R.forwardRef(
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
      return R.createElement(
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
  }) => (visible ? R.createElement('div', { role: 'dialog' }, children) : null);
  Modal.displayName = 'Modal';

  const StyleSheet = {
    create: <T extends object>(obj: T): T => obj,
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  const ActivityIndicator = ({ testID, ...rest }: Record<string, unknown>) =>
    R.createElement('div', {
      'data-testid': testID ?? 'activity-indicator',
      'aria-label': 'loading',
      ...rest,
    });
  ActivityIndicator.displayName = 'ActivityIndicator';

  return {
    View: makeHost('div'),
    Text: makeHost('span'),
    ScrollView,
    TextInput,
    Pressable,
    Modal,
    KeyboardAvoidingView: makeHost('div'),
    StyleSheet,
    ActivityIndicator,
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o['ios'] ?? o['default'] },
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

const PLACEHOLDER = 'Ask about any electrical term...';

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('ReferenceModal — iOS JSON mode (askQuestion)', () => {
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

  it('calls POST /reference/ask?stream=false with Accept: application/json', async () => {
    const fetchMock = jest.fn((url: unknown, init?: RequestInit) => {
      const urlStr = String(url ?? '');
      if (urlStr.includes('/reference/quick-lookups') && !urlStr.includes('/quick-lookups/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        } as Response);
      }
      if (urlStr.includes('/reference/ask')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ answer: 'EMT is Electrical Metallic Tubing.' }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${urlStr} ${String(init?.method)}`));
    }) as typeof global.fetch;
    global.fetch = fetchMock;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    await flush();

    // Type a question and submit
    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'What is EMT conduit?' } });

    await act(async () => {
      fireEvent.click(screen.getByText('→'));
    });
    await flush();

    // Find the POST /reference/ask call
    const askCalls = (fetchMock as jest.Mock).mock.calls.filter(([url]: [string]) =>
      String(url).includes('/reference/ask')
    );
    expect(askCalls.length).toBeGreaterThanOrEqual(1);

    const [askUrl, askInit] = askCalls[0] as [string, RequestInit];

    // Must use stream=false query param
    expect(askUrl).toMatch(/[?&]stream=false/);

    // Must send Accept: application/json
    const headers = askInit?.headers as Record<string, string> | undefined;
    expect(headers?.['Accept']).toBe('application/json');

    // Must be a POST
    expect(askInit?.method).toBe('POST');
  });

  it('sets the answer state from the returned { answer } JSON body', async () => {
    const AI_ANSWER =
      'EMT stands for Electrical Metallic Tubing — a thin-walled steel conduit for indoor use.';

    const fetchMock = jest.fn((url: unknown) => {
      const urlStr = String(url ?? '');
      if (urlStr.includes('/reference/quick-lookups') && !urlStr.includes('/quick-lookups/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        } as Response);
      }
      if (urlStr.includes('/reference/ask')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ answer: AI_ANSWER }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
    }) as typeof global.fetch;
    global.fetch = fetchMock;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    await flush();

    // Type and submit a question
    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'What is EMT conduit?' } });

    await act(async () => {
      fireEvent.click(screen.getByText('→'));
    });
    await flush();

    // The answer from the JSON body must appear in the UI.
    // Use document.body.textContent because renderAnswer() splits the answer
    // across multiple <Text> spans, causing getByText() to match multiple nodes.
    expect(document.body.textContent).toContain('Electrical Metallic Tubing');

    // No error banner should be shown
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error state when the JSON response has no answer field', async () => {
    const fetchMock = jest.fn((url: unknown) => {
      const urlStr = String(url ?? '');
      if (urlStr.includes('/reference/quick-lookups') && !urlStr.includes('/quick-lookups/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        } as Response);
      }
      if (urlStr.includes('/reference/ask')) {
        // Server returns ok:true but empty answer — component must show error
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ answer: '' }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
    }) as typeof global.fetch;
    global.fetch = fetchMock;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    await flush();

    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'What is EMT?' } });

    await act(async () => {
      fireEvent.click(screen.getByText('→'));
    });
    await flush();

    // An error banner should be shown when the answer is empty
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('shows the retry banner when the /reference/ask fetch throws a network error', async () => {
    const fetchMock = jest.fn((url: unknown) => {
      const urlStr = String(url ?? '');
      if (urlStr.includes('/reference/quick-lookups') && !urlStr.includes('/quick-lookups/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        } as Response);
      }
      if (urlStr.includes('/reference/ask')) {
        return Promise.reject(new Error('Network request failed'));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
    }) as typeof global.fetch;
    global.fetch = fetchMock;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    await flush();

    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'What is EMT conduit?' } });

    await act(async () => {
      fireEvent.click(screen.getByText('→'));
    });
    await flush();

    // ErrorBanner with role="alert" must be visible
    expect(screen.getByRole('alert')).toBeTruthy();

    // ↺ Retry button must also be visible
    expect(screen.getByText('↺ Retry')).toBeTruthy();
  });

  it('clicking ↺ Retry re-fires the fetch and clears the error on success', async () => {
    const AI_ANSWER = 'EMT stands for Electrical Metallic Tubing.';
    let askCallCount = 0;

    const fetchMock = jest.fn((url: unknown) => {
      const urlStr = String(url ?? '');
      if (urlStr.includes('/reference/quick-lookups') && !urlStr.includes('/quick-lookups/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        } as Response);
      }
      if (urlStr.includes('/reference/ask')) {
        askCallCount += 1;
        if (askCallCount === 1) {
          // First attempt: simulate network failure
          return Promise.reject(new Error('Network request failed'));
        }
        // Retry attempt: succeed with an answer
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ answer: AI_ANSWER }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
    }) as typeof global.fetch;
    global.fetch = fetchMock;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    await flush();

    // Submit initial question — this will fail with a network error
    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'What is EMT conduit?' } });

    await act(async () => {
      fireEvent.click(screen.getByText('→'));
    });
    await flush();

    // Error banner is shown after the first (failing) attempt
    expect(screen.getByRole('alert')).toBeTruthy();

    // Click ↺ Retry — this should trigger a second fetch call
    await act(async () => {
      fireEvent.click(screen.getByText('↺ Retry'));
    });
    await flush();

    // The retry fetch must have been fired (askCallCount is now 2)
    expect(askCallCount).toBe(2);

    // Error banner clears and the answer appears
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).toContain('Electrical Metallic Tubing');
  });
});
