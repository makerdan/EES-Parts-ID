/**
 * @jest-environment jsdom
 *
 * Verifies that the "✨ Suggest improved description" button renders in both
 * KeywordEditor and RecordEditModal, and that the AI suggestion flow works
 * correctly: success shows the AI SUGGESTION block with "Use this", and
 * failure shows an inline error message.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

// ── Mutable suggest mock — reset per-test ─────────────────────────────────
const mockSuggestMutateAsync = jest.fn();
let mockIsSuggesting = false;

// ── react-native mock ──────────────────────────────────────────────────────
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
        accessibilityState,
        numberOfLines: _nl,
        ellipsizeMode: _em,
        allowFontScaling: _afs,
        hitSlop: _hs,
        android_ripple: _ar,
        horizontal: _h,
        showsHorizontalScrollIndicator: _shi,
        showsVerticalScrollIndicator: _svi,
        contentContainerStyle: _ccs,
        scrollEventThrottle: _set,
        onScroll: _os,
        behavior: _bv,
        keyboardVerticalOffset: _kvo,
        keyboardShouldPersistTaps: _kspt,
        ...rest
      } = props;
      const a11y: Record<string, unknown> = {};
      if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
      if (accessibilityRole != null) a11y['role'] = accessibilityRole;
      if (accessibilityState && (accessibilityState as { selected?: boolean }).selected != null) {
        a11y['aria-selected'] = (accessibilityState as { selected?: boolean }).selected;
      }
      return R.createElement(
        tag,
        { ref, style: flatStyle(style), ...a11y, ...rest },
        children as React.ReactNode
      );
    });
  }

  const View = makeHost('div');
  const Text = makeHost('span');
  const ScrollView = makeHost('div');
  const KeyboardAvoidingView = makeHost('div');
  const ActivityIndicator = makeHost('div');

  const TextInput = R.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const { value, onChangeText, placeholder, accessibilityLabel, style, ...rest } = props;
    return R.createElement('input', {
      ref,
      value: (value as string) ?? '',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        if (typeof onChangeText === 'function') onChangeText(e.target.value);
      },
      placeholder: placeholder as string,
      'aria-label': accessibilityLabel,
      style: flatStyle(style),
      ...rest,
    });
  });

  const Pressable = R.forwardRef(
    (
      {
        onPress,
        children,
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        style,
        disabled,
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
      const a11y: Record<string, unknown> = {};
      if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
      if (
        accessibilityState &&
        typeof accessibilityState === 'object' &&
        'disabled' in (accessibilityState as object)
      ) {
        a11y['aria-disabled'] = (accessibilityState as { disabled: boolean }).disabled;
      }
      return R.createElement(
        'button',
        {
          ref,
          type: 'button',
          role: (accessibilityRole as string) ?? 'button',
          onClick: onPress,
          disabled: !!disabled,
          style: resolvedStyle,
          ...a11y,
          ...rest,
        },
        typeof children === 'function'
          ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false })
          : (children as React.ReactNode)
      );
    }
  );

  const Modal = ({
    visible,
    children,
  }: {
    visible: boolean;
    children: React.ReactNode;
    animationType?: string;
    transparent?: boolean;
    presentationStyle?: string;
    onRequestClose?: () => void;
  }) => (visible ? R.createElement('div', { role: 'dialog' }, children) : null);

  const Switch = ({
    value,
    onValueChange,
    accessibilityLabel,
    accessibilityRole,
  }: {
    value: boolean;
    onValueChange?: (v: boolean) => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    trackColor?: unknown;
    thumbColor?: string;
  }) =>
    R.createElement('input', {
      type: 'checkbox',
      checked: value,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(e.target.checked),
      'aria-label': accessibilityLabel,
      role: accessibilityRole ?? 'switch',
    });

  const StyleSheet = {
    create: <T extends object>(obj: T): T => obj,
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  return {
    View,
    Text,
    ScrollView,
    KeyboardAvoidingView,
    TextInput,
    Pressable,
    Modal,
    Switch,
    StyleSheet,
    ActivityIndicator,
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o['ios'] ?? o['default'] },
  };
});

// ── Dependency mocks ───────────────────────────────────────────────────────
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
    accent: '#eff6ff',
    accentForeground: '#000',
    success: '#10b981',
    warning: '#f59e0b',
    destructive: '#dc2626',
    overlay: '#00000088',
  }),
}));

jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({ isAdmin: true, adminToken: 'test-token', textFontScale: 1 }),
}));

jest.mock('@/components/ErrorBanner', () => {
  const R = require('react') as typeof import('react');
  function ErrorBanner({ message }: { message: string }) {
    return R.createElement('div', { role: 'alert', 'data-testid': 'error-banner' }, message);
  }
  return { ErrorBanner };
});

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('@workspace/api-client-react', () => ({
  useUpdateInventoryItem: () => ({
    mutateAsync: jest.fn().mockResolvedValue({}),
    isPending: false,
  }),
  useSuggestItemDescription: () => ({
    mutateAsync: (...args: unknown[]) => mockSuggestMutateAsync(...args),
    isPending: mockIsSuggesting,
  }),
}));

// ── Imports after mocks ────────────────────────────────────────────────────
import { KeywordEditor } from '@/components/KeywordEditor';
import { RecordEditModal } from '@/components/RecordEditModal';
import type { InventoryItem } from '@workspace/api-client-react';

// ── Fixture ────────────────────────────────────────────────────────────────
function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    vendor: 'SQD',
    catalog: 'QO120',
    description: '20A 1-Pole QO Circuit Breaker',
    binLocations: ['B-3'],
    aiKeywords: ['breaker', 'qo'],
    vendorFullName: 'Schneider Electric',
    enrichedAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    seriesName: null,
    tradeSize: null,
    ...overrides,
  };
}

// ── KeywordEditor tests ────────────────────────────────────────────────────
describe('KeywordEditor — Suggest Description button', () => {
  const item = makeItem();

  afterEach(() => {
    jest.clearAllMocks();
    mockIsSuggesting = false;
  });

  it('renders the Suggest improved description button below the DESCRIPTION field', () => {
    render(<KeywordEditor item={item} onClose={jest.fn()} />);
    expect(screen.getByText('✨ Suggest improved description')).toBeTruthy();
  });

  it('calls useSuggestItemDescription when the Suggest button is pressed', async () => {
    mockSuggestMutateAsync.mockResolvedValue({ description: 'AI-generated description text' });

    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockSuggestMutateAsync).toHaveBeenCalledWith({ id: item.id });
  });

  it('shows the AI SUGGESTION block with suggestion text after a successful call', async () => {
    const suggestedText = 'Schneider Electric QO120 20A Single Pole Circuit Breaker';
    mockSuggestMutateAsync.mockResolvedValue({ description: suggestedText });

    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByText('AI SUGGESTION')).toBeTruthy();
    expect(screen.getByText(suggestedText)).toBeTruthy();
    expect(screen.getByText('Use this')).toBeTruthy();
    expect(screen.getByText('Dismiss')).toBeTruthy();
  });

  it('"Use this" copies the suggestion into the description input', async () => {
    const suggestedText = 'Schneider Electric QO120 20A Single Pole Circuit Breaker';
    mockSuggestMutateAsync.mockResolvedValue({ description: suggestedText });

    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByText('Use this')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('Use this'));
    });

    // After "Use this", the suggestion block should be dismissed
    expect(screen.queryByText('AI SUGGESTION')).toBeNull();
    expect(screen.queryByText('Use this')).toBeNull();

    // The description input should now contain the suggested text
    const descInput = screen.getByDisplayValue(suggestedText);
    expect(descInput).toBeTruthy();
  });

  it('"Dismiss" hides the AI SUGGESTION block without changing the description', async () => {
    const suggestedText = 'AI-generated description text';
    mockSuggestMutateAsync.mockResolvedValue({ description: suggestedText });

    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Dismiss'));
    });

    expect(screen.queryByText('AI SUGGESTION')).toBeNull();
    // The original description should still be in the input
    expect(screen.getByDisplayValue(item.description!)).toBeTruthy();
  });

  it('shows the error banner when the suggest call fails', async () => {
    mockSuggestMutateAsync.mockRejectedValue(new Error('Network error'));

    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText('AI SUGGESTION')).toBeNull();
    const banner = screen.getByTestId('error-banner');
    expect(banner.textContent).toContain("Couldn't generate a suggestion");
  });
});

// ── RecordEditModal tests ──────────────────────────────────────────────────
describe('RecordEditModal — Suggest Description button', () => {
  const item = makeItem();
  const adminHeaders = { Authorization: 'Bearer test-token' };

  afterEach(() => {
    jest.clearAllMocks();
    mockIsSuggesting = false;
  });

  it('renders the Suggest improved description button below the DESCRIPTION field', () => {
    render(
      <RecordEditModal
        item={item}
        adminHeaders={adminHeaders}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );
    expect(screen.getByText('✨ Suggest improved description')).toBeTruthy();
  });

  it('calls useSuggestItemDescription when the Suggest button is pressed', async () => {
    mockSuggestMutateAsync.mockResolvedValue({ description: 'AI-generated text' });

    render(
      <RecordEditModal
        item={item}
        adminHeaders={adminHeaders}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockSuggestMutateAsync).toHaveBeenCalledWith({ id: item.id });
  });

  it('shows the AI SUGGESTION block with suggestion text after a successful call', async () => {
    const suggestedText = 'Schneider Electric QO120 20A Single Pole Circuit Breaker';
    mockSuggestMutateAsync.mockResolvedValue({ description: suggestedText });

    render(
      <RecordEditModal
        item={item}
        adminHeaders={adminHeaders}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByText('AI SUGGESTION')).toBeTruthy();
    expect(screen.getByText(suggestedText)).toBeTruthy();
    expect(screen.getByText('Use this')).toBeTruthy();
    expect(screen.getByText('Dismiss')).toBeTruthy();
  });

  it('"Use this" copies the suggestion into the description input', async () => {
    const suggestedText = 'Schneider Electric QO120 20A Single Pole Circuit Breaker';
    mockSuggestMutateAsync.mockResolvedValue({ description: suggestedText });

    render(
      <RecordEditModal
        item={item}
        adminHeaders={adminHeaders}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Use this'));
    });

    // Suggestion block dismissed
    expect(screen.queryByText('AI SUGGESTION')).toBeNull();
    expect(screen.queryByText('Use this')).toBeNull();

    // Description input now holds the suggested text
    const descInput = screen.getByDisplayValue(suggestedText);
    expect(descInput).toBeTruthy();
  });

  it('"Dismiss" hides the AI SUGGESTION block without changing the description', async () => {
    const suggestedText = 'AI-generated description text';
    mockSuggestMutateAsync.mockResolvedValue({ description: suggestedText });

    render(
      <RecordEditModal
        item={item}
        adminHeaders={adminHeaders}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Dismiss'));
    });

    expect(screen.queryByText('AI SUGGESTION')).toBeNull();
    // Original description still in the input
    expect(screen.getByDisplayValue(item.description!)).toBeTruthy();
  });

  it('shows an inline error message when the suggest call fails', async () => {
    mockSuggestMutateAsync.mockRejectedValue(new Error('Network error'));

    render(
      <RecordEditModal
        item={item}
        adminHeaders={adminHeaders}
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText('✨ Suggest improved description'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.queryByText('AI SUGGESTION')).toBeNull();
    expect(screen.getByText("Couldn't generate a suggestion. Please try again.")).toBeTruthy();
  });
});
