/**
 * useMissionDetailData
 *
 * Encapsulates all data-fetching, action handlers, and derived state for the
 * MissionDetail page. Follows the same pattern as useTaskViewData.
 */

import type { GoalStatus, MissionExecution, NeoTask, RoomGoal } from '@neokai/shared';
import { useComputed } from '@preact/signals';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { useMessageHub } from './useMessageHub';
import { roomStore } from '../lib/room-store';
import { navigateToRoom } from '../lib/router';
import { toast } from '../lib/toast';

/** Status transitions available from a given GoalStatus */
export type AvailableStatusAction = 'complete' | 'reactivate' | 'needs_human' | 'archive';

export interface UseMissionDetailDataResult {
	/** Goal matching by UUID or short ID, null if not found or not yet loaded */
	goal: RoomGoal | null;
	/** Tasks linked to this goal, derived reactively */
	linkedTasks: NeoTask[];
	/** Execution history — loaded on mount for recurring missions */
	executions: MissionExecution[] | null;
	/** Loading states */
	isLoadingExecutions: boolean;
	isUpdating: boolean;
	isTriggering: boolean;
	isDeleting: boolean;
	/** Status actions available from current goal status */
	availableStatusActions: AvailableStatusAction[];
	/** Action handlers */
	updateGoal: (updates: Partial<RoomGoal>) => Promise<void>;
	deleteGoal: () => Promise<void>;
	triggerNow: () => Promise<void>;
	scheduleNext: (nextRunAt: number) => Promise<void>;
	linkTask: (taskId: string) => Promise<void>;
	changeStatus: (action: AvailableStatusAction) => Promise<void>;
}

export function useMissionDetailData(roomId: string, goalId: string): UseMissionDetailDataResult {
	const { request } = useMessageHub();

	// Derive goal reactively from roomStore — matches by UUID or short ID so
	// deep links like /rooms/:roomId/missions/g-abc123 resolve correctly.
	const goal = useComputed(
		() => roomStore.goals.value.find((g) => g.id === goalId || g.shortId === goalId) ?? null
	);

	// Derive linked tasks reactively from roomStore.
	const linkedTasks = useComputed<NeoTask[]>(() => {
		const g = goal.value;
		if (!g || g.linkedTaskIds.length === 0) return [];
		const taskMap = new Map(roomStore.tasks.value.map((t) => [t.id, t]));
		return g.linkedTaskIds.map((id) => taskMap.get(id)).filter((t): t is NeoTask => t != null);
	});

	const [executions, setExecutions] = useState<MissionExecution[] | null>(null);
	const [isLoadingExecutions, setIsLoadingExecutions] = useState(false);
	const [isUpdating, setIsUpdating] = useState(false);
	const [isTriggering, setIsTriggering] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	// Load execution history for recurring missions. We depend on both goalId
	// (URL change) and goal.value?.missionType so the effect re-runs when:
	//   1. The goal arrives asynchronously after mount (null → RoomGoal).
	//   2. The goal's missionType changes to/from 'recurring'.
	const goalMissionType = goal.value?.missionType;
	const resolvedGoalId = goal.value?.id;
	useEffect(() => {
		const g = goal.value;
		if (!g || g.missionType !== 'recurring') return;

		let cancelled = false;
		setIsLoadingExecutions(true);

		roomStore
			.listExecutions(g.id)
			.then((execs) => {
				if (!cancelled) setExecutions(execs);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					toast.error(err instanceof Error ? err.message : 'Failed to load executions');
				}
			})
			.finally(() => {
				if (!cancelled) setIsLoadingExecutions(false);
			});

		return () => {
			cancelled = true;
		};
		// goalId covers URL changes; resolvedGoalId+goalMissionType cover async goal arrival
		// and missionType changes (e.g. goal arriving from null → recurring).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [goalId, resolvedGoalId, goalMissionType]);

	// Derived available status actions based on current goal status.
	const availableStatusActions = useComputed<AvailableStatusAction[]>(() => {
		const g = goal.value;
		if (!g) return [];
		const actions: AvailableStatusAction[] = [];
		const s = g.status as GoalStatus;
		if (s === 'active') {
			actions.push('complete', 'needs_human');
		} else if (s === 'needs_human') {
			actions.push('reactivate', 'complete');
		} else if (s === 'completed' || s === 'archived') {
			actions.push('reactivate');
		}
		// 'archive' is available for any non-archived status
		if (s !== 'archived') {
			actions.push('archive');
		}
		return actions;
	});

	const updateGoal = useCallback(
		async (updates: Partial<RoomGoal>) => {
			if (isUpdating) return;
			setIsUpdating(true);
			try {
				const g = goal.value;
				if (!g) throw new Error('Goal not found');
				await roomStore.updateGoal(g.id, updates);
				toast.success('Mission updated');
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to update mission');
				throw err;
			} finally {
				setIsUpdating(false);
			}
		},
		[isUpdating, goal]
	);

	const deleteGoal = useCallback(async () => {
		if (isDeleting) return;
		const g = goal.value;
		if (!g) return;
		setIsDeleting(true);
		try {
			await roomStore.deleteGoal(g.id);
			toast.info('Mission deleted');
			// Navigate back to the room view; the missions list is the default room tab.
			navigateToRoom(roomId);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to delete mission');
			throw err;
		} finally {
			setIsDeleting(false);
		}
	}, [isDeleting, goal, roomId]);

	const triggerNow = useCallback(async () => {
		if (isTriggering) return;
		const g = goal.value;
		if (!g) return;
		setIsTriggering(true);
		try {
			await roomStore.triggerNow(g.id);
			toast.success('Mission triggered');
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to trigger mission');
			throw err;
		} finally {
			setIsTriggering(false);
		}
	}, [isTriggering, goal]);

	const scheduleNext = useCallback(
		async (nextRunAt: number) => {
			const g = goal.value;
			if (!g) return;
			try {
				await roomStore.scheduleNext(g.id, nextRunAt);
				toast.success('Mission scheduled');
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to schedule mission');
				throw err;
			}
		},
		[goal]
	);

	const linkTask = useCallback(
		async (taskId: string) => {
			const g = goal.value;
			if (!g) return;
			try {
				await roomStore.linkTaskToGoal(g.id, taskId);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to link task');
				throw err;
			}
		},
		[goal]
	);

	const changeStatus = useCallback(
		async (action: AvailableStatusAction) => {
			const g = goal.value;
			if (!g) return;
			try {
				// reactivate and needs_human use dedicated RPC handlers because they carry
				// server-side side effects (e.g. resetting consecutiveFailures, pausing schedules).
				// complete and archive have no dedicated handlers so they go through updateGoal.
				if (action === 'reactivate') {
					await request('goal.reactivate', { roomId, goalId: g.id });
					toast.success('Mission reactivated');
				} else if (action === 'needs_human') {
					await request('goal.needsHuman', { roomId, goalId: g.id });
					toast.info('Mission marked as needs human input');
				} else if (action === 'complete') {
					await roomStore.updateGoal(g.id, { status: 'completed' });
					toast.success('Mission completed');
				} else if (action === 'archive') {
					await roomStore.updateGoal(g.id, { status: 'archived' });
					toast.info('Mission archived');
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to change mission status');
				throw err;
			}
		},
		[goal, request, roomId]
	);

	return {
		goal: goal.value,
		linkedTasks: linkedTasks.value,
		executions,
		isLoadingExecutions,
		isUpdating,
		isTriggering,
		isDeleting,
		availableStatusActions: availableStatusActions.value,
		updateGoal,
		deleteGoal,
		triggerNow,
		scheduleNext,
		linkTask,
		changeStatus,
	};
}
