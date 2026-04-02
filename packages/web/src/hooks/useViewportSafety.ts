/**
 * useViewportSafety Hook
 *
 * Manages CSS custom properties for safe layout dimensions and virtual keyboard
 * handling across all platforms.
 *
 * Two concerns:
 *
 * 1. **iPad Safari `--safe-height`**: On iPad Safari, `window.visualViewport.height`
 *    is the actual visible content area after all browser chrome (tab bar, address
 *    bar) is subtracted. This hook sets `--safe-height` on `document.documentElement`
 *    so layout components can use it instead of `100svh` which does not account for
 *    Safari's tab bar overlay.
 *
 * 2. **Virtual keyboard detection (all platforms)**: When a virtual keyboard appears
 *    (detected via `visualViewport.height < window.innerHeight`), the hook:
 *    - Adds `keyboard-open` class to `<html>` for CSS targeting
 *    - Sets `--safe-height` to `visualViewport.height` (on all platforms, not just
 *      iPad Safari) so the app container shrinks to match the visible area
 *    - Sets `--bottom-bar-height` to `0px` to remove padding reserved for the
 *      BottomTabBar (which is `position: fixed; bottom: 0` and hidden behind the
 *      keyboard on mobile)
 *
 *    When the keyboard closes, these overrides are removed and a `resize` event is
 *    dispatched so the BottomTabBar's ResizeObserver re-measures its height.
 *
 * **IMPORTANT**: This hook must only be called **once globally** in `App.tsx`.
 * Downstream components must NOT call it themselves — doing so would create
 * duplicate event listeners and redundant DOM writes.
 */

import { useEffect } from 'preact/hooks';

/** Minimum visual viewport shrinkage (px) to consider the keyboard visible. */
const KEYBOARD_THRESHOLD = 50;

/**
 * Detect iPad Safari.
 *
 * Strategy:
 * - `navigator.maxTouchPoints > 1` distinguishes iPadOS from macOS on
 *   non-touch Macs (iPadOS always reports ≥ 5 touch points; desktop Macs
 *   report 0). The deprecated `navigator.platform` API is intentionally avoided.
 * - User agent contains "Safari" but NOT "Chrome", "CriOS" (Chrome on iOS),
 *   or "FxiOS" (Firefox on iOS) because iPadOS masquerades as macOS Safari.
 */
function isIpadSafari(): boolean {
	if (typeof navigator === 'undefined' || typeof window === 'undefined') {
		return false;
	}
	const ua = navigator.userAgent;
	const hasTouch = navigator.maxTouchPoints > 1;
	const isSafariUA =
		ua.includes('Safari') &&
		!ua.includes('Chrome') &&
		!ua.includes('CriOS') &&
		!ua.includes('FxiOS');
	return hasTouch && isSafariUA;
}

/**
 * Update the `--safe-height` CSS custom property on `document.documentElement`
 * using the current `visualViewport.height`.
 */
function updateSafeHeight(vv: VisualViewport): void {
	document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
}

/**
 * Check whether the virtual keyboard is currently visible by comparing
 * `visualViewport.height` with `window.innerHeight`.
 */
function isKeyboardVisible(vv: VisualViewport): boolean {
	return window.innerHeight - vv.height > KEYBOARD_THRESHOLD;
}

/**
 * Hook that manages viewport-related CSS custom properties:
 *
 * - On **iPad Safari**: always sets `--safe-height` from `visualViewport.height`
 *   to handle Safari's tab bar overlay.
 *
 * - On **all platforms with visualViewport**: detects virtual keyboard open/close
 *   and adjusts `--safe-height` and `--bottom-bar-height` to prevent the
 *   black gap between the keyboard and app bottom.
 *
 * Must be called **once globally** in `App.tsx` only.
 */
export function useViewportSafety(): void {
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) {
			// No VisualViewport API — CSS fallback handles it.
			return;
		}

		const ipadSafari = isIpadSafari();
		let keyboardOpen = false;
		let savedBottomBarHeight: string | null = null;

		/**
		 * Core resize handler. Runs on every `visualViewport.resize` and
		 * `window.resize` event to keep layout in sync.
		 */
		const handleResize = () => {
			// Part 1: iPad Safari — always keep --safe-height in sync
			if (ipadSafari) {
				updateSafeHeight(vv);
			}

			// Part 2: Keyboard detection (all platforms)
			const kbVisible = isKeyboardVisible(vv);

			if (kbVisible && !keyboardOpen) {
				// Keyboard just appeared
				keyboardOpen = true;
				document.documentElement.classList.add('keyboard-open');

				// Shrink the app container to the visible viewport height
				document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);

				// Remove bottom bar padding — the BottomTabBar is fixed at bottom:0
				// and hidden behind the keyboard, so reserving space for it creates a gap
				savedBottomBarHeight =
					document.documentElement.style.getPropertyValue('--bottom-bar-height');
				document.documentElement.style.setProperty('--bottom-bar-height', '0px');
			} else if (!kbVisible && keyboardOpen) {
				// Keyboard just closed
				keyboardOpen = false;
				document.documentElement.classList.remove('keyboard-open');

				// On non-iPad browsers, remove the --safe-height override so the
				// CSS fallback (100svh) takes effect again
				if (!ipadSafari) {
					document.documentElement.style.removeProperty('--safe-height');
				}
				// On iPad, --safe-height is already updated above via updateSafeHeight()

				// Restore bottom bar height from saved value
				if (savedBottomBarHeight) {
					document.documentElement.style.setProperty('--bottom-bar-height', savedBottomBarHeight);
					savedBottomBarHeight = null;
				}

				// Dispatch resize so BottomTabBar's ResizeObserver re-measures
				window.dispatchEvent(new Event('resize'));
			}
		};

		// Set initial --safe-height for iPad Safari
		if (ipadSafari) {
			updateSafeHeight(vv);
		}

		// Check initial keyboard state (e.g. if keyboard was already open)
		if (isKeyboardVisible(vv)) {
			keyboardOpen = true;
			document.documentElement.classList.add('keyboard-open');
			document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
			savedBottomBarHeight = document.documentElement.style.getPropertyValue('--bottom-bar-height');
			document.documentElement.style.setProperty('--bottom-bar-height', '0px');
		}

		// `visualViewport.resize` fires whenever the visible area changes
		// (address bar show/hide, keyboard appearance, etc.).
		// `window.resize` fires on device rotation.
		vv.addEventListener('resize', handleResize);
		window.addEventListener('resize', handleResize);

		return () => {
			vv.removeEventListener('resize', handleResize);
			window.removeEventListener('resize', handleResize);

			// Cleanup: restore original state
			document.documentElement.classList.remove('keyboard-open');
			if (savedBottomBarHeight) {
				document.documentElement.style.setProperty('--bottom-bar-height', savedBottomBarHeight);
			}
		};
	}, []);
}
