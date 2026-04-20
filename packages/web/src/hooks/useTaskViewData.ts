/**
 * useTaskViewData
 *
 * Encapsulates all data-fetching, action handlers, modal states, and derived
 * permission flags for the TaskView component. Extracted so V2 can reuse the
 * same logic without duplicating code.
 */

import type { NeoTask, RoomGoal, SessionInfo, TaskStatus } from '@neokai/shared';
import { useComputed } from '@preact/signals';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useMessageHub } from './useMessageHub';
import { useModal } from './useModal';
import type { UseModalResult } from './useModal';
import { roomStore } from '../lib/room-store';
import { navigateToRoom } from '../lib/router';
import { toast } from '../lib/toast';

export interface TaskGroupInfo {
	id: string;
	taskId: string;
	workerSessionId: string;
	leaderSessionId: string;
	workerRole: string;
	feedbackIteration: number;
	submittedForReview: boolean;
	createdAt: number;
	completedAt: number | null;
	/** Session info bundled with group to avoid separate round-trips (may be null if not available) */
	workerSession?: SessionInfo | null;
	leaderSession?: SessionInfo | null;
}

export interface UseTaskViewDataResult {
	task: NeoTask | null;
	group: TaskGroupInfo | null;
	workerSession: SessionInfo | null;
	leaderSession: SessionInfo | null;
	isLoading: boolean;
	error: string | null;
	associatedGoal: RoomGoal | null;
	conversationKey: number;
	// Action handlers
	approveReviewedTask: () => Promise<void>;
	rejectReviewedTask: (feedback: string) => Promise<void>;
	interruptSession: () => Promise<void>;
	reactivateTask: () => Promise<void>;
	completeTask: (summary: string) => Promise<void>;
	cancelTask: () => Promise<void>;
	archiveTask: () => Promise<void>;
	setTaskStatusManually: (newStatus: TaskStatus) => Promise<void>;
	// Loading states
	approving: boolean;
	rejecting: boolean;
	interrupting: boolean;
	reactivating: boolean;
	// Error states
	reviewError: string | null;
	// Modal states
	rejectModal: UseModalResult;
	completeModal: UseModalResult;
	cancelModal: UseModalResult;
	archiveModal: UseModalResult;
	setStatusModal: UseModalResult;
	// Permission flags
	canCancel: boolean;
	canInterrupt: boolean;
	canReactivate: boolean;
	canComplete: boolean;
	canArchive: boolean;
}

export function useTaskViewData(roomId: string, taskId: string): UseTaskViewDataResult {
	const { request, onEvent, joinRoom, leaveRoom, isConnected } = useMessageHub();
	// Derive task reactively from roomStore.tasks so LiveQuery deltas are reflected immediately.
	// Match by UUID or short ID so deep links like /room/:roomId/task/t-616 resolve correctly.
	const task = useComputed(
		() => roomStore.tasks.value.find((t) => t.id === taskId || t.shortId === taskId) ?? null
	);
	const [group, setGroup] = useState<TaskGroupInfo | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [conversationKey, setConversationKey] = useState(0);
	const [workerSession, setWorkerSession] = useState<SessionInfo | null>(null);
	const [leaderSession, setLeaderSession] = useState<SessionInfo | null>(null);
	const [interrupting, setInterrupting] = useState(false);
	const [approving, setApproving] = useState(false);
	const [rejecting, setRejecting] = useState(false);
	const [reviewError, setReviewError] = useState<string | null>(null);
	const [reactivating, setReactivating] = useState(false);

	const completeModal = useModal();
	const cancelModal = useModal();
	const rejectModal = useModal();
	const archiveModal = useModal();
	const setStatusModal = useModal();

	// Look up the goal associated with this task (reverse lookup from roomStore).
	// goalByTaskId is keyed by UUID, so use the resolved task's id when taskId is a short ID.
	const associatedGoal = roomStore.goalByTaskId.value.get(task.value?.id ?? taskId) ?? null;

	useEffect(() => {
		const channel = `room:${roomId}`;
		joinRoom(channel);
		let cancelled = false;
		let fetchGroupSeq = 0;

		// Track current session IDs for session.updated event subscriptions
		const currentSessionIds = { worker: '', leader: '' };

		const fetchGroup = async () => {
			const seq = ++fetchGroupSeq;

			const tryFetch = async (): Promise<{ group: TaskGroupInfo | null } | null> => {
				try {
					return await request<{ group: TaskGroupInfo | null }>('task.getGroup', {
						roomId,
						taskId,
					});
				} catch {
					return null;
				}
			};

			let res = await tryFetch();
			// Retry once after 200ms if the first attempt fails (e.g. daemon just restarted)
			if (res === null && !cancelled && seq === fetchGroupSeq) {
				await new Promise<void>((resolve) => setTimeout(resolve, 200));
				if (!cancelled && seq === fetchGroupSeq) {
					res = await tryFetch();
				}
			}

			if (res !== null && !cancelled && seq === fetchGroupSeq) {
				const grp = res.group;
				setGroup(grp);
				// Session info is bundled into task.getGroup response by the daemon,
				// so no extra session.get round-trips are needed.
				setWorkerSession(grp?.workerSession ?? null);
				setLeaderSession(grp?.leaderSession ?? null);
				currentSessionIds.worker = grp?.workerSession?.id ?? '';
				currentSessionIds.leader = grp?.leaderSession?.id ?? '';
			}
		};

		const load = async () => {
			// Guard: skip load if not connected (the effect will re-trigger when connection is restored)
			if (!isConnected) {
				setError(null);
				setIsLoading(false);
				return;
			}

			// Clear any stale error from previous failed attempts
			setError(null);
			setIsLoading(true);

			try {
				await fetchGroup();
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load task');
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		};

		load();

		// Update session model when session.updated event is received for worker or leader.
		// This ensures the model label in TaskInfoPanel updates immediately after a model switch.
		const unsubSessionUpdate = onEvent<{ sessionId: string; model?: string }>(
			'session.updated',
			(event) => {
				if (cancelled) return;
				if (event.sessionId === currentSessionIds.worker && event.model) {
					setWorkerSession((prev) =>
						prev ? { ...prev, config: { ...prev.config, model: event.model! } } : null
					);
				}
				if (event.sessionId === currentSessionIds.leader && event.model) {
					setLeaderSession((prev) =>
						prev ? { ...prev, config: { ...prev.config, model: event.model! } } : null
					);
				}
			}
		);

		return () => {
			cancelled = true;
			unsubSessionUpdate();
			leaveRoom(channel);
		};
	}, [roomId, taskId, isConnected]);

	// Derived permission flags
	const canComplete = task.value
		? task.value.status === 'in_progress' || task.value.status === 'review'
		: false;
	const canCancel = task.value
		? task.value.status === 'pending' ||
			task.value.status === 'in_progress' ||
			task.value.status === 'review'
		: false;
	const canReactivate = task.value
		? task.value.status === 'completed' || task.value.status === 'cancelled'
		: false;
	const canArchive = task.value
		? task.value.status === 'completed' ||
			task.value.status === 'cancelled' ||
			task.value.status === 'needs_attention'
		: false;
	const canInterrupt = task.value
		? task.value.status === 'in_progress' || task.value.status === 'review'
		: false;

	const completeTask = useCallback(
		async (summary: string) => {
			await request('task.setStatus', {
				roomId,
				taskId,
				status: 'completed',
				result: summary || 'Marked complete by user',
				mode: 'manual',
			});
			completeModal.close();
			toast.success('Task completed');
			navigateToRoom(roomId);
		},
		[request, roomId, taskId, completeModal]
	);

	const cancelTask = useCallback(async () => {
		await request('task.cancel', { roomId, taskId });
		cancelModal.close();
		toast.info('Task cancelled');
		navigateToRoom(roomId);
	}, [request, roomId, taskId, cancelModal]);

	const reactivateTask = useCallback(async () => {
		if (reactivating) return;
		setReactivating(true);
		try {
			await request('task.setStatus', { roomId, taskId, status: 'in_progress', mode: 'manual' });
			toast.success('Task reactivated');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to reactivate task');
		} finally {
			setReactivating(false);
		}
	}, [request, roomId, taskId, reactivating]);

	const archiveTask = useCallback(async () => {
		await request('task.setStatus', { roomId, taskId, status: 'archived', mode: 'manual' });
		archiveModal.close();
		toast.info('Task archived');
		navigateToRoom(roomId);
	}, [request, roomId, taskId, archiveModal]);

	const setTaskStatusManually = useCallback(
		async (newStatus: TaskStatus) => {
			await request('task.setStatus', {
				roomId,
				taskId,
				status: newStatus,
				mode: 'manual',
			});
			setStatusModal.close();
			toast.success(`Task status set to ${newStatus.replace('_', ' ')}`);
			if (newStatus === 'archived') {
				navigateToRoom(roomId);
			}
		},
		[request, roomId, taskId, setStatusModal]
	);

	const interruptSession = useCallback(async () => {
		if (interrupting) return;
		setInterrupting(true);
		try {
			await request('task.interruptSession', { roomId, taskId });
		} catch (err) {
			// Best-effort: ignore errors from interrupt (session may already be idle)
			void err;
		} finally {
			setInterrupting(false);
		}
	}, [request, roomId, taskId, interrupting]);

	const approveReviewedTask = useCallback(async () => {
		if (approving) return;
		setApproving(true);
		setReviewError(null);
		try {
			await request('task.approve', { roomId, taskId });
			setConversationKey((k) => k + 1);
		} catch (err) {
			setReviewError(err instanceof Error ? err.message : 'Failed to approve task');
		} finally {
			setApproving(false);
		}
	}, [request, roomId, taskId, approving]);

	const rejectReviewedTask = useCallback(
		async (feedback: string) => {
			if (rejecting) return;
			setRejecting(true);
			setReviewError(null);
			try {
				await request('task.reject', { roomId, taskId, feedback });
				rejectModal.close();
				setConversationKey((k) => k + 1);
			} catch (err) {
				setReviewError(err instanceof Error ? err.message : 'Failed to reject task');
			} finally {
				setRejecting(false);
			}
		},
		[request, roomId, taskId, rejecting, rejectModal]
	);

	return {
		task: task.value,
		group,
		workerSession,
		leaderSession,
		isLoading,
		error,
		associatedGoal,
		conversationKey,
		approveReviewedTask,
		rejectReviewedTask,
		interruptSession,
		reactivateTask,
		completeTask,
		cancelTask,
		archiveTask,
		setTaskStatusManually,
		approving,
		rejecting,
		interrupting,
		reactivating,
		reviewError,
		rejectModal,
		completeModal,
		cancelModal,
		archiveModal,
		setStatusModal,
		canCancel,
		canInterrupt,
		canReactivate,
		canComplete,
		canArchive,
	};
}
