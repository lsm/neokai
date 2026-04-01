/**
 * useViewportSafety Hook
 *
 * Manages CSS custom properties for safe layout dimensions on iPad Safari.
 *
 * On iPad Safari, `window.visualViewport.height` is the actual visible content
 * area after all browser chrome (tab bar, address bar) is subtracted. This hook
 * sets `--safe-height` on `document.documentElement` so layout components can
 * use it instead of `100svh` which does not account for Safari's tab bar overlay.
 *
 * On all other browsers, `--safe-height` is NOT set — the CSS fallback (`100svh`)
 * takes effect automatically.
 *
 * **IMPORTANT**: This hook must only be called **once globally** in `App.tsx`.
 * Downstream components must NOT call it themselves — doing so would create
 * duplicate event listeners and redundant DOM writes.
 */

import { useEffect } from 'preact/hooks';

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
 * Hook that detects iPad Safari and sets `--safe-height` CSS custom property
 * from `window.visualViewport.height`. Listens to `visualViewport.resize` and
 * `window.resize` to keep the value current (e.g. when the address bar shows
 * or hides, or the device rotates).
 *
 * On non-iPad-Safari browsers this hook is a no-op — the CSS fallback (`100svh`)
 * handles those environments.
 *
 * Must be called **once globally** in `App.tsx` only.
 */
export function useViewportSafety(): void {
	useEffect(() => {
		if (!isIpadSafari()) {
			return;
		}

		const vv = window.visualViewport;
		if (!vv) {
			// No VisualViewport API — CSS fallback handles it.
			return;
		}

		// Set initial value immediately.
		updateSafeHeight(vv);

		const handleResize = () => updateSafeHeight(vv);

		// `visualViewport.resize` fires whenever the visible area changes
		// (address bar show/hide, keyboard appearance, etc.).
		// `window.resize` fires on device rotation — iPadOS also fires
		// `orientationchange`, but `resize` subsumes it so no separate
		// `orientationchange` listener is needed.
		vv.addEventListener('resize', handleResize);
		window.addEventListener('resize', handleResize);

		return () => {
			vv.removeEventListener('resize', handleResize);
			window.removeEventListener('resize', handleResize);
		};
	}, []);
}
