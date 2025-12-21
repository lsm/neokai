/**
 * useInputDraft Hook
 *
 * Manages draft persistence for message input.
 * Handles loading drafts on session change, debounced saving,
 * and immediate clearing when content is empty.
 *
 * @example
 * ```typescript
 * const { content, setContent } = useInputDraft(sessionId);
 *
 * <textarea
 *   value={content}
 *   onInput={(e) => setContent(e.target.value)}
 * />
 * ```
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager';

export interface UseInputDraftResult {
	/** Current content value */
	content: string;
	/** Update the content (triggers debounced save) */
	setContent: (content: string) => void;
	/** Clear the content and draft */
	clear: () => void;
}

/**
 * Hook for managing message input draft persistence
 *
 * @param sessionId - Current session ID
 * @param debounceMs - Debounce delay for saving (default: 250ms)
 */
export function useInputDraft(sessionId: string, debounceMs = 250): UseInputDraftResult {
	const [content, setContentState] = useState('');
	const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevSessionIdRef = useRef<string | null>(null);

	// Load draft on session change
	useEffect(() => {
		// Clear content immediately when sessionId changes
		if (!sessionId) {
			setContentState('');
			return;
		}

		// Clear content immediately to prevent showing stale draft
		setContentState('');

		const loadDraft = async () => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) return;

			try {
				const response = await hub.call<{ session: { metadata?: { inputDraft?: string } } }>(
					'session.get',
					{ sessionId }
				);
				const draft = response.session?.metadata?.inputDraft;
				if (draft) {
					setContentState(draft);
				}
			} catch (error) {
				console.error('Failed to load draft:', error);
			}
		};

		loadDraft();
	}, [sessionId]);

	// Save draft with debouncing
	useEffect(() => {
		// Clear existing timeout
		if (draftSaveTimeoutRef.current) {
			clearTimeout(draftSaveTimeoutRef.current);
			draftSaveTimeoutRef.current = null;
		}

		// If sessionId changed, flush the previous session's draft immediately
		if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
			const prevSessionId = prevSessionIdRef.current;
			const trimmedContent = content.trim();

			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub
					.call('session.update', {
						sessionId: prevSessionId,
						metadata: {
							inputDraft: trimmedContent || undefined,
						},
					})
					.catch((error) => {
						console.error('Failed to flush draft on session switch:', error);
					});
			}
		}
		prevSessionIdRef.current = sessionId;

		const trimmedContent = content.trim();

		// Empty content: save immediately to clear draft
		if (trimmedContent === '') {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub
					.call('session.update', {
						sessionId,
						metadata: {
							inputDraft: undefined,
						},
					})
					.catch((error) => {
						console.error('Failed to clear draft:', error);
					});
			}
			return;
		}

		// Non-empty content: debounce save
		draftSaveTimeoutRef.current = setTimeout(async () => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) return;

			try {
				await hub.call('session.update', {
					sessionId,
					metadata: {
						inputDraft: trimmedContent,
					},
				});
			} catch (error) {
				console.error('Failed to save draft:', error);
			}
		}, debounceMs);

		return () => {
			if (draftSaveTimeoutRef.current) {
				clearTimeout(draftSaveTimeoutRef.current);
				draftSaveTimeoutRef.current = null;
			}
		};
	}, [content, sessionId, debounceMs]);

	const setContent = useCallback((newContent: string) => {
		setContentState(newContent);
	}, []);

	const clear = useCallback(() => {
		setContentState('');
	}, []);

	return {
		content,
		setContent,
		clear,
	};
}
