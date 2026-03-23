/**
 * useTaskViewData
 *
 * Encapsulates all data-fetching, action handlers, modal states, and derived
 * permission flags for the TaskView component. Extracted so V2 can reuse the
 * same logic without duplicating code.
 */

import type { NeoTask, RoomGoal, SessionInfo, TaskStatus } from '@neokai/shared';
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
	const [task, setTask] = useState<NeoTask | null>(null);
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

	// Look up the goal associated with this task (reverse lookup from roomStore)
	const associatedGoal = roomStore.goalByTaskId.value.get(taskId) ?? null;

	useEffect(() => {
		const channel = `room:${roomId}`;
		joinRoom(channel);
		let cancelled = false;
		let fetchGroupSeq = 0;

		const fetchSessionInfo = async (grp: TaskGroupInfo | null) => {
			if (!grp) {
				setWorkerSession(null);
				setLeaderSession(null);
				return;
			}
			try {
				const [workerRes, leaderRes] = await Promise.all([
					request<{ session: SessionInfo }>('session.get', {
						sessionId: grp.workerSessionId,
					}).catch(() => null),
					request<{ session: SessionInfo }>('session.get', {
						sessionId: grp.leaderSessionId,
					}).catch(() => null),
				]);
				if (!cancelled) {
					setWorkerSession(workerRes?.session ?? null);
					setLeaderSession(leaderRes?.session ?? null);
				}
			} catch {
				// Session fetch failure is non-fatal
			}
		};

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
			// Retry once after 1s if the first attempt fails (e.g. daemon just restarted)
			if (res === null && !cancelled && seq === fetchGroupSeq) {
				await new Promise<void>((resolve) => setTimeout(resolve, 1000));
				if (!cancelled && seq === fetchGroupSeq) {
					res = await tryFetch();
				}
			}

			if (res !== null && !cancelled && seq === fetchGroupSeq) {
				setGroup(res.group);
				// Fetch session info for worker and leader
				void fetchSessionInfo(res.group);
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
				const taskRes = await request<{ task: NeoTask }>('task.get', { roomId, taskId });
				if (!cancelled) {
					setTask(taskRes.task);
					await fetchGroup();
				}
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load task');
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		};

		load();

		// Re-fetch group whenever the task status changes (e.g. group spawned or completed)
		const unsub = onEvent<{ roomId: string; task: NeoTask }>('room.task.update', (event) => {
			if (event.task.id === taskId && !cancelled) {
				setTask(event.task);
				void fetchGroup();
			}
		});

		return () => {
			cancelled = true;
			unsub();
			leaveRoom(channel);
		};
	}, [roomId, taskId, isConnected]);

	// Derived permission flags
	const canComplete = task ? task.status === 'in_progress' || task.status === 'review' : false;
	const canCancel = task
		? task.status === 'pending' || task.status === 'in_progress' || task.status === 'review'
		: false;
	const canReactivate = task ? task.status === 'completed' || task.status === 'cancelled' : false;
	const canArchive = task
		? task.status === 'completed' ||
			task.status === 'cancelled' ||
			task.status === 'needs_attention'
		: false;
	const canInterrupt = task ? task.status === 'in_progress' || task.status === 'review' : false;

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
		task,
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
