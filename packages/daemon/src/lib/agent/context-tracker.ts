/**
 * ContextTracker - Context window usage tracking via /context command
 *
 * Context info is obtained by parsing the /context slash command response
 * after each user message. This provides accurate, categorized breakdown
 * of the context window usage.
 */

import type { ContextInfo } from '@neokai/shared';

export class ContextTracker {
	/**
	 * Current context info - the latest snapshot of context window usage
	 * Updated after each /context command response
	 */
	private currentContextInfo: ContextInfo | null = null;

	constructor(
		private sessionId: string,
		private persistContext: (info: ContextInfo) => void
	) {}

	/**
	 * Get current context info
	 */
	getContextInfo(): ContextInfo | null {
		return this.currentContextInfo;
	}

	/**
	 * Restore context info from session metadata (on session load)
	 */
	restoreFromMetadata(savedContext: ContextInfo): void {
		this.currentContextInfo = savedContext;
	}

	/**
	 * Update context info with detailed breakdown from /context command
	 */
	updateWithDetailedBreakdown(contextInfo: ContextInfo): void {
		this.currentContextInfo = contextInfo;
		this.persistContext(contextInfo);
	}

	/**
	 * Update model (no-op: model is parsed from /context output)
	 */
	setModel(_model: string): void {
		// Model is extracted from /context command output, not tracked here
	}
}
