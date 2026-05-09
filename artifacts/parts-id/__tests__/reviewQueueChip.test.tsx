/**
 * @jest-environment jsdom
 *
 * Verifies that the Review Queue stat chip stays in sync with admin actions
 * in ClassificationReviewSection.  Three assertions from the task spec:
 *
 *   1. The chip renders with its count even while the enrichment-summary fetch
 *      is still pending (the two requests are independent).
 *   2. The Enriched / Pending / Coverage chips are absent until enrichSummary
 *      resolves — production gating logic exercised via the real
 *      EnrichmentStatsChips component.
 *   3. After a confirm action in ClassificationReviewSection the chip's count
 *      reflects the refreshed total (e.g. 4 → 3).
 *
 * Approach — a small `ReviewQueueSyncFixture` component that:
 *   - Manages `reviewCount` and `enrichSummary` state via mocked global.fetch,
 *     mirroring upload.tsx's useEffect / fetchReviewCount / fetchEnrichSummary.
 *   - Renders the real production EnrichmentStatsChips component so chip gating
 *     logic regressions in that file are caught.
 *   - Renders the real production ClassificationReviewSection and wires
 *     onReviewAction → fetchReviewCount, exactly as upload.tsx does.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';

// ── Mutable mock fns (mock* prefix bypasses jest hoisting) ────────────────────
const mockListClassificationReview = jest.fn();
const mockConfirmClassificationReview = jest.fn();

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

  const View = makeHost('div');
  const Text = makeHost('span');

  const ScrollView = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: () => {}, scrollToOffset: () => {} }), []);
    return React.createElement(makeHost('div'), props as Record<string, unknown>);
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
    transparent?: boolean;
    onRequestClose?: () => void;
  }) => (visible ? React.createElement('div', { role: 'dialog' }, children) : null);
  Modal.displayName = 'Modal';

  const StyleSheet = {
    create: <T extends object>(obj: T): T => obj,
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  const ActivityIndicator = makeHost('div');

  return {
    View,
    Text,
    ScrollView,
    TextInput: makeHost('input'),
    Pressable,
    Modal,
    StyleSheet,
    ActivityIndicator,
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o['web'] ?? o['default'] },
  };
});

// ── api-client-react mock ─────────────────────────────────────────────────────
jest.mock('@workspace/api-client-react', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    listClassificationReview: (...args: unknown[]) => mockListClassificationReview(...args),
    confirmClassificationReview: (...args: unknown[]) => mockConfirmClassificationReview(...args),
    reclassifyReviewItem: jest.fn(async () => undefined),
    skipClassificationReview: jest.fn(async () => undefined),
    ApiError,
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

// ── Imports after mocks ───────────────────────────────────────────────────────
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EnrichmentStatsChips, type EnrichSummary } from '../components/EnrichmentStatsChips';
import ClassificationReviewSection from '../components/ClassificationReviewSection';

// ── Fixture ───────────────────────────────────────────────────────────────────
/**
 * Mirrors the upload screen wiring:
 *   - reviewCount + fetchReviewCount   ← /admin/classification-review (fast)
 *   - enrichSummary + fetchEnrichSummary ← /inventory/enrich-summary (may lag)
 *   - <EnrichmentStatsChips> — real production component, chip gating tested here
 *   - <ClassificationReviewSection onReviewAction={fetchReviewCount}>
 *     wired exactly as upload.tsx line 3661
 */
function ReviewQueueSyncFixture() {
  const [enrichSummary, setEnrichSummary] = React.useState<EnrichSummary | null>(null);
  const [reviewCount, setReviewCount] = React.useState<number | null>(null);

  const fetchReviewCount = React.useCallback(async () => {
    try {
      const res = await fetch('/admin/classification-review?page=1&limit=1', {
        headers: { Authorization: 'Bearer test-token' },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { total: number };
      setReviewCount(data.total);
    } catch {}
  }, []);

  const fetchEnrichSummary = React.useCallback(async () => {
    try {
      const res = await fetch('/inventory/enrich-summary', {
        headers: { Authorization: 'Bearer test-token' },
      });
      if (!res.ok) return;
      const data = (await res.json()) as EnrichSummary;
      setEnrichSummary(data);
    } catch {}
  }, []);

  React.useEffect(() => {
    void fetchReviewCount();
    void fetchEnrichSummary();
  }, [fetchReviewCount, fetchEnrichSummary]);

  return (
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    React.createElement(
      require('react-native').View,
      null,
      React.createElement(EnrichmentStatsChips, {
        reviewCount,
        enrichSummary,
        onReviewQueuePress: () => {},
      }),
      React.createElement(ClassificationReviewSection, {
        apiBase: '',
        adminHeaders: { Authorization: 'Bearer test-token' },
        onExpiredSession: () => {},
        onReviewAction: fetchReviewCount,
      })
    )
  );
}

// ── Flush helper ──────────────────────────────────────────────────────────────
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
const REVIEW_ITEM = {
  inventoryId: 1,
  catalog: 'BR120',
  vendor: 'ETN',
  description: '20A Breaker',
  categoryPath: 'Wiring Devices › Breakers › Single Pole',
  confidencePct: 55,
};

describe('Review Queue chip — stays in sync with admin actions', () => {
  let origFetch: typeof global.fetch;

  beforeEach(() => {
    origFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = origFetch;
    jest.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('chip renders independently of enrichSummary', () => {
    beforeEach(() => {
      // reviewCount resolves immediately; enrichSummary never resolves
      global.fetch = jest.fn((url: unknown) => {
        if (typeof url === 'string' && url.includes('/admin/classification-review')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ total: 4 }),
          } as Response);
        }
        return new Promise<Response>(() => {}); // enrich-summary hangs
      }) as typeof global.fetch;

      mockListClassificationReview.mockResolvedValue({ total: 4, items: [] });
    });

    it('shows the Review Queue chip count while enrichSummary is still pending', async () => {
      render(<ReviewQueueSyncFixture />);
      await flush();

      const chip = screen.getByLabelText('Open review queue');
      expect(chip).toBeTruthy();
      expect(chip.textContent).toContain('4');
      expect(chip.textContent).toContain('Review Queue');
    });

    it('Enriched / Pending / Coverage chips are absent while enrichSummary is loading', async () => {
      render(<ReviewQueueSyncFixture />);
      await flush();

      expect(screen.queryByText('Enriched')).toBeNull();
      expect(screen.queryByText('Pending')).toBeNull();
      expect(screen.queryByText('Coverage')).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('chip count refreshes after ClassificationReviewSection confirm action', () => {
    it('decrements from 4 to 3 after the admin confirms an item', async () => {
      let reviewFetchCount = 0;
      global.fetch = jest.fn((url: unknown) => {
        if (typeof url === 'string' && url.includes('/admin/classification-review')) {
          reviewFetchCount++;
          const total = reviewFetchCount === 1 ? 4 : 3;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ total }),
          } as Response);
        }
        return new Promise<Response>(() => {}); // enrich-summary never resolves
      }) as typeof global.fetch;

      // count badge on section mount; items for expand
      mockListClassificationReview
        .mockResolvedValueOnce({ total: 4, items: [] })
        .mockResolvedValueOnce({ total: 4, items: [REVIEW_ITEM] });

      mockConfirmClassificationReview.mockResolvedValue(undefined);

      render(<ReviewQueueSyncFixture />);
      await flush();

      // Chip starts at 4
      expect(screen.getByLabelText('Open review queue').textContent).toContain('4');

      // Expand the review section
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: /expand classification review/i }));
      });
      await flush();

      // Confirm the first item
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: /confirm classification/i }));
      });
      await flush();

      // onReviewAction fired fetchReviewCount → second fetch returned 3
      expect(mockConfirmClassificationReview).toHaveBeenCalledWith(
        REVIEW_ITEM.inventoryId,
        expect.objectContaining({ headers: expect.any(Object) })
      );
      expect(screen.getByLabelText('Open review queue').textContent).toContain('3');
    });
  });
});
