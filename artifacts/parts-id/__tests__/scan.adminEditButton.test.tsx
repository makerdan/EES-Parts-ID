/**
 * @jest-environment jsdom
 *
 * Renders the actual Scan screen (app/scan.tsx) and verifies that ResultCard
 * receives `onEditKeywords` as a function only when BOTH `isAdmin` AND
 * `adminToken` are set in AppContext (the stricter two-condition guard the
 * scan screen uses: `isAdmin && adminToken ? setEditItem : undefined`).
 *
 * Flow simulated:
 *   1. CameraView mock renders a clickable trigger button.
 *   2. Test clicks the trigger → `onBarcodeScanned` fires → `handleBarcodeScanned`
 *      sets `pendingBarcodeRef` and starts the 1500ms lock-on timer.
 *   3. `jest.advanceTimersByTime(1600)` advances past the timer synchronously →
 *      `performLookup` is called.
 *   4. Mocked `lookupMutation.mutateAsync` resolves with `{ match: item }` →
 *      `setMatchedItem(item)` → Modal becomes visible → ResultCard spy renders.
 *   5. Assert `data-has-edit` attribute reflects the admin state.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';

// ── Mutable per-test flags ─────────────────────────────────────────────────────
let mockAdminToken: string | null = 'admin-tok';
let mockIsAdmin = true;

// ── Mock fn — 'mock'-prefix bypasses jest hoisting ────────────────────────────
const mockLookupMutateAsync = jest.fn();

// ── react-native mock ──────────────────────────────────────────────────────────
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
        accessibilityState,
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
      if (accessibilityState && (accessibilityState as { selected?: boolean }).selected != null) {
        a11y['aria-selected'] = (accessibilityState as { selected?: boolean }).selected;
      }
      return React.createElement(
        tag,
        { ref, style: flatStyle(style), ...a11y, ...rest },
        children as React.ReactNode
      );
    });
  }

  const View = makeHost('div');
  const Text = makeHost('span');

  const ScrollView = React.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      const innerRef = React.useRef<unknown>(null);
      React.useImperativeHandle(ref, () => ({ scrollTo: () => {}, scrollToOffset: () => {} }), []);
      const Host = makeHost('div');
      return React.createElement(Host, { ...props, ref: innerRef });
    }
  );

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
          ...(accessibilityState &&
          typeof accessibilityState === 'object' &&
          'selected' in (accessibilityState as object)
            ? { 'aria-selected': (accessibilityState as { selected: boolean }).selected }
            : {}),
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
    Image: makeHost('img'),
    SafeAreaView: makeHost('div'),
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o['ios'] ?? o['default'] },
    Linking: { openURL: jest.fn() },
    Keyboard: { dismiss: jest.fn() },
  };
});

// ── expo-camera: CameraView with a clickable trigger button ───────────────────
// Using a click trigger (rather than a useEffect) lets us fire onBarcodeScanned
// at a deterministic moment inside a synchronous act() call, avoiding conflicts
// between jest fake timers and React 19's async scheduler.
jest.mock('expo-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');
  function CameraViewMock({
    onBarcodeScanned,
  }: {
    onBarcodeScanned?: (e: { type: string; data: string }) => void;
    [key: string]: unknown;
  }) {
    return React.createElement(
      'div',
      { 'data-testid': 'camera-view' },
      React.createElement('button', {
        'data-testid': 'trigger-scan',
        onClick: () => onBarcodeScanned?.({ type: 'qr', data: 'TEST-BAR-123' }),
      })
    );
  }
  return {
    CameraView: CameraViewMock,
    useCameraPermissions: () => [{ granted: true, status: 'granted' }, jest.fn()],
  };
});

// ── Other dependency mocks ─────────────────────────────────────────────────────

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    multiGet: jest.fn(async () => []),
    multiRemove: jest.fn(async () => undefined),
  },
}));

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
    overlay: '#00000088',
  }),
}));

jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({
    adminToken: mockAdminToken,
    isAdmin: mockIsAdmin,
    textFontScale: 1,
  }),
}));

jest.mock('@workspace/api-client-react', () => ({
  useBarcodeLookup: () => ({
    mutateAsync: (...args: unknown[]) => mockLookupMutateAsync(...args),
    isPending: false,
    isError: false,
    isSuccess: false,
    reset: jest.fn(),
  }),
  useSearchInventory: () => ({
    mutateAsync: jest.fn(async () => ({ results: [] })),
    isPending: false,
    isError: false,
    isSuccess: false,
    reset: jest.fn(),
  }),
  useAiIdentifyPart: () => ({
    mutateAsync: jest.fn(async () => ({
      results: [],
      summary: '',
      searchTerms: [],
      synonyms: [],
      _telemetry: null,
    })),
    isPending: false,
    isError: false,
    isSuccess: false,
    reset: jest.fn(),
  }),
  useBarcodeRecent: () => ({ data: [], isLoading: false }),
  barcodeLink: jest.fn(() => 'https://example.com/barcode/TEST'),
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  MediaTypeOptions: { Images: 'Images' },
}));

jest.mock('@/utils/resizeImage', () => ({
  resizeImage: jest.fn(async (uri: string, base64: string) => ({ uri, base64 })),
}));

jest.mock('@/lib/updateFuseCache', () => ({
  updateFuseCache: jest.fn(async () => undefined),
}));

jest.mock('@expo/vector-icons', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function IconStub({ name }: { name: string }) {
    return R.createElement('span', {}, name);
  }
  return { Feather: IconStub, MaterialCommunityIcons: IconStub };
});

// ResultCard spy — exposes onEditKeywords via data attribute.
jest.mock('@/components/ResultCard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function ResultCardSpy({ onEditKeywords }: { onEditKeywords?: unknown }) {
    return R.createElement('div', {
      'data-testid': 'result-card',
      'data-has-edit': onEditKeywords ? 'true' : 'false',
    });
  }
  return { ResultCard: ResultCardSpy };
});

jest.mock('@/components/RecordEditModal', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub() {
    return R.createElement('div', { 'data-testid': 'record-edit-modal' });
  }
  return { RecordEditModal: Stub };
});

jest.mock('@/components/Toast', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub() {
    return R.createElement('div', { 'data-testid': 'toast' });
  }
  return { Toast: Stub };
});

jest.mock('@/components/ErrorBanner', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub() {
    return R.createElement('div', { 'data-testid': 'error-banner' });
  }
  return { ErrorBanner: Stub };
});

// ── Imports after mocks ────────────────────────────────────────────────────────

import { act, fireEvent, render, screen } from '@testing-library/react';
import ScanScreen from '../app/scan';

// ── Matched item fixture ───────────────────────────────────────────────────────

const MATCHED_ITEM = {
  id: 7,
  vendor: 'ETN',
  catalog: 'BR120',
  description: '20A Breaker',
  binLocations: ['C-3'],
  aiKeywords: ['breaker'],
  keywords: [],
  vendorFullName: null,
  enrichedAt: '2024-01-01T00:00:00Z',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  seriesName: null,
  tradeSize: null,
  seriesId: null,
  categoryId: null,
  subcategoryId: null,
  typeId: null,
};

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Render ScanScreen, click the trigger-scan button to fire onBarcodeScanned,
 * advance past the 1500ms lock-on timer synchronously, then flush the async
 * performLookup chain so ResultCard is in the DOM before assertions.
 *
 * Fake timers are enabled AFTER the initial render so React's scheduler can
 * flush the component tree before we start controlling time.
 */
async function renderAndScan() {
  // Step 1: Render with real timers so React flushes the component tree fully
  render(<ScanScreen />);
  await act(async () => {
    await Promise.resolve();
  });

  // Step 2: Switch to fake timers now that the screen is mounted and stable
  jest.useFakeTimers();

  // Step 3: Click the trigger → handleBarcodeScanned fires → 1500ms timer starts
  act(() => {
    fireEvent.click(screen.getByTestId('trigger-scan'));
  });

  // Step 4: Advance past the lock-on timer → performLookup is called
  act(() => {
    jest.advanceTimersByTime(1600);
  });

  // Step 5: Back to real timers before flushing the async performLookup chain
  jest.useRealTimers();

  // Step 6: Flush mutateAsync → setMatchedItem → Modal → ResultCard updates
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Scan screen (scan.tsx) — Edit Part Details button correlates with isAdmin && adminToken', () => {
  beforeEach(() => {
    mockLookupMutateAsync.mockResolvedValue({
      match: MATCHED_ITEM,
      recentlyViewed: [],
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('ResultCard receives onEditKeywords when both isAdmin and adminToken are set (admin)', async () => {
    mockAdminToken = 'admin-secret';
    mockIsAdmin = true;
    await renderAndScan();
    const card = screen.getByTestId('result-card');
    expect(card.getAttribute('data-has-edit')).toBe('true');
  });

  it('ResultCard receives undefined onEditKeywords when adminToken is null (non-admin)', async () => {
    mockAdminToken = null;
    mockIsAdmin = false;
    await renderAndScan();
    const card = screen.getByTestId('result-card');
    expect(card.getAttribute('data-has-edit')).toBe('false');
  });

  it('ResultCard receives undefined onEditKeywords when isAdmin is false even with a token (edge case)', async () => {
    // Scan screen requires BOTH isAdmin AND adminToken — token alone is not enough.
    mockAdminToken = 'some-token';
    mockIsAdmin = false;
    await renderAndScan();
    const card = screen.getByTestId('result-card');
    expect(card.getAttribute('data-has-edit')).toBe('false');
  });
});
