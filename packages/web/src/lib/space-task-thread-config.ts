/**
 * Space task thread render-style configuration.
 *
 * Two modes:
 * - 'compact': New compact renderer — shows the last 3 logical blocks (consecutive
 *   same-agent event groups), always preserves terminal result blocks, and renders
 *   a clockwise animated border light on the last block when the thread is running.
 * - 'legacy': Previous flat-event-feed renderer (SpaceTaskThreadEventFeed).
 *   Useful as a fallback; restore by flipping DEFAULT_SPACE_TASK_THREAD_RENDER_STYLE
 *   below or by writing 'legacy' to the localStorage key.
 *
 * The config key is `neokai:space.taskThreadRenderStyle` in localStorage.
 */

export type SpaceTaskThreadRenderStyle = 'compact' | 'legacy';

const RENDER_STYLE_KEY = 'neokai:space.taskThreadRenderStyle';

/**
 * Default render style for Space task threads.
 *
 * Flip to `'legacy'` here to roll back to the previous flat-event-feed renderer
 * without any other code changes required.
 */
export const DEFAULT_SPACE_TASK_THREAD_RENDER_STYLE: SpaceTaskThreadRenderStyle = 'compact';

/**
 * Read the current task thread render style from localStorage.
 *
 * Falls back to DEFAULT_SPACE_TASK_THREAD_RENDER_STYLE when the key is absent
 * or contains an unrecognised value.
 */
export function getSpaceTaskThreadRenderStyle(): SpaceTaskThreadRenderStyle {
	try {
		const stored = localStorage.getItem(RENDER_STYLE_KEY);
		if (stored === 'legacy' || stored === 'compact') return stored;
	} catch {
		// localStorage may be unavailable in sandboxed or SSR contexts.
	}
	return DEFAULT_SPACE_TASK_THREAD_RENDER_STYLE;
}

/**
 * Persist the task thread render style to localStorage.
 *
 * Set to `'legacy'` to switch back to the previous flat-event-feed renderer.
 * The change takes effect on the next render of SpaceTaskUnifiedThread.
 */
export function setSpaceTaskThreadRenderStyle(style: SpaceTaskThreadRenderStyle): void {
	try {
		localStorage.setItem(RENDER_STYLE_KEY, style);
	} catch {
		// Silently ignore QuotaExceededError, SecurityError, etc.
	}
}
