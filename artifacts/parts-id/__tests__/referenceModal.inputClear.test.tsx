/**
 * @jest-environment jsdom
 *
 * Guards two input-clearing behaviours introduced in Task #320:
 *
 *  1. After the user submits a question the input value is '' immediately —
 *     `setQuestion('')` is called at the very start of `askQuestion()`, before
 *     the network request is even fired.
 *
 *  2. Tapping a quick-lookup chip never pre-fills the input with the chip's
 *     question text — `handleChipPress()` calls `setQuestion('')` and then
 *     shows the answer directly, leaving the input blank.
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

  // Full controlled TextInput — maps onChangeText → onChange so fireEvent.change works.
  // RN-specific props are destructured and discarded to avoid "unknown DOM prop" warnings.
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

/** Flush all pending micro-tasks (multiple rounds for chained promises). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const PLACEHOLDER = 'Ask about any electrical term...';

const GFCI_QUESTION =
  'What does GFCI stand for, how does it work, and where is it required by the NEC?';
const GFCI_ANSWER =
  'GFCI stands for Ground Fault Circuit Interrupter. It monitors current flow and trips ' +
  'within milliseconds if it detects a ground fault, protecting against shock.';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReferenceModal — input clearing behaviour', () => {
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

  it('clears the input immediately after submitting a question', async () => {
    // Keep the send request pending so loading state persists throughout the test —
    // this makes it easier to assert the input value without waiting for the full
    // answer flow to complete.
    let resolveSend!: (r: Response) => void;
    const sendPending = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });

    global.fetch = jest.fn((url: unknown) => {
      const urlStr = String(url ?? '');
      if (urlStr.includes('/reference/quick-lookups')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        } as Response);
      }
      if (urlStr.includes('/reference/ask')) {
        return sendPending;
      }
      return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
    }) as typeof global.fetch;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    // Wait for the pre-fetch (returns empty) to settle.
    await flush();

    // The modal is in the empty state: inline input + Quick Lookup chips are visible.
    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    expect(input.value).toBe('');

    // Type a question.
    fireEvent.change(input, { target: { value: 'What is EMT conduit?' } });
    expect(input.value).toBe('What is EMT conduit?');

    // Press send (the → button).
    await act(async () => {
      fireEvent.click(screen.getByText('→'));
    });

    // `setQuestion('')` is called at the very start of askQuestion(), before
    // the network request. The bottom-bar input now appears (loading=true) and
    // must reflect the cleared value.
    const bottomInput = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    expect(bottomInput.value).toBe('');

    // Resolve the pending send to avoid open-handle warnings.
    resolveSend({ ok: false, json: () => Promise.resolve({}) } as Response);
    await flush();
  });

  it('input stays blank when a cached quick-lookup chip is tapped', async () => {
    // Pre-seed the in-memory cache via the bulk pre-fetch endpoint.
    global.fetch = jest.fn((url: unknown) => {
      const urlStr = String(url ?? '');
      if (urlStr.includes('/reference/quick-lookups')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ label: 'GFCI', answer: GFCI_ANSWER }]),
        } as Response);
      }
      // No other fetch should be called for a cache hit.
      return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
    }) as typeof global.fetch;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    // Wait for the pre-fetch to populate the in-memory cache.
    await flush();

    // Confirm the empty state: input is blank and the GFCI chip is visible.
    expect((screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement).value).toBe('');

    // Tap the GFCI chip.
    act(() => {
      fireEvent.click(screen.getByText('GFCI'));
    });
    await flush();

    // The answer is displayed from the cache.
    expect(screen.getByText((t) => t.includes('GFCI stands for'))).toBeTruthy();

    // The input (now the bottom-bar input, since the answer is visible) must be
    // blank — handleChipPress calls setQuestion('') and never populates the input
    // with the chip question text.
    const bottomInput = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    expect(bottomInput.value).toBe('');

    // Confirm the full chip question text was NOT put into the input.
    expect(bottomInput.value).not.toBe(GFCI_QUESTION);
  });

  it('input stays blank when a chip is tapped even if the user had typed something first', async () => {
    global.fetch = jest.fn((url: unknown) => {
      const urlStr = String(url ?? '');
      if (urlStr.includes('/reference/quick-lookups')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ label: '1G', answer: 'A 1-gang box holds one device.' }]),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${urlStr}`));
    }) as typeof global.fetch;

    render(<ReferenceModal open={true} onClose={() => {}} />);
    await flush();

    // Type something into the inline input before tapping any chip.
    const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'partial query' } });
    expect(input.value).toBe('partial query');

    // Tap the 1G chip — it has a cached answer so it should display instantly.
    act(() => {
      fireEvent.click(screen.getByText('1G'));
    });
    await flush();

    // The bottom-bar input must be '' — not 'partial query' nor the chip question.
    const bottomInput = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
    expect(bottomInput.value).toBe('');
  });
});
