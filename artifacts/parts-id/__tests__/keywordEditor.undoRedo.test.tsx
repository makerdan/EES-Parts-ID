/**
 * @jest-environment jsdom
 *
 * Verifies that the Undo and Redo buttons in KeywordEditor stay in sync with
 * description edits:
 *   1. Full undo/redo cycle  (edit → undo → redo)
 *   2. A normal edit after an undo clears the redo stack  (standard undo semantics)
 *   3. Opening the editor on a different item resets both stacks
 *   4. Undo failure: persist() rejects → "Save failed" badge, consistent button states
 *   5. Redo failure: persist() rejects → "Save failed" badge, consistent button states
 *   6. Keyword Undo: remove/add keyword → undo restores previous list
 *   7. Trade-size Undo: change trade size → undo restores previous value
 *   8. Both stacks reset when the editor opens on a different item
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

// ── Mutable update mock — reset per-test ──────────────────────────────────
const mockMutateAsync = jest.fn();

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
    mutateAsync: (...args: unknown[]) => mockMutateAsync(...args),
    isPending: false,
  }),
  useSuggestItemDescription: () => ({
    mutateAsync: jest.fn().mockResolvedValue({}),
    isPending: false,
  }),
}));

// ── Imports after mocks ────────────────────────────────────────────────────
import { KeywordEditor } from '@/components/KeywordEditor';
import type { InventoryItem } from '@workspace/api-client-react';

// ── Fixture ────────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 900;

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 1,
    vendor: 'SQD',
    catalog: 'QO120',
    description: 'Original description',
    binLocations: ['A-1'],
    aiKeywords: ['breaker'],
    vendorFullName: 'Schneider Electric',
    enrichedAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    seriesName: null,
    seriesId: null,
    tradeSize: null,
    ...overrides,
  };
}

function getUndoBtn() {
  return screen.getByLabelText('Undo last description change') as HTMLButtonElement;
}

function getRedoBtn() {
  return screen.getByLabelText('Redo last description change') as HTMLButtonElement;
}

function getDescInput() {
  return screen.getByPlaceholderText('Describe this part…') as HTMLInputElement;
}

/** Type into the description input and advance past the debounce, flushing
 *  all resulting state updates and async callbacks. */
async function typeAndSave(newText: string) {
  act(() => {
    fireEvent.change(getDescInput(), { target: { value: newText } });
  });
  await act(async () => {
    jest.advanceTimersByTime(DEBOUNCE_MS);
  });
  // Flush microtasks produced by the mutateAsync promise chain.
  await act(async () => {});
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('KeywordEditor — Undo/Redo button sync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('both buttons are disabled when no edits have been made', () => {
    render(<KeywordEditor item={makeItem()} onClose={jest.fn()} />);

    expect(getUndoBtn().disabled).toBe(true);
    expect(getRedoBtn().disabled).toBe(true);
  });

  it('full undo/redo cycle: edit → undo → redo → undo returns to original', async () => {
    const item = makeItem({ description: 'Original description' });
    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    // Both buttons disabled at start.
    expect(getUndoBtn().disabled).toBe(true);
    expect(getRedoBtn().disabled).toBe(true);

    // Type a new description and let the debounce fire → save succeeds.
    await typeAndSave('Edited description');

    // Undo should now be enabled; Redo still disabled.
    expect(getUndoBtn().disabled).toBe(false);
    expect(getRedoBtn().disabled).toBe(true);

    // Click Undo → rolls back to "Original description".
    await act(async () => {
      fireEvent.click(getUndoBtn());
    });
    await act(async () => {});

    expect(getDescInput().value).toBe('Original description');
    // Undo stack is now empty; Redo stack has the value we undid.
    expect(getUndoBtn().disabled).toBe(true);
    expect(getRedoBtn().disabled).toBe(false);

    // Click Redo → re-applies "Edited description".
    await act(async () => {
      fireEvent.click(getRedoBtn());
    });
    await act(async () => {});

    expect(getDescInput().value).toBe('Edited description');
    // Redo stack is empty again; Undo stack has the prior value.
    expect(getRedoBtn().disabled).toBe(true);
    expect(getUndoBtn().disabled).toBe(false);

    // Click Undo again → back to "Original description", completing the full cycle.
    await act(async () => {
      fireEvent.click(getUndoBtn());
    });
    await act(async () => {});

    expect(getDescInput().value).toBe('Original description');
    expect(getUndoBtn().disabled).toBe(true);
    expect(getRedoBtn().disabled).toBe(false);
  });

  it('a normal edit after an undo clears the redo stack', async () => {
    const item = makeItem({ description: 'Original description' });
    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    // Edit → save → undo (populates redo stack).
    await typeAndSave('First edit');
    await act(async () => {
      fireEvent.click(getUndoBtn());
    });
    await act(async () => {});

    // Redo should be enabled after the undo.
    expect(getRedoBtn().disabled).toBe(false);

    // Now type a brand-new edit and let the debounce fire → redo stack cleared.
    await typeAndSave('Second edit');

    expect(getRedoBtn().disabled).toBe(true);
  });

  it('opening the editor on a different item resets both stacks', async () => {
    const itemA = makeItem({ id: 1, description: 'Item A description' });
    const itemB = makeItem({ id: 2, description: 'Item B description' });

    const { rerender } = render(<KeywordEditor item={itemA} onClose={jest.fn()} />);

    // Make two separate saves so the undo stack has two entries.
    await typeAndSave('Item A first edit');
    await typeAndSave('Item A second edit');

    // Undo once: undo stack loses one entry but still has one left;
    // redo stack gains one entry.  Both stacks are now non-empty.
    await act(async () => {
      fireEvent.click(getUndoBtn());
    });
    await act(async () => {});

    // Confirm BOTH stacks are non-empty before switching items.
    expect(getUndoBtn().disabled).toBe(false);
    expect(getRedoBtn().disabled).toBe(false);

    // Switch to item B — the useEffect on [item?.id] should clear both stacks.
    act(() => {
      rerender(<KeywordEditor item={itemB} onClose={jest.fn()} />);
    });

    expect(getUndoBtn().disabled).toBe(true);
    expect(getRedoBtn().disabled).toBe(true);
  });
});

describe('KeywordEditor — Undo/Redo save failure', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('Undo failure: shows "Save failed" badge and leaves button states consistent', async () => {
    const item = makeItem({ description: 'Original description' });
    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    // First save succeeds — undo stack gains an entry.
    await typeAndSave('Edited description');
    expect(getUndoBtn().disabled).toBe(false);
    expect(getRedoBtn().disabled).toBe(true);

    // Subsequent saves (i.e. the undo persist call) will now reject.
    mockMutateAsync.mockRejectedValue(new Error('Network error'));

    // Click Undo — persist() rejects.
    await act(async () => {
      fireEvent.click(getUndoBtn());
    });
    // Flush the rejected promise chain so setSaveStatus('error') has been called.
    await act(async () => {});

    // The failure must NOT be silent — "Save failed" status badge appears.
    expect(screen.getByText('Save failed')).toBeTruthy();

    // The catch block rolls back the undo: description is restored to the
    // pre-undo value so UI and server remain in sync.
    expect(getDescInput().value).toBe('Edited description');

    // Undo stack entry pushed back → user can retry the undo.
    // Redo stack push reversed → no dangling redo entry.
    expect(getUndoBtn().disabled).toBe(false);
    expect(getRedoBtn().disabled).toBe(true);
  });

  it('Redo failure: shows "Save failed" badge and leaves button states consistent', async () => {
    const item = makeItem({ description: 'Original description' });
    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    // Edit + successful undo so the redo stack is populated.
    await typeAndSave('Edited description');
    await act(async () => {
      fireEvent.click(getUndoBtn());
    });
    await act(async () => {});

    // Sanity: redo is enabled, description is back to original.
    expect(getRedoBtn().disabled).toBe(false);
    expect(getDescInput().value).toBe('Original description');

    // Subsequent saves (i.e. the redo persist call) will now reject.
    mockMutateAsync.mockRejectedValue(new Error('Network error'));

    // Click Redo — persist() rejects.
    await act(async () => {
      fireEvent.click(getRedoBtn());
    });
    await act(async () => {});

    // The failure must NOT be silent.
    expect(screen.getByText('Save failed')).toBeTruthy();

    // The catch block rolls back the redo: description is restored to the
    // pre-redo value so UI and server remain in sync.
    expect(getDescInput().value).toBe('Original description');

    // Redo stack entry pushed back → user can retry the redo.
    // Undo stack was never pushed (persist never completed) → disabled.
    expect(getRedoBtn().disabled).toBe(false);
    expect(getUndoBtn().disabled).toBe(true);
  });
});

// ── Keyword Undo ─────────────────────────────────────────────────────────────

function getKwUndoBtn() {
  return screen.getByLabelText('Undo last keyword change') as HTMLButtonElement;
}

describe('KeywordEditor — Keyword Undo', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('Undo keyword button is disabled when no keyword edits have been made', () => {
    render(<KeywordEditor item={makeItem()} onClose={jest.fn()} />);
    expect(getKwUndoBtn().disabled).toBe(true);
  });

  it('removing a keyword enables Undo, which restores the keyword', async () => {
    const item = makeItem({ aiKeywords: ['breaker'] });
    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    expect(getKwUndoBtn().disabled).toBe(true);

    // Click the chip text to remove 'breaker' — the click bubbles to the button.
    fireEvent.click(screen.getByText('breaker'));

    // Advance past the debounce so persist fires and the undo stack is populated.
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    await act(async () => {});

    // Undo should now be enabled; chip should be gone.
    expect(getKwUndoBtn().disabled).toBe(false);
    expect(screen.queryByText('breaker')).toBeNull();

    // Click Undo → restores ['breaker'].
    await act(async () => {
      fireEvent.click(getKwUndoBtn());
    });
    await act(async () => {});

    expect(screen.queryByText('breaker')).toBeTruthy();
    // Stack exhausted → button disabled again.
    expect(getKwUndoBtn().disabled).toBe(true);
  });

  it('adding a keyword enables Undo, which removes the added keyword', async () => {
    const item = makeItem({ aiKeywords: [] });
    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    // Type 'fuse' into the new-keyword input, then click the "+ Add" button.
    act(() => {
      fireEvent.change(screen.getByPlaceholderText('Type keyword and press Add…'), {
        target: { value: 'fuse' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Add keyword'));
    });

    // Advance past the debounce.
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    await act(async () => {});

    expect(getKwUndoBtn().disabled).toBe(false);
    expect(screen.queryByText('fuse')).toBeTruthy();

    // Click Undo → removes 'fuse', reverts to empty list.
    await act(async () => {
      fireEvent.click(getKwUndoBtn());
    });
    await act(async () => {});

    expect(screen.queryByText('fuse')).toBeNull();
    expect(getKwUndoBtn().disabled).toBe(true);
  });

  it('keyword undo stack resets when editor opens on a different item', async () => {
    const itemA = makeItem({ id: 1, aiKeywords: ['breaker'] });
    const itemB = makeItem({ id: 2, aiKeywords: ['fuse'] });
    const { rerender } = render(<KeywordEditor item={itemA} onClose={jest.fn()} />);

    // Remove a keyword to populate the undo stack.
    fireEvent.click(screen.getByText('breaker'));
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    await act(async () => {});
    expect(getKwUndoBtn().disabled).toBe(false);

    // Switch to item B — the useEffect on [item?.id] should clear the stack.
    act(() => {
      rerender(<KeywordEditor item={itemB} onClose={jest.fn()} />);
    });

    expect(getKwUndoBtn().disabled).toBe(true);
  });
});

// ── Trade-Size Undo ──────────────────────────────────────────────────────────

function getTsUndoBtn() {
  return screen.getByLabelText('Undo last trade size change') as HTMLButtonElement;
}

function getTsInput() {
  return screen.getByPlaceholderText('e.g. 1/2", 3/4", 1"…') as HTMLInputElement;
}

describe('KeywordEditor — Trade-Size Undo', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMutateAsync.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('Undo trade-size button is disabled when no trade-size edits have been made', () => {
    render(<KeywordEditor item={makeItem()} onClose={jest.fn()} />);
    expect(getTsUndoBtn().disabled).toBe(true);
  });

  it('changing trade size enables Undo, which restores the previous value', async () => {
    const item = makeItem({ tradeSize: null });
    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    expect(getTsUndoBtn().disabled).toBe(true);

    // Type a trade size and let the debounce fire.
    act(() => {
      fireEvent.change(getTsInput(), { target: { value: '1/2"' } });
    });
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    await act(async () => {});

    expect(getTsInput().value).toBe('1/2"');
    expect(getTsUndoBtn().disabled).toBe(false);

    // Click Undo → restores '' (empty / null trade size).
    await act(async () => {
      fireEvent.click(getTsUndoBtn());
    });
    await act(async () => {});

    expect(getTsInput().value).toBe('');
    expect(getTsUndoBtn().disabled).toBe(true);
  });

  it('multiple trade-size changes produce multiple undo steps', async () => {
    const item = makeItem({ tradeSize: null });
    render(<KeywordEditor item={item} onClose={jest.fn()} />);

    // First change.
    act(() => {
      fireEvent.change(getTsInput(), { target: { value: '1/2"' } });
    });
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    await act(async () => {});

    // Second change.
    act(() => {
      fireEvent.change(getTsInput(), { target: { value: '3/4"' } });
    });
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    await act(async () => {});

    expect(getTsInput().value).toBe('3/4"');

    // First Undo → back to '1/2"'.
    await act(async () => {
      fireEvent.click(getTsUndoBtn());
    });
    await act(async () => {});
    expect(getTsInput().value).toBe('1/2"');
    expect(getTsUndoBtn().disabled).toBe(false);

    // Second Undo → back to '' (original null).
    await act(async () => {
      fireEvent.click(getTsUndoBtn());
    });
    await act(async () => {});
    expect(getTsInput().value).toBe('');
    expect(getTsUndoBtn().disabled).toBe(true);
  });

  it('trade-size undo stack resets when editor opens on a different item', async () => {
    const itemA = makeItem({ id: 1, tradeSize: null });
    const itemB = makeItem({ id: 2, tradeSize: '3/4"' });
    const { rerender } = render(<KeywordEditor item={itemA} onClose={jest.fn()} />);

    // Change trade size to populate the undo stack.
    act(() => {
      fireEvent.change(getTsInput(), { target: { value: '1/2"' } });
    });
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    await act(async () => {});
    expect(getTsUndoBtn().disabled).toBe(false);

    // Switch to item B — stack must clear.
    act(() => {
      rerender(<KeywordEditor item={itemB} onClose={jest.fn()} />);
    });

    expect(getTsUndoBtn().disabled).toBe(true);
  });
});
