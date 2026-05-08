/**
 * @jest-environment jsdom
 *
 * Component test for ResultRefinementBar's "Add keywords" input. The pure
 * filter helpers (`applyRefinement`, `tokenMatch`, etc.) are covered in
 * resultRefinement.test.ts — here we verify the React-side wiring:
 *
 *   • typing fires a single debounced onChange with the trimmed value
 *   • the × clear button removes extraKeywords from upstream state
 *   • when the parent resets refinement to {}, the input clears visually
 *   • chip rows still render alongside the input when there's variation
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SearchResult } from '@workspace/api-client-react';

// Imported AFTER the mocks above so the component picks them up.
import { ResultRefinementBar } from '@/components/ResultRefinementBar';
import type { RefinementState } from '@/lib/refinement';

// useColors returns a flat color map; minimal stub keyed only on what the
// component actually pulls (border / background / foreground / muted /
// primary / mutedForeground / primaryForeground).
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
    destructive: '#dc2626',
  }),
}));

// FilterPanel exports CHIP_DIMS — use a tiny fixture so we can assert chip
// rows render when there's variation across the result set.
jest.mock('@/components/FilterPanel', () => ({
  CHIP_DIMS: [
    { key: 'manufacturer', label: 'Manufacturer', options: ['Eaton', 'Square D'] },
    { key: 'amperage', label: 'Amperage', options: ['20A', '30A'] },
  ],
}));

function makeResult(over: { id: number; text: string }): SearchResult {
  return {
    item: {
      id: over.id,
      vendor: 'ETN',
      catalog: `BR1${over.id}`,
      description: over.text,
      binLocations: [],
      aiKeywords: [],
      vendorFullName: null,
      enrichedAt: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
    confidence: 0.9,
    matchReason: 'test',
    seriesLabel: undefined,
    variants: [],
  };
}

// Two results with cross-dim variation so dimsWithCounts surfaces both
// the manufacturer and amperage rows alongside the keyword input.
const RESULTS: SearchResult[] = [
  makeResult({ id: 1, text: 'Eaton 20A breaker blue' }),
  makeResult({ id: 2, text: 'Square D 30A breaker green' }),
];

// Render helper that drives a controlled refinement state externally —
// matches the real index.tsx wiring (useState<RefinementState>({})).
function renderBar(initial: RefinementState = {}) {
  const onChange = jest.fn();
  let current: RefinementState = initial;
  const { rerender } = render(
    <ResultRefinementBar
      results={RESULTS}
      refinement={current}
      onChange={(next) => {
        current = next;
        onChange(next);
      }}
    />
  );
  const setRefinement = (next: RefinementState) => {
    current = next;
    rerender(
      <ResultRefinementBar
        results={RESULTS}
        refinement={current}
        onChange={(n) => {
          current = n;
          onChange(n);
        }}
      />
    );
  };
  return {
    onChange,
    setRefinement,
    getInput: () =>
      screen.getByLabelText('Add keywords to refine the current results') as HTMLInputElement,
    queryClearBtn: () => screen.queryByLabelText('Clear added keywords'),
  };
}

describe('ResultRefinementBar — Add keywords input', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('debounces typed input into a single onChange with the trimmed value', () => {
    const { onChange, getInput } = renderBar();

    // Type three keystrokes quickly; debounce should collapse them.
    act(() => {
      fireEvent.change(getInput(), { target: { value: 'b' } });
    });
    act(() => {
      fireEvent.change(getInput(), { target: { value: 'bl' } });
    });
    act(() => {
      fireEvent.change(getInput(), { target: { value: ' blue ' } });
    });

    // Nothing pushed upstream until the 150ms debounce elapses.
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(150);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ extraKeywords: 'blue' });
  });

  it('clears extraKeywords from upstream state when the × button is pressed', () => {
    const { onChange, getInput, queryClearBtn } = renderBar({ extraKeywords: 'blue' });

    // Pre-fill matches initial refinement, no extra debounce should fire.
    expect(getInput().value).toBe('blue');
    const clearBtn = queryClearBtn();
    expect(clearBtn).not.toBeNull();

    act(() => {
      fireEvent.click(clearBtn!);
    });
    act(() => {
      jest.advanceTimersByTime(150);
    });

    // After debounce, upstream should receive a state without extraKeywords.
    expect(onChange).toHaveBeenCalledTimes(1);
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(last).not.toHaveProperty('extraKeywords');
    // Local input also cleared.
    expect(getInput().value).toBe('');
  });

  it('syncs the input visually when the parent resets refinement to {}', () => {
    const { onChange, getInput, setRefinement } = renderBar({ extraKeywords: 'blue' });
    expect(getInput().value).toBe('blue');

    // Parent issues a brand-new search → setRefinement({}).
    act(() => {
      setRefinement({});
    });

    expect(getInput().value).toBe('');
    // No spurious upstream emit on the reset itself (parent already reset).
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders chip rows alongside the input when there's variation", () => {
    renderBar();

    // Keyword input is always present.
    expect(screen.getByLabelText('Add keywords to refine the current results')).toBeTruthy();

    // Both chip dims should surface a chip per option (count > 0 in fixture).
    expect(screen.getByLabelText(/Refine by Manufacturer Eaton, 1 match/)).toBeTruthy();
    expect(screen.getByLabelText(/Refine by Manufacturer Square D, 1 match/)).toBeTruthy();
    expect(screen.getByLabelText(/Refine by Amperage 20A, 1 match/)).toBeTruthy();
    expect(screen.getByLabelText(/Refine by Amperage 30A, 1 match/)).toBeTruthy();
  });
});
