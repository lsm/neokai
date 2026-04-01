/**
 * Tests for useViewportSafety Hook
 *
 * Tests iPad Safari detection logic, --safe-height CSS property management,
 * and event listener cleanup.
 */

import { renderHook } from '@testing-library/preact';
import { useViewportSafety } from '../useViewportSafety.ts';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Partial VisualViewport mock with trackable event listeners. */
interface MockVisualViewport {
	height: number;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
	/** Fire all registered listeners for an event (test helper). */
	_trigger(event: string): void;
}

function createMockVisualViewport(height: number): MockVisualViewport {
	const listeners: Record<string, Array<EventListenerOrEventListenerObject>> = {};
	return {
		height,
		addEventListener: vi.fn((event: string, cb: EventListenerOrEventListenerObject) => {
			listeners[event] = listeners[event] ?? [];
			listeners[event].push(cb);
		}),
		removeEventListener: vi.fn((event: string, cb: EventListenerOrEventListenerObject) => {
			if (listeners[event]) {
				listeners[event] = listeners[event].filter((l) => l !== cb);
			}
		}),
		_trigger(event: string) {
			(listeners[event] ?? []).forEach((cb) => {
				if (typeof cb === 'function') cb(new Event(event));
			});
		},
	};
}

function setNavigator(maxTouchPoints: number, userAgent: string): void {
	Object.defineProperty(navigator, 'maxTouchPoints', {
		configurable: true,
		get: () => maxTouchPoints,
	});
	Object.defineProperty(navigator, 'userAgent', {
		configurable: true,
		get: () => userAgent,
	});
}

function restoreNavigator(): void {
	// Restore to jsdom defaults
	Object.defineProperty(navigator, 'maxTouchPoints', {
		configurable: true,
		get: () => 0,
	});
	Object.defineProperty(navigator, 'userAgent', {
		configurable: true,
		// Keep the existing value from jsdom
		get: () => 'Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/20.0.3',
	});
}

function setVisualViewport(vv: MockVisualViewport | null): void {
	Object.defineProperty(window, 'visualViewport', {
		configurable: true,
		get: () => vv,
	});
}

function restoreVisualViewport(): void {
	Object.defineProperty(window, 'visualViewport', {
		configurable: true,
		get: () => null,
	});
}

// ---------------------------------------------------------------------------
// UA fixtures
// ---------------------------------------------------------------------------

/** iPadOS 16 — masquerades as macOS Safari */
const IPAD_SAFARI_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15';

/** Desktop macOS Safari (no touch) */
const DESKTOP_SAFARI_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15';

/** Desktop Chrome */
const DESKTOP_CHROME_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Chrome on iOS */
const CRIOS_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1';

/** Firefox on iOS */
const FXIOS_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
	restoreNavigator();
	restoreVisualViewport();
	document.documentElement.style.removeProperty('--safe-height');
});

// ---------------------------------------------------------------------------
// iPad Safari detection
// ---------------------------------------------------------------------------

describe('useViewportSafety — iPad Safari detection', () => {
	it('detects iPad Safari: maxTouchPoints > 1 + Safari UA without Chrome/CriOS/FxiOS', () => {
		setNavigator(5, IPAD_SAFARI_UA);
		setVisualViewport(createMockVisualViewport(900));

		renderHook(() => useViewportSafety());

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('900px');
	});

	it('does NOT detect iPad Safari when maxTouchPoints is 0 (desktop Mac)', () => {
		setNavigator(0, DESKTOP_SAFARI_UA);
		setVisualViewport(createMockVisualViewport(900));

		renderHook(() => useViewportSafety());

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
	});

	it('does NOT detect iPad Safari for desktop Chrome (UA contains Chrome)', () => {
		setNavigator(5, DESKTOP_CHROME_UA);
		setVisualViewport(createMockVisualViewport(900));

		renderHook(() => useViewportSafety());

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
	});

	it('does NOT detect iPad Safari for CriOS (Chrome on iOS)', () => {
		setNavigator(5, CRIOS_UA);
		setVisualViewport(createMockVisualViewport(900));

		renderHook(() => useViewportSafety());

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
	});

	it('does NOT detect iPad Safari for FxiOS (Firefox on iOS)', () => {
		setNavigator(5, FXIOS_UA);
		setVisualViewport(createMockVisualViewport(900));

		renderHook(() => useViewportSafety());

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
	});
});

// ---------------------------------------------------------------------------
// --safe-height property
// ---------------------------------------------------------------------------

describe('useViewportSafety — --safe-height property', () => {
	it('sets --safe-height to visualViewport.height on iPad Safari', () => {
		setNavigator(5, IPAD_SAFARI_UA);
		setVisualViewport(createMockVisualViewport(768));

		renderHook(() => useViewportSafety());

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('768px');
	});

	it('does NOT set --safe-height on non-iPad-Safari (CSS 100svh fallback applies)', () => {
		setNavigator(0, DESKTOP_SAFARI_UA);
		setVisualViewport(createMockVisualViewport(900));

		renderHook(() => useViewportSafety());

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
	});

	it('does nothing when visualViewport is unavailable on iPad Safari', () => {
		setNavigator(5, IPAD_SAFARI_UA);
		setVisualViewport(null);

		expect(() => renderHook(() => useViewportSafety())).not.toThrow();
		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

describe('useViewportSafety — event listeners', () => {
	it('attaches resize listeners on iPad Safari', () => {
		setNavigator(5, IPAD_SAFARI_UA);
		const mockVV = createMockVisualViewport(900);
		setVisualViewport(mockVV);
		const windowAddSpy = vi.spyOn(window, 'addEventListener');

		renderHook(() => useViewportSafety());

		expect(mockVV.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(windowAddSpy).toHaveBeenCalledWith('resize', expect.any(Function));

		windowAddSpy.mockRestore();
	});

	it('does NOT attach listeners on non-iPad-Safari', () => {
		setNavigator(0, DESKTOP_SAFARI_UA);
		const mockVV = createMockVisualViewport(900);
		setVisualViewport(mockVV);

		renderHook(() => useViewportSafety());

		expect(mockVV.addEventListener).not.toHaveBeenCalled();
	});

	it('removes event listeners on unmount', () => {
		setNavigator(5, IPAD_SAFARI_UA);
		const mockVV = createMockVisualViewport(900);
		setVisualViewport(mockVV);
		const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

		const { unmount } = renderHook(() => useViewportSafety());
		unmount();

		expect(mockVV.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
		expect(windowRemoveSpy).toHaveBeenCalledWith('resize', expect.any(Function));

		windowRemoveSpy.mockRestore();
	});

	it('updates --safe-height when visualViewport resize fires', () => {
		setNavigator(5, IPAD_SAFARI_UA);
		const mockVV = createMockVisualViewport(900);
		setVisualViewport(mockVV);

		renderHook(() => useViewportSafety());

		mockVV.height = 700;
		mockVV._trigger('resize');

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('700px');
	});

	it('updates --safe-height when window resize fires', () => {
		setNavigator(5, IPAD_SAFARI_UA);
		const mockVV = createMockVisualViewport(900);
		setVisualViewport(mockVV);

		renderHook(() => useViewportSafety());

		mockVV.height = 600;
		window.dispatchEvent(new Event('resize'));

		expect(document.documentElement.style.getPropertyValue('--safe-height')).toBe('600px');
	});
});
