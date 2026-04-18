/**
 * useIsMobileCanvas
 *
 * Reactive hook that reports `true` when the viewport width is below the
 * Tailwind `md` breakpoint (< 768px).
 *
 * Used by canvas components (for example, the Task Agent node) to render a
 * compact variant on phone-sized viewports while preserving desktop/tablet
 * behaviour. Scoped specifically for canvas rendering — the name avoids
 * accidental collisions with any future broader-purpose `useIsMobile` hook.
 *
 * SSR / non-browser safety: returns `false` when `window`/`matchMedia` is not
 * available. Consumers that need to know whether detection has run can
 * distinguish the initial tick by reading window size themselves.
 */
import { useEffect, useState } from 'preact/hooks';

/** Matches Tailwind's `md` breakpoint — anything below 768px is "mobile". */
export const MOBILE_CANVAS_MEDIA_QUERY = '(max-width: 767px)';

function readInitialMatch(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		return false;
	}
	try {
		return window.matchMedia(MOBILE_CANVAS_MEDIA_QUERY).matches;
	} catch {
		return false;
	}
}

export function useIsMobileCanvas(): boolean {
	const [isMobile, setIsMobile] = useState<boolean>(readInitialMatch);

	useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			return;
		}

		const mq = window.matchMedia(MOBILE_CANVAS_MEDIA_QUERY);
		// Sync after mount — the SSR/initial value may be stale by the time
		// effects run (e.g. tests that mock matchMedia after render).
		setIsMobile(mq.matches);

		const handleChange = (event: MediaQueryListEvent) => {
			setIsMobile(event.matches);
		};

		// Modern browsers: addEventListener('change'). Fall back to the legacy
		// addListener API for older WebKit variants.
		if (typeof mq.addEventListener === 'function') {
			mq.addEventListener('change', handleChange);
			return () => mq.removeEventListener('change', handleChange);
		}

		interface LegacyMediaQueryList {
			addListener?: (handler: ChangeHandler) => void;
			removeListener?: (handler: ChangeHandler) => void;
		}
		type ChangeHandler = (event: MediaQueryListEvent) => void;

		const legacy = mq as unknown as LegacyMediaQueryList;
		legacy.addListener?.(handleChange);
		return () => {
			legacy.removeListener?.(handleChange);
		};
	}, []);

	return isMobile;
}
