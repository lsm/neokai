/**
 * useTaskInputDraft Hook
 *
 * Manages draft persistence for the task view message input using localStorage.
 * Unlike useInputDraft (which persists to the server via session metadata),
 * this hook stores drafts locally per task ID.
 *
 * Features:
 * - Auto-saves as the user types (debounced 500ms)
 * - Restores draft when returning to a task
 * - Clears draft on successful send
 * - Cleans up drafts older than 7 days on initialization
 * - Each task has its own independent draft
 * - Flushes any pending debounced save on unmount so no keystroke is lost
 *
 * IMPORTANT: Uses Preact Signals instead of useState to prevent lost keystrokes.
 * See useInputDraft.ts for rationale.
 *
 * IMPORTANT: The draft is loaded synchronously at initialization to prevent
 * the useSignalEffect (which clears storage for empty content) from wiping
 * the stored draft before it can be loaded in a useEffect.
 */

import { useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useSignal, useSignalEffect } from '@preact/signals';

const STORAGE_KEY_PREFIX = 'neokai_task_draft_';
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface StoredDraft {
	taskId: string;
	message: string;
	timestamp: number;
}

function getStorageKey(taskId: string): string {
	return `${STORAGE_KEY_PREFIX}${taskId}`;
}

function loadDraftFromStorage(taskId: string): string {
	try {
		const raw = localStorage.getItem(getStorageKey(taskId));
		if (!raw) return '';
		const parsed: StoredDraft = JSON.parse(raw);
		const age = Date.now() - parsed.timestamp;
		if (age > DRAFT_MAX_AGE_MS) {
			localStorage.removeItem(getStorageKey(taskId));
			return '';
		}
		return parsed.message;
	} catch {
		localStorage.removeItem(getStorageKey(taskId));
		return '';
	}
}

function saveDraftToStorage(taskId: string, message: string): void {
	try {
		if (!message.trim()) {
			localStorage.removeItem(getStorageKey(taskId));
			return;
		}
		const draft: StoredDraft = { taskId, message, timestamp: Date.now() };
		localStorage.setItem(getStorageKey(taskId), JSON.stringify(draft));
	} catch {
		// Ignore localStorage quota errors
	}
}

function removeDraftFromStorage(taskId: string): void {
	try {
		localStorage.removeItem(getStorageKey(taskId));
	} catch {
		// Ignore errors
	}
}

/** Clean up all task drafts older than 7 days */
function cleanupStaleDrafts(): void {
	try {
		const keys = Object.keys(localStorage).filter((k) => k.startsWith(STORAGE_KEY_PREFIX));
		for (const key of keys) {
			try {
				const raw = localStorage.getItem(key);
				if (!raw) continue;
				const parsed: StoredDraft = JSON.parse(raw);
				if (Date.now() - parsed.timestamp > DRAFT_MAX_AGE_MS) {
					localStorage.removeItem(key);
				}
			} catch {
				localStorage.removeItem(key);
			}
		}
	} catch {
		// Ignore errors
	}
}

export interface UseTaskInputDraftResult {
	/** Current draft content */
	content: string;
	/** Update the content (triggers debounced save) */
	setContent: (content: string) => void;
	/** Clear content and remove the stored draft */
	clear: () => void;
	/** Whether the draft was restored from storage on mount */
	draftRestored: boolean;
}

/**
 * Hook for managing task message input draft persistence via localStorage.
 *
 * @param taskId - Current task ID (each task has its own draft)
 * @param debounceMs - Debounce delay for saving (default: 500ms)
 */
export function useTaskInputDraft(taskId: string, debounceMs = 500): UseTaskInputDraftResult {
	// Clean up stale drafts once at module level per component mount.
	// Done synchronously here so it completes before any draft loading.
	const cleanupDoneRef = useRef(false);
	if (!cleanupDoneRef.current) {
		cleanupDoneRef.current = true;
		cleanupStaleDrafts();
	}

	// Load draft synchronously on first render so the initial signal value
	// is already populated — this prevents useSignalEffect from seeing an
	// empty value and clearing the stored draft before we've had a chance to
	// read it.
	const initialDraft = useRef<string | null>(null);
	if (initialDraft.current === null) {
		initialDraft.current = taskId ? loadDraftFromStorage(taskId) : '';
	}

	const contentSignal = useSignal(initialDraft.current);
	const draftRestoredSignal = useSignal(initialDraft.current !== '');

	const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevTaskIdRef = useRef<string>(taskId);

	// Keep a stable ref to the current taskId so the signal effect and callbacks
	// can read it without taking a dependency on the primitive value. This avoids
	// fragile closure captures and keeps `clear` stable across task switches.
	const taskIdRef = useRef<string>(taskId);
	taskIdRef.current = taskId;

	// When taskId changes, reload the draft for the new task
	useEffect(() => {
		// Skip if taskId hasn't actually changed
		if (prevTaskIdRef.current === taskId) return;
		prevTaskIdRef.current = taskId;

		// Clear content immediately to avoid showing previous task's draft
		contentSignal.value = '';
		draftRestoredSignal.value = false;

		if (!taskId) return;

		const savedMessage = loadDraftFromStorage(taskId);
		if (savedMessage) {
			contentSignal.value = savedMessage;
			draftRestoredSignal.value = true;
		}
	}, [taskId, contentSignal, draftRestoredSignal]);

	// Flush any pending debounced save on unmount so no keystroke is lost
	useEffect(() => {
		return () => {
			if (draftSaveTimeoutRef.current) {
				clearTimeout(draftSaveTimeoutRef.current);
				draftSaveTimeoutRef.current = null;
			}
			const currentTaskId = taskIdRef.current;
			const content = contentSignal.peek();
			if (currentTaskId && content.trim()) {
				saveDraftToStorage(currentTaskId, content);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Debounced save via signal effect.
	// Reads taskId via taskIdRef (a stable ref) rather than the prop directly,
	// so the closure is always up-to-date without adding a non-signal dependency.
	useSignalEffect(() => {
		const content = contentSignal.value;
		const currentTaskId = taskIdRef.current;

		// Clear any pending save
		if (draftSaveTimeoutRef.current) {
			clearTimeout(draftSaveTimeoutRef.current);
			draftSaveTimeoutRef.current = null;
		}

		if (!currentTaskId) return;

		// Empty: clear immediately
		if (!content.trim()) {
			removeDraftFromStorage(currentTaskId);
			return;
		}

		// Non-empty: debounce save
		draftSaveTimeoutRef.current = setTimeout(() => {
			saveDraftToStorage(currentTaskId, content);
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
			// Dismiss the "draft restored" notification once the user starts interacting
			if (draftRestoredSignal.value) {
				draftRestoredSignal.value = false;
			}
			contentSignal.value = newContent;
		},
		[contentSignal, draftRestoredSignal]
	);

	// Uses taskIdRef so the reference stays stable across task switches —
	// the ref is always current, so clear() always targets the active task.
	const clear = useCallback(() => {
		contentSignal.value = '';
		draftRestoredSignal.value = false;
		const currentTaskId = taskIdRef.current;
		if (currentTaskId) {
			removeDraftFromStorage(currentTaskId);
		}
	}, [contentSignal, draftRestoredSignal, taskIdRef]);

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
