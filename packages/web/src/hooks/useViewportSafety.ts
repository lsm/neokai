/**
 * useViewportSafety Hook
 *
 * Manages CSS custom properties for safe layout dimensions and virtual keyboard
 * handling across all platforms.
 *
 * Two concerns:
 *
 * 1. **Touch Safari native handling**: On iPhone/iPad Safari, virtual keyboard
 *    resizing and focused-input anchoring are left to Safari. Custom layout
 *    compensation can fight the browser when a focused textarea grows.
 *
 * 2. **Virtual keyboard detection (non-touch-Safari platforms)**: When a virtual
 *    keyboard appears (detected via `window.innerHeight - visualViewport.height > 50px`), the hook:
 *    - Adds `keyboard-open` class to `<html>` for CSS targeting
 *    - Sets `--safe-height` to `visualViewport.height` so the app container shrinks
 *      to match the visible area
 *    - Sets `--bottom-bar-height` to `0px` to remove padding reserved for the
 *      BottomTabBar (which is `position: fixed; bottom: 0` and hidden behind the
 *      keyboard on mobile)
 *
 *    When the keyboard closes, these overrides are removed and a `resize` event is
 *    dispatched so the BottomTabBar's ResizeObserver re-measures its height.
 *
 * **Known limitation**: On iOS Safari, `window.innerHeight` itself changes when the
 * address bar shows/hides. This can cause the keyboard detection delta to undercount
 * the keyboard size in edge cases (e.g. small split-screen on iPad). The 50px
 * threshold provides a reasonable buffer. A more robust approach would use the
 * `navigator.virtualKeyboard` API, but it is not broadly supported yet.
 *
 * **IMPORTANT**: This hook must only be called **once globally** in `App.tsx`.
 * Downstream components must NOT call it themselves — doing so would create
 * duplicate event listeners and redundant DOM writes.
 */

import { useEffect } from 'preact/hooks';

/** Minimum visual viewport shrinkage (px) to consider the keyboard visible. */
const KEYBOARD_THRESHOLD = 50;

/**
 * Detect touch Safari (iPhone/iPad Safari, including iPadOS desktop-style UA).
 *
 * We intentionally let touch Safari handle virtual-keyboard resizing natively.
 * Custom keyboard compensation (safe-height writes, bottom-bar padding changes,
 * keyboard-open layout class) can fight Safari's focused-input anchoring when a
 * textarea grows while the keyboard and bottom address bar are visible.
 */
function isTouchSafari(): boolean {
	if (typeof navigator === 'undefined' || typeof window === 'undefined') {
		return false;
	}
	const ua = navigator.userAgent;
	const hasTouch = navigator.maxTouchPoints > 0;
	const isSafariUA =
		ua.includes('Safari') &&
		!/(Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|YaBrowser)/.test(ua);
	return hasTouch && isSafariUA;
}

/**
 * Update the `--keyboard-height` CSS custom property on `document.documentElement`.
 *
 * Computes the area covered by the virtual keyboard using the visual viewport's
 * bottom edge relative to the layout viewport. When iOS auto-pans the page on
 * focus, `visualViewport.offsetTop` becomes non-zero; subtracting it prevents
 * overestimating the keyboard height and avoids an artificial gap above the
 * composer.
 */
function updateKeyboardHeight(vv: VisualViewport): void {
	const height = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
	document.documentElement.style.setProperty('--keyboard-height', `${height}px`);
}

/**
 * Check whether the virtual keyboard is currently visible by comparing
 * `visualViewport.height` with `window.innerHeight`. Returns true when the
 * difference exceeds {@link KEYBOARD_THRESHOLD} to avoid false positives from
 * browser chrome changes (address bar, etc.).
 *
 * **Known limitation**: On iOS Safari, `window.innerHeight` itself fluctuates
 * when the address bar shows/hides, so the delta may undercount the keyboard
 * size. The 50px threshold mitigates this.
 */
function isKeyboardVisible(vv: VisualViewport): boolean {
	return window.innerHeight - vv.height > KEYBOARD_THRESHOLD;
}

/**
 * Hook that manages viewport-related CSS custom properties:
 *
 * - On **touch Safari**: leaves virtual-keyboard layout to Safari's native
 *   focused-input handling.
 *
 * - On **other platforms with visualViewport**: detects virtual keyboard open/close
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

		const touchSafari = isTouchSafari();
		let keyboardOpen = false;
		let savedBottomBarHeight: string | null = null;

		/**
		 * Core resize handler. Runs on every `visualViewport.resize` and
		 * `window.resize` event to keep layout in sync.
		 */
		const handleResize = () => {
			// Let touch Safari handle virtual-keyboard geometry natively. Its focused-input
			// anchoring is more reliable than our layout compensation when the composer grows.
			if (touchSafari) {
				return;
			}

			// Keyboard detection (non-touch-Safari platforms)
			const kbVisible = isKeyboardVisible(vv);

			if (kbVisible && !keyboardOpen) {
				// Keyboard just appeared
				keyboardOpen = true;
				document.documentElement.classList.add('keyboard-open');

				// Shrink the app container to the visible viewport height
				document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);

				// Record keyboard height as a CSS custom property for potential future use.
				// Currently no built-in element reads this, but it is available for extensions.
				updateKeyboardHeight(vv);

				// Remove bottom bar padding — the BottomTabBar is fixed at bottom:0
				// and hidden behind the keyboard, so reserving space for it creates a gap
				savedBottomBarHeight =
					document.documentElement.style.getPropertyValue('--bottom-bar-height');
				document.documentElement.style.setProperty('--bottom-bar-height', '0px');
			} else if (kbVisible && keyboardOpen) {
				// Keep --safe-height and --keyboard-height in sync as keyboard
				// height may change (e.g. switching between emoji and text keyboards)
				document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
				updateKeyboardHeight(vv);
			} else if (!kbVisible && keyboardOpen) {
				// Keyboard just closed
				keyboardOpen = false;
				document.documentElement.classList.remove('keyboard-open');

				// Remove the --safe-height override so the CSS fallback (100svh) takes effect again
				document.documentElement.style.removeProperty('--safe-height');

				// Remove keyboard height override
				document.documentElement.style.removeProperty('--keyboard-height');

				// Restore bottom bar height from saved value.
				// NOTE: We use !== null instead of truthiness because
				// getPropertyValue returns '' when the property is not set
				// inline (e.g. on desktop where BottomTabBar is md:hidden and
				// never measures itself). null is the correct sentinel.
				if (savedBottomBarHeight !== null) {
					document.documentElement.style.setProperty('--bottom-bar-height', savedBottomBarHeight);
					savedBottomBarHeight = null;
				}

				// Dispatch resize so BottomTabBar's ResizeObserver re-measures.
				// NOTE: This is synchronous and will re-enter handleResize.
				// This is safe: keyboardOpen is already false and the keyboard
				// is not visible, so neither branch of the keyboard detection
				// logic executes. The only redundant work is an extra
				// safe-height write on touch Safari because that path returns early.
				// BottomTabBar's listener uses requestAnimationFrame so it
				// won't interfere with this handler's execution.
				window.dispatchEvent(new Event('resize'));
			}
		};

		// Check initial keyboard state (e.g. if keyboard was already open)
		if (!touchSafari && isKeyboardVisible(vv)) {
			keyboardOpen = true;
			document.documentElement.classList.add('keyboard-open');
			document.documentElement.style.setProperty('--safe-height', `${vv.height}px`);
			updateKeyboardHeight(vv);
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
			document.documentElement.style.removeProperty('--safe-height');
			document.documentElement.style.removeProperty('--keyboard-height');
			if (savedBottomBarHeight !== null) {
				document.documentElement.style.setProperty('--bottom-bar-height', savedBottomBarHeight);
			}
		};
	}, []);
}
