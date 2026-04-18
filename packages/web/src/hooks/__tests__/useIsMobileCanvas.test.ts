/**
 * Tests for useIsMobileCanvas hook.
 *
 * Verifies:
 * - Returns true when the (max-width: 767px) media query matches.
 * - Returns false when it does not match.
 * - Reacts to media-query change events.
 * - Safe when matchMedia is unavailable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useIsMobileCanvas, MOBILE_CANVAS_MEDIA_QUERY } from '../useIsMobileCanvas';

type ChangeHandler = (event: MediaQueryListEvent) => void;

interface MockMediaQueryList {
	matches: boolean;
	media: string;
	onchange: null;
	addListener: ReturnType<typeof vi.fn>;
	removeListener: ReturnType<typeof vi.fn>;
	addEventListener: (type: 'change', handler: ChangeHandler) => void;
	removeEventListener: (type: 'change', handler: ChangeHandler) => void;
	dispatchEvent: (event: MediaQueryListEvent) => boolean;
	_trigger: (matches: boolean) => void;
}

function createMockMediaQueryList(initialMatches: boolean): MockMediaQueryList {
	const handlers = new Set<ChangeHandler>();
	const mql: MockMediaQueryList = {
		matches: initialMatches,
		media: MOBILE_CANVAS_MEDIA_QUERY,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: (_type, handler) => {
			handlers.add(handler);
		},
		removeEventListener: (_type, handler) => {
			handlers.delete(handler);
		},
		dispatchEvent: () => true,
		_trigger: (matches: boolean) => {
			mql.matches = matches;
			for (const handler of handlers) {
				handler({ matches, media: MOBILE_CANVAS_MEDIA_QUERY } as MediaQueryListEvent);
			}
		},
	};
	return mql;
}

describe('useIsMobileCanvas', () => {
	let originalMatchMedia: typeof window.matchMedia | undefined;

	beforeEach(() => {
		originalMatchMedia = window.matchMedia;
	});

	afterEach(() => {
		if (originalMatchMedia) {
			window.matchMedia = originalMatchMedia;
		} else {
			// @ts-expect-error allow deletion in test teardown
			delete window.matchMedia;
		}
	});

	it('returns true when matchMedia reports the mobile query matches', () => {
		const mql = createMockMediaQueryList(true);
		window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

		const { result } = renderHook(() => useIsMobileCanvas());
		expect(result.current).toBe(true);
	});

	it('returns false when the media query does not match', () => {
		const mql = createMockMediaQueryList(false);
		window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

		const { result } = renderHook(() => useIsMobileCanvas());
		expect(result.current).toBe(false);
	});

	it('queries the canonical mobile media string', () => {
		const mql = createMockMediaQueryList(false);
		const spy = vi.fn().mockReturnValue(mql);
		window.matchMedia = spy as unknown as typeof window.matchMedia;

		renderHook(() => useIsMobileCanvas());
		expect(spy).toHaveBeenCalledWith(MOBILE_CANVAS_MEDIA_QUERY);
	});

	it('updates when the media query changes', () => {
		const mql = createMockMediaQueryList(false);
		window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

		const { result } = renderHook(() => useIsMobileCanvas());
		expect(result.current).toBe(false);

		act(() => {
			mql._trigger(true);
		});
		expect(result.current).toBe(true);

		act(() => {
			mql._trigger(false);
		});
		expect(result.current).toBe(false);
	});

	it('does not throw when matchMedia is unavailable', () => {
		// @ts-expect-error simulate missing API
		delete window.matchMedia;

		const { result } = renderHook(() => useIsMobileCanvas());
		expect(result.current).toBe(false);
	});
});
