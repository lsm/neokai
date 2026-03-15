/**
 * useTaskInputDraft Hook
 *
 * Manages draft persistence for the task view message input using server-side storage.
 * Mirrors the pattern of useInputDraft (which persists session chat drafts), but uses
 * task.get / task.updateDraft RPC calls instead of session.get / session.update.
 *
 * Features:
 * - Loads draft from server on mount / task change
 * - Auto-saves as the user types (debounced 500ms)
 * - Clears draft on successful send via clear()
 * - Flushes any pending debounced save on unmount so no keystroke is lost
 * - Each task has its own independent draft
 *
 * IMPORTANT: Uses Preact Signals instead of useState to prevent lost keystrokes.
 * See useInputDraft.ts for rationale.
 */

import { useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useSignal, useSignalEffect } from '@preact/signals';
import { connectionManager } from '../lib/connection-manager';

export interface UseTaskInputDraftResult {
	/** Current draft content */
	content: string;
	/** Update the content (triggers debounced save) */
	setContent: (content: string) => void;
	/** Clear content and remove the stored draft */
	clear: () => void;
	/** Whether the draft was restored from server on mount */
	draftRestored: boolean;
}

/**
 * Hook for managing task message input draft persistence via server-side storage.
 *
 * @param roomId - Room this task belongs to
 * @param taskId - Current task ID (each task has its own draft)
 * @param debounceMs - Debounce delay for saving (default: 500ms)
 */
export function useTaskInputDraft(
	roomId: string,
	taskId: string,
	debounceMs = 500
): UseTaskInputDraftResult {
	const contentSignal = useSignal('');
	const draftRestoredSignal = useSignal(false);
	const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Guard to prevent the signal effect from sending a spurious task.updateDraft(null)
	// when the content is cleared at the start of a new task load, before the server
	// draft has been fetched.
	//
	// Set to true when useEffect clears content for a new task; cleared when:
	//   (a) the user explicitly calls setContent() (user interaction wins), or
	//   (b) loadDraft() completes (regardless of outcome).
	//
	// This is intentionally scoped to only guard the "empty-content clear" path inside
	// useSignalEffect — user-initiated calls to setContent always take effect immediately.
	const isLoadingRef = useRef(false);

	// Keep stable refs so signal effects and callbacks always see current values
	// without taking a dependency on the primitive (avoids stale closures).
	const taskIdRef = useRef<string>(taskId);
	taskIdRef.current = taskId;
	const roomIdRef = useRef<string>(roomId);
	roomIdRef.current = roomId;

	// Load draft when taskId/roomId changes (including on mount).
	// Clear content immediately on each change so the previous task's draft isn't shown.
	useEffect(() => {
		isLoadingRef.current = true;
		contentSignal.value = '';
		draftRestoredSignal.value = false;

		if (!taskId || !roomId) {
			isLoadingRef.current = false;
			return;
		}

		const loadDraft = async () => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				isLoadingRef.current = false;
				return;
			}

			try {
				const response = await hub.request<{ task: { inputDraft?: string | null } }>('task.get', {
					roomId,
					taskId,
				});
				const draft = response.task?.inputDraft;
				if (draft) {
					contentSignal.value = draft;
					draftRestoredSignal.value = true;
				}
			} catch {
				// Ignore errors loading draft
			} finally {
				isLoadingRef.current = false;
			}
		};

		loadDraft();
	}, [taskId, roomId, contentSignal, draftRestoredSignal]);

	// Flush any pending debounced save on unmount so no keystroke is lost
	useEffect(() => {
		return () => {
			if (draftSaveTimeoutRef.current) {
				clearTimeout(draftSaveTimeoutRef.current);
				draftSaveTimeoutRef.current = null;
			}
			const currentTaskId = taskIdRef.current;
			const currentRoomId = roomIdRef.current;
			const content = contentSignal.peek();
			if (currentTaskId && currentRoomId) {
				const hub = connectionManager.getHubIfConnected();
				if (hub) {
					hub
						.request('task.updateDraft', {
							roomId: currentRoomId,
							taskId: currentTaskId,
							draft: content.trim() || null,
						})
						.catch(() => {
							/* ignore flush errors */
						});
				}
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Debounced save via signal effect.
	// Reads taskId/roomId via stable refs so the closure is always up-to-date.
	useSignalEffect(() => {
		// IMPORTANT: read contentSignal.value FIRST so Preact Signals always
		// tracks it as a dependency — even when we skip the save below.
		// If we return early before accessing the signal, the effect loses
		// its subscription and won't re-run on future content changes.
		const content = contentSignal.value;

		// Skip during initial draft load to avoid sending a spurious
		// task.updateDraft(null) before the server draft has been fetched.
		if (isLoadingRef.current) return;
		const currentTaskId = taskIdRef.current;
		const currentRoomId = roomIdRef.current;

		// Clear any pending save
		if (draftSaveTimeoutRef.current) {
			clearTimeout(draftSaveTimeoutRef.current);
			draftSaveTimeoutRef.current = null;
		}

		if (!currentTaskId || !currentRoomId) return;

		const trimmedContent = content.trim();

		// Empty: clear immediately
		if (trimmedContent === '') {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub
					.request('task.updateDraft', {
						roomId: currentRoomId,
						taskId: currentTaskId,
						draft: null,
					})
					.catch(() => {
						/* ignore clear errors */
					});
			}
			return;
		}

		// Non-empty: debounce save
		draftSaveTimeoutRef.current = setTimeout(() => {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) return;

			hub
				.request('task.updateDraft', {
					roomId: currentRoomId,
					taskId: currentTaskId,
					draft: trimmedContent,
				})
				.catch(() => {
					/* ignore save errors */
				});
		}, debounceMs);

		return () => {
			if (draftSaveTimeoutRef.current) {
				clearTimeout(draftSaveTimeoutRef.current);
				draftSaveTimeoutRef.current = null;
			}
		};
	});

	const setContent = useCallback(
		(newContent: string) => {
			// User interaction: clear the loading guard so the signal effect can fire.
			// This handles the case where the user types before loadDraft() completes.
			isLoadingRef.current = false;
			// Dismiss the "draft restored" notification once the user starts interacting
			if (draftRestoredSignal.value) {
				draftRestoredSignal.value = false;
			}
			contentSignal.value = newContent;
		},
		[contentSignal, draftRestoredSignal]
	);

	// Uses refs so the reference stays stable across task switches
	const clear = useCallback(() => {
		contentSignal.value = '';
		draftRestoredSignal.value = false;
		const currentTaskId = taskIdRef.current;
		const currentRoomId = roomIdRef.current;
		if (currentTaskId && currentRoomId) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub
					.request('task.updateDraft', {
						roomId: currentRoomId,
						taskId: currentTaskId,
						draft: null,
					})
					.catch(() => {
						/* ignore clear errors */
					});
			}
		}
	}, [contentSignal, draftRestoredSignal]);

	return useMemo(
		() => ({
			get content() {
				return contentSignal.value;
			},
			setContent,
			clear,
			get draftRestored() {
				return draftRestoredSignal.value;
			},
		}),
		[contentSignal, draftRestoredSignal, setContent, clear]
	);
}
