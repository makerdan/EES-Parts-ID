/**
 * @jest-environment jsdom
 *
 * Verifies that the Scan screen's RecordEditModal `onSaved` handler calls
 * `updateFuseCache` with the updated item.
 *
 * The RecordEditModal mock captures its `onSaved` prop so the test can fire
 * it directly without simulating the full scan / lock-on / lookup flow.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';

// ── Capture RecordEditModal's onSaved prop ─────────────────────────────────────
// 'mock' prefix keeps this in scope inside jest.mock() factories.
const mockRecordEditModal = {
  onSaved: undefined as ((updated: unknown) => void) | undefined,
};

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
      React.useImperativeHandle(
        ref,
        () => ({ scrollTo: () => {}, scrollToOffset: () => {} }),
        []
      );
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
    KeyboardAvoidingView: makeHost('div'),
    SafeAreaView: makeHost('div'),
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o['ios'] ?? o['default'] },
    Linking: { openURL: jest.fn() },
    Keyboard: { dismiss: jest.fn() },
  };
});

// ── expo-camera ────────────────────────────────────────────────────────────────
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
    adminToken: 'admin-tok',
    isAdmin: true,
    textFontScale: 1,
  }),
}));

jest.mock('@workspace/api-client-react', () => ({
  useBarcodeLookup: () => ({
    mutateAsync: jest.fn(async () => ({ match: null, recentlyViewed: [] })),
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

// updateFuseCache — mocked so we can assert it is called.
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

jest.mock('@/components/ResultCard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function ResultCardStub() {
    return R.createElement('div', { 'data-testid': 'result-card' });
  }
  return { ResultCard: ResultCardStub };
});

// RecordEditModal spy — captures onSaved so tests can fire it directly.
jest.mock('@/components/RecordEditModal', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function RecordEditModalSpy(props: Record<string, unknown>) {
    mockRecordEditModal.onSaved = props['onSaved'] as ((updated: unknown) => void) | undefined;
    return R.createElement('div', { 'data-testid': 'record-edit-modal' });
  }
  return { RecordEditModal: RecordEditModalSpy };
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

import { act, render } from '@testing-library/react';
import { updateFuseCache } from '@/lib/updateFuseCache';
import ScanScreen from '../app/scan';

// ── Fixture ────────────────────────────────────────────────────────────────────

const UPDATED_ITEM = {
  id: 42,
  vendor: 'ETN',
  catalog: 'BR120',
  description: 'Updated 20A Breaker',
  binLocations: ['D-7'],
  aiKeywords: ['breaker', 'updated'],
  keywords: [],
  vendorFullName: null,
  enrichedAt: '2024-06-01T00:00:00Z',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-06-01T00:00:00Z',
  seriesName: null,
  tradeSize: null,
  seriesId: null,
  categoryId: null,
  subcategoryId: null,
  typeId: null,
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Scan screen (scan.tsx) — onSaved updates the offline cache', () => {
  afterEach(() => {
    jest.clearAllMocks();
    mockRecordEditModal.onSaved = undefined;
  });

  it('calls updateFuseCache with the updated item when onSaved fires', async () => {
    render(<ScanScreen />);

    // Flush initial renders and effects so RecordEditModal mounts and its
    // onSaved prop is captured by the spy above.
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockRecordEditModal.onSaved).toBeDefined();

    // Simulate the modal calling back with a saved item.
    await act(async () => {
      mockRecordEditModal.onSaved!(UPDATED_ITEM);
    });

    expect(jest.mocked(updateFuseCache)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(updateFuseCache)).toHaveBeenCalledWith(UPDATED_ITEM);
  });
});
