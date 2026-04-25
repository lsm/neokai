/**
 * Space task thread render-style configuration.
 *
 * Two modes:
 * - 'compact': bracket-rail compact renderer (`SpaceTaskCardFeed`) — the
 *   default. Keeps tool cards, thinking blocks, and per-turn brackets.
 * - 'minimal': Slack-style group-chat renderer (`MinimalThreadFeed`). One
 *   row per agent turn: avatar + name + last message for completed turns,
 *   or a coloured-rail live tool roster for the active turn. No tool
 *   cards, no thinking, no brackets.
 *
 * The config key is `neokai:space.taskThreadRenderStyle` in localStorage.
 * Switch in devtools with:
 *   localStorage.setItem('neokai:space.taskThreadRenderStyle', 'minimal')
 */

export type SpaceTaskThreadRenderStyle = 'compact' | 'minimal';

const RENDER_STYLE_KEY = 'neokai:space.taskThreadRenderStyle';

/**
 * Default render style for Space task threads.
 *
 * Flip to `'minimal'` here to make every task thread render as the
 * Slack-style minimal feed without any other code changes.
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
		if (stored === 'compact' || stored === 'minimal') return stored;
	} catch {
		// localStorage may be unavailable in sandboxed or SSR contexts.
	}
	return DEFAULT_SPACE_TASK_THREAD_RENDER_STYLE;
}

/**
 * Persist the task thread render style to localStorage.
 *
 * The change takes effect on the next render of SpaceTaskUnifiedThread.
 */
export function setSpaceTaskThreadRenderStyle(style: SpaceTaskThreadRenderStyle): void {
	try {
		localStorage.setItem(RENDER_STYLE_KEY, style);
	} catch {
		// Silently ignore QuotaExceededError, SecurityError, etc.
	}
}
