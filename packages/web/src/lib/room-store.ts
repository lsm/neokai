/**
 * RoomStore - Room state management with WebSocket subscriptions
 *
 * ARCHITECTURE: Pure WebSocket (no REST API)
 * - Initial state: Fetched via RPC over WebSocket on room select
 * - Updates: Real-time via state channel subscriptions
 * - Single subscription source for room data
 * - Promise-chain lock for atomic room switching
 *
 * Signals (reactive state):
 * - roomId: Current room ID
 * - room: Room metadata
 * - tasks: Task list for the room
 * - sessions: Session summaries for the room
 * - goals: Room goals
 */

import { signal, computed } from '@preact/signals';
import type {
	Room,
	TaskSummary,
	NeoTask,
	TaskStatus,
	SessionSummary,
	RoomOverview,
	RoomGoal,
	GoalPriority,
	WorkspacePath,
	RuntimeState,
	MissionType,
	AutonomyLevel,
	MissionMetric,
	CronSchedule,
	MissionExecution,
	LiveQuerySnapshotEvent,
	LiveQueryDeltaEvent,
} from '@neokai/shared';

/**
 * Parameters for creating a new goal
 * Defined locally since not exported from shared package
 */
interface CreateGoalParams {
	title: string;
	description: string;
	priority?: GoalPriority;
	metrics?: Record<string, number>;
	missionType?: MissionType;
	autonomyLevel?: AutonomyLevel;
	structuredMetrics?: MissionMetric[];
	schedule?: CronSchedule;
	schedulePaused?: boolean;
}

import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';
import { navigateToRoom } from './router';
import { currentRoomSessionIdSignal } from './signals';
import { toast } from './toast';

const logger = new Logger('kai:web:roomstore');

class RoomStore {
	// ========================================
	// Core Signals
	// ========================================

	/** Current active room ID */
	readonly roomId = signal<string | null>(null);

	/** Room metadata */
	readonly room = signal<Room | null>(null);

	/** Tasks for this room */
	readonly tasks = signal<TaskSummary[]>([]);

	/** Sessions in this room */
	readonly sessions = signal<SessionSummary[]>([]);

	/** Loading state */
	readonly loading = signal<boolean>(false);

	/** Error state */
	readonly error = signal<string | null>(null);

	// ========================================
	// Goals Signals
	// ========================================

	/** Goals for this room */
	readonly goals = signal<RoomGoal[]>([]);

	/** Goals loading state */
	readonly goalsLoading = signal<boolean>(false);

	/** Auto-completed task notifications (from semi-autonomous mode) */
	readonly autoCompletedNotifications = signal<
		{
			taskId: string;
			taskTitle: string;
			goalId: string;
			prUrl: string;
			timestamp: number;
		}[]
	>([]);

	// ========================================
	// Runtime State Signal
	// ========================================

	/** Runtime state for this room (running/paused/stopped) */
	readonly runtimeState = signal<RuntimeState | null>(null);

	/** Resolved leader/worker models for this room */
	readonly runtimeModels = signal<{ leaderModel: string | null; workerModel: string | null }>({
		leaderModel: null,
		workerModel: null,
	});

	// ========================================
	// Computed Accessors
	// ========================================

	/** Total task count */
	readonly taskCount = computed(() => this.tasks.value.length);

	/** Pending tasks */
	readonly pendingTasks = computed(() => this.tasks.value.filter((t) => t.status === 'pending'));

	/** In-progress tasks */
	readonly activeTasks = computed(() => this.tasks.value.filter((t) => t.status === 'in_progress'));

	/** Completed tasks */
	readonly completedTasks = computed(() =>
		this.tasks.value.filter((t) => t.status === 'completed')
	);

	/** Archived tasks */
	readonly archivedTasks = computed(() => this.tasks.value.filter((t) => t.status === 'archived'));

	/** Tasks in review status */
	readonly reviewTasks = computed(() => this.tasks.value.filter((t) => t.status === 'review'));

	/** Count of tasks awaiting review */
	readonly reviewTaskCount = computed(() => this.reviewTasks.value.length);

	/** Session count */
	readonly sessionCount = computed(() => this.sessions.value.length);

	/** Active goals */
	readonly activeGoals = computed(() => this.goals.value.filter((g) => g.status === 'active'));

	/** Tasks grouped by goal ID (Map<goalId, TaskSummary[]>) */
	readonly tasksByGoalId = computed(() => {
		const goals = this.goals.value;
		const tasks = this.tasks.value;
		const taskMap = new Map<string, TaskSummary>();
		for (const t of tasks) {
			taskMap.set(t.id, t);
		}
		const result = new Map<string, TaskSummary[]>();
		for (const goal of goals) {
			const linked: TaskSummary[] = [];
			for (const taskId of goal.linkedTaskIds) {
				const task = taskMap.get(taskId);
				if (task) linked.push(task);
			}
			result.set(goal.id, linked);
		}
		return result;
	});

	/** Reverse lookup: taskId → RoomGoal (the goal that owns this task) */
	readonly goalByTaskId = computed(() => {
		const result = new Map<string, RoomGoal>();
		for (const goal of this.goals.value) {
			for (const taskId of goal.linkedTaskIds) {
				result.set(taskId, goal);
			}
		}
		return result;
	});

	/** Tasks not linked to any goal */
	readonly orphanTasks = computed(() => {
		const linkedIds = new Set<string>();
		for (const goal of this.goals.value) {
			for (const taskId of goal.linkedTaskIds) {
				linkedIds.add(taskId);
			}
		}
		return this.tasks.value.filter((t) => !linkedIds.has(t.id));
	});

	/** Orphan tasks that are active (draft, pending, or in_progress) */
	readonly orphanTasksActive = computed(() =>
		this.orphanTasks.value.filter(
			(t) => t.status === 'draft' || t.status === 'pending' || t.status === 'in_progress'
		)
	);

	/** Orphan tasks in review (review or needs_attention) */
	readonly orphanTasksReview = computed(() =>
		this.orphanTasks.value.filter((t) => t.status === 'review' || t.status === 'needs_attention')
	);

	/** Orphan tasks that are done (completed or cancelled) */
	readonly orphanTasksDone = computed(() =>
		this.orphanTasks.value.filter((t) => t.status === 'completed' || t.status === 'cancelled')
	);

	/** Orphan tasks that are archived */
	readonly orphanTasksArchived = computed(() =>
		this.orphanTasks.value.filter((t) => t.status === 'archived')
	);

	// ========================================
	// Private State
	// ========================================

	/** Promise-chain lock for atomic room switching */
	private selectPromise: Promise<void> = Promise.resolve();

	/** Subscription cleanup functions */
	private cleanupFunctions: Array<() => void> = [];

	/** Per-room LiveQuery cleanup functions — owned by subscribeRoom/unsubscribeRoom */
	private liveQueryCleanups = new Map<string, Array<() => void>>();

	/** Set of room IDs that currently have an active LiveQuery subscription intent */
	private liveQueryActive = new Set<string>();

	/**
	 * Stale-event guard: set of currently active subscriptionIds.
	 * Cleared immediately in unsubscribeRoom before handler teardown so that
	 * any in-flight events (queued in the JS event loop between room switch and
	 * handler removal) are discarded rather than applied to the wrong room's state.
	 */
	private activeSubscriptionIds = new Set<string>();

	// ========================================
	// Room Selection (with Promise-Chain Lock)
	// ========================================

	/**
	 * Select a room with atomic subscription management
	 *
	 * Uses promise-chain locking to prevent race conditions:
	 * - Each select() waits for previous select() to complete
	 * - Unsubscribe -> Update state -> Subscribe happens atomically
	 */
	select(roomId: string | null): Promise<void> {
		// Chain the new selection onto the previous one
		this.selectPromise = this.selectPromise.then(() => this.doSelect(roomId));
		return this.selectPromise;
	}

	/**
	 * Internal selection logic (called within promise chain)
	 */
	private async doSelect(roomId: string | null): Promise<void> {
		// Skip if already on this room
		if (this.roomId.value === roomId) {
			return;
		}

		const oldRoomId = this.roomId.value;

		// 1. Stop current subscriptions and leave old room
		await this.stopSubscriptions();
		if (oldRoomId) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub.leaveChannel(`room:${oldRoomId}`);
			}
		}

		// 2. Clear state
		this.room.value = null;
		this.tasks.value = [];
		this.sessions.value = [];
		this.error.value = null;
		this.goals.value = [];
		this.goalsLoading.value = false;
		this.autoCompletedNotifications.value = [];
		this.runtimeState.value = null;

		// 3. Update active room
		this.roomId.value = roomId;

		// 4. Start new subscriptions if room selected
		if (roomId) {
			this.loading.value = true;
			try {
				await this.startSubscriptions(roomId);
			} catch (err) {
				logger.error('Failed to start room subscriptions:', err);
				this.error.value = err instanceof Error ? err.message : 'Failed to load room';
			} finally {
				this.loading.value = false;
			}
		}
	}

	// ========================================
	// Subscription Management
	// ========================================

	// ========================================
	// LiveQuery Subscription Lifecycle (managed by useRoomLiveQuery hook)
	// ========================================

	/**
	 * Subscribe this room's tasks and goals via LiveQuery.
	 *
	 * Called by the `useRoomLiveQuery` hook on mount / room change.
	 * Registers snapshot/delta handlers then sends liveQuery.subscribe for
	 * both tasks.byRoom and goals.byRoom named queries.
	 *
	 * Guards against races: if `unsubscribeRoom(roomId)` is called before
	 * the async hub is available, the subscription is aborted cleanly.
	 */
	async subscribeRoom(roomId: string): Promise<void> {
		// Guard: prevent double-subscription for the same roomId
		if (this.liveQueryActive.has(roomId)) return;
		this.liveQueryActive.add(roomId);

		try {
			const hub = await connectionManager.getHub();

			// Guard: unsubscribeRoom was called before hub became available
			if (!this.liveQueryActive.has(roomId)) return;

			const cleanups: Array<() => void> = [];
			this.liveQueryCleanups.set(roomId, cleanups);

			// --- Tasks via LiveQuery ---
			const tasksSubId = `tasks-byRoom-${roomId}`;

			// Stale-event guard: mark this subscriptionId as active before registering
			// handlers. unsubscribeRoom clears it immediately so any event queued in the
			// JS event loop after the room switch is discarded.
			this.activeSubscriptionIds.add(tasksSubId);
			cleanups.push(() => this.activeSubscriptionIds.delete(tasksSubId));

			const unsubTaskSnapshot = hub.onEvent<LiveQuerySnapshotEvent>(
				'liveQuery.snapshot',
				(event) => {
					if (event.subscriptionId !== tasksSubId) return;
					if (!this.activeSubscriptionIds.has(tasksSubId)) return; // stale-event guard
					this.tasks.value = event.rows as TaskSummary[];
				}
			);
			cleanups.push(unsubTaskSnapshot);

			const unsubTaskDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
				if (event.subscriptionId !== tasksSubId) return;
				if (!this.activeSubscriptionIds.has(tasksSubId)) return; // stale-event guard
				let current = this.tasks.value;
				if (event.removed?.length) {
					const removedIds = new Set((event.removed as TaskSummary[]).map((r) => r.id));
					current = current.filter((t) => !removedIds.has(t.id));
				}
				if (event.updated?.length) {
					const updatedTasks = event.updated as TaskSummary[];
					// Show toast when a known task transitions into review status.
					// Skip when prevTask is absent to avoid spurious toasts during hydration.
					for (const updatedTask of updatedTasks) {
						if (updatedTask.status === 'review') {
							const prevTask = current.find((t) => t.id === updatedTask.id);
							if (prevTask && prevTask.status !== 'review') {
								toast.info(`Task ready for review: ${updatedTask.title}`);
							}
						}
					}
					const updatedMap = new Map(updatedTasks.map((u) => [u.id, u]));
					current = current.map((t) => updatedMap.get(t.id) ?? t);
				}
				if (event.added?.length) {
					current = [...current, ...(event.added as TaskSummary[])];
				}
				this.tasks.value = current;
			});
			cleanups.push(unsubTaskDelta);

			await hub.request('liveQuery.subscribe', {
				queryName: 'tasks.byRoom',
				params: [roomId],
				subscriptionId: tasksSubId,
			});

			// Guard: abort if unsubscribed while awaiting the subscribe request
			if (!this.liveQueryActive.has(roomId)) {
				for (const fn of cleanups) {
					try {
						fn();
					} catch {
						/* ignore */
					}
				}
				this.liveQueryCleanups.delete(roomId);
				return;
			}

			// Re-subscribe on reconnect: the server-side subscription is per-connection.
			const unsubTaskReconnect = hub.onConnection((state) => {
				if (state !== 'connected' || !this.liveQueryActive.has(roomId)) return;
				hub
					.request('liveQuery.subscribe', {
						queryName: 'tasks.byRoom',
						params: [roomId],
						subscriptionId: tasksSubId,
					})
					.catch((err) => {
						logger.warn('Tasks LiveQuery re-subscribe failed:', err);
					});
			});
			cleanups.push(unsubTaskReconnect);

			// Cleanup: tell the server to dispose the subscription when leaving the room.
			cleanups.push(() => {
				const h = connectionManager.getHubIfConnected();
				if (h) {
					h.request('liveQuery.unsubscribe', { subscriptionId: tasksSubId }).catch(() => {});
				}
			});

			// --- Goals via LiveQuery ---
			// Register snapshot/delta handlers BEFORE subscribing so we never miss the
			// initial snapshot that the server pushes synchronously before replying.
			const goalsSubId = `goals-byRoom-${roomId}`;

			// Stale-event guard for goals (same semantics as tasks above).
			this.activeSubscriptionIds.add(goalsSubId);
			cleanups.push(() => this.activeSubscriptionIds.delete(goalsSubId));

			const unsubGoalSnapshot = hub.onEvent<LiveQuerySnapshotEvent>(
				'liveQuery.snapshot',
				(event) => {
					if (event.subscriptionId !== goalsSubId) return;
					if (!this.activeSubscriptionIds.has(goalsSubId)) return; // stale-event guard
					this.goals.value = event.rows as RoomGoal[];
					this.goalsLoading.value = false;
				}
			);
			cleanups.push(unsubGoalSnapshot);

			const unsubGoalDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
				if (event.subscriptionId !== goalsSubId) return;
				if (!this.activeSubscriptionIds.has(goalsSubId)) return; // stale-event guard
				let current = this.goals.value;
				if (event.removed?.length) {
					const removedIds = new Set((event.removed as RoomGoal[]).map((r) => r.id));
					current = current.filter((g) => !removedIds.has(g.id));
				}
				if (event.updated?.length) {
					const updatedMap = new Map((event.updated as RoomGoal[]).map((u) => [u.id, u]));
					current = current.map((g) => updatedMap.get(g.id) ?? g);
				}
				if (event.added?.length) {
					current = [...current, ...(event.added as RoomGoal[])];
				}
				this.goals.value = current;
			});
			cleanups.push(unsubGoalDelta);

			// Subscribe to the goals.byRoom named query.
			// Mark loading before subscribing; the snapshot handler clears it.
			this.goalsLoading.value = true;
			await hub.request('liveQuery.subscribe', {
				queryName: 'goals.byRoom',
				params: [roomId],
				subscriptionId: goalsSubId,
			});

			// Guard: abort if unsubscribed while awaiting the subscribe request
			if (!this.liveQueryActive.has(roomId)) {
				for (const fn of cleanups) {
					try {
						fn();
					} catch {
						/* ignore */
					}
				}
				this.liveQueryCleanups.delete(roomId);
				// Reset goalsLoading: it was set to true above but the snapshot
				// handler (which normally clears it) will never fire.
				this.goalsLoading.value = false;
				return;
			}

			// Re-subscribe on reconnect: the server-side subscription is per-connection
			// and is gone after a disconnect. Requesting liveQuery.subscribe again with
			// the same subscriptionId delivers a fresh snapshot to the already-registered
			// snapshot handler above.
			const unsubGoalReconnect = hub.onConnection((state) => {
				if (state !== 'connected' || !this.liveQueryActive.has(roomId)) return;
				this.goalsLoading.value = true;
				hub
					.request('liveQuery.subscribe', {
						queryName: 'goals.byRoom',
						params: [roomId],
						subscriptionId: goalsSubId,
					})
					.catch((err) => {
						logger.warn('Goals LiveQuery re-subscribe failed:', err);
						this.goalsLoading.value = false;
					});
			});
			cleanups.push(unsubGoalReconnect);

			// Cleanup: tell the server to dispose the subscription when leaving the room.
			cleanups.push(() => {
				const h = connectionManager.getHubIfConnected();
				if (h) {
					h.request('liveQuery.unsubscribe', { subscriptionId: goalsSubId }).catch(() => {});
				}
			});
		} catch (err) {
			this.liveQueryActive.delete(roomId);
			// Run any cleanups that were registered before the error, so that
			// event handlers registered up to the point of failure are removed
			// and activeSubscriptionIds entries are cleared.
			const failedCleanups = this.liveQueryCleanups.get(roomId);
			if (failedCleanups) {
				for (const fn of failedCleanups) {
					try {
						fn();
					} catch {
						/* ignore */
					}
				}
			}
			this.liveQueryCleanups.delete(roomId);
			// Reset goalsLoading in case the error occurred after it was set to true.
			this.goalsLoading.value = false;
			logger.error('Failed to subscribe room LiveQuery:', err);
		}
	}

	/**
	 * Unsubscribe LiveQuery subscriptions for a room.
	 *
	 * Called by the `useRoomLiveQuery` hook on unmount / room change.
	 * Idempotent: safe to call even if subscribeRoom was never called.
	 */
	unsubscribeRoom(roomId: string): void {
		this.liveQueryActive.delete(roomId);
		// Stale-event guard: clear subscriptionIds immediately so any events already
		// queued in the JS event loop are discarded before the handlers are removed.
		this.activeSubscriptionIds.delete(`tasks-byRoom-${roomId}`);
		this.activeSubscriptionIds.delete(`goals-byRoom-${roomId}`);
		const cleanups = this.liveQueryCleanups.get(roomId);
		if (cleanups) {
			for (const fn of cleanups) {
				try {
					fn();
				} catch {
					/* ignore */
				}
			}
			this.liveQueryCleanups.delete(roomId);
		}
	}

	// ========================================
	// Channel + Event Subscriptions
	// ========================================

	/**
	 * Start subscriptions for a room
	 */
	private async startSubscriptions(roomId: string): Promise<void> {
		try {
			const hub = await connectionManager.getHub();

			// Join the room channel first
			hub.joinChannel(`room:${roomId}`);

			// 1. Room overview subscription (room + sessions only — tasks/goals come from LiveQuery)
			const unsubRoomOverview = hub.onEvent<RoomOverview>('room.overview', (overview) => {
				if (overview.room.id === roomId) {
					this.room.value = overview.room;
					this.sessions.value = overview.sessions;
				}
			});
			this.cleanupFunctions.push(unsubRoomOverview);

			// 2. Auto-completed task notifications (semi-autonomous mode)
			const unsubAutoCompleted = hub.onEvent<{
				roomId: string;
				goalId: string;
				taskId: string;
				taskTitle: string;
				prUrl: string;
				approvalSource: string;
			}>('goal.task.auto_completed', (event) => {
				if (event.roomId === roomId) {
					this.autoCompletedNotifications.value = [
						...this.autoCompletedNotifications.value,
						{
							taskId: event.taskId,
							taskTitle: event.taskTitle,
							goalId: event.goalId,
							prUrl: event.prUrl,
							timestamp: Date.now(),
						},
					];
				}
			});
			this.cleanupFunctions.push(unsubAutoCompleted);

			// 3. Runtime state changes
			const unsubRuntimeState = hub.onEvent<{ roomId: string; state: RuntimeState }>(
				'room.runtime.stateChanged',
				(event) => {
					if (event.roomId === roomId) {
						this.runtimeState.value = event.state;
					}
				}
			);
			this.cleanupFunctions.push(unsubRuntimeState);

			// 4. Session lifecycle events (delete / status change)
			// Re-fetch the authoritative session list from the server on meaningful session
			// changes. This avoids manual array splicing and self-heals events missed during
			// WebSocket reconnect gaps.
			const unsubSessionDeleted = hub.onEvent<{ sessionId: string; roomId?: string }>(
				'session.deleted',
				(event) => {
					if (event.roomId !== roomId) return;
					this.refresh()
						.then(() => {
							// If the user is currently viewing the deleted session, navigate
							// back to the room dashboard so they don't land on a dead view.
							const activeSessionId = currentRoomSessionIdSignal.value;
							if (activeSessionId && !this.sessions.value.some((s) => s.id === activeSessionId)) {
								navigateToRoom(roomId);
							}
						})
						.catch((err) => {
							logger.error('Failed to refresh after session.deleted:', err);
						});
				}
			);
			this.cleanupFunctions.push(unsubSessionDeleted);

			// session.updated: only refresh when a status field is present.
			// Draft saves (useInputDraft, ~250 ms debounce) only carry title/inputDraft —
			// no status — so this guard keeps RPC calls at zero during typing.
			const unsubSessionUpdated = hub.onEvent<{
				sessionId: string;
				roomId?: string;
				status?: string;
			}>('session.updated', (event) => {
				if (event.roomId !== roomId) return;
				if (event.status === undefined) return;
				this.refresh().catch((err) => {
					logger.error('Failed to refresh after session.updated:', err);
				});
			});
			this.cleanupFunctions.push(unsubSessionUpdated);

			// 5. Fetch initial state via RPC
			await this.fetchInitialState(hub, roomId);
		} catch (err) {
			logger.error('Failed to start room subscriptions:', err);
			toast.error('Failed to connect to room');
			throw err;
		}
	}

	/**
	 * Fetch initial state via RPC calls (pure WebSocket)
	 */
	private async fetchInitialState(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		roomId: string
	): Promise<void> {
		try {
			const overview = await hub.request<RoomOverview>('room.get', { roomId });

			if (overview) {
				this.room.value = overview.room;
				this.sessions.value = overview.sessions;
			} else {
				this.error.value = 'Room not found';
			}

			// Tasks and goals are delivered via LiveQuery snapshot pushed
			// synchronously during liveQuery.subscribe in startSubscriptions.

			// Fetch runtime state
			try {
				const { state } = await hub.request<{ state: RuntimeState }>('room.runtime.state', {
					roomId,
				});
				this.runtimeState.value = state;
			} catch {
				// Runtime may not exist yet
			}

			// Fetch runtime models (leader/worker)
			await this.fetchRuntimeModels();
		} catch (err) {
			logger.error('Failed to fetch room state:', err);
			this.error.value = err instanceof Error ? err.message : 'Failed to load room';
		}
	}

	/**
	 * Stop all current subscriptions
	 */
	private async stopSubscriptions(): Promise<void> {
		// Call all cleanup functions
		for (const cleanup of this.cleanupFunctions) {
			try {
				cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.cleanupFunctions = [];
	}

	// ========================================
	// Refresh (for reconnection)
	// ========================================

	/**
	 * Refresh current room state from server
	 */
	async refresh(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			return;
		}

		try {
			const hub = await connectionManager.getHub();
			await this.fetchInitialState(hub, roomId);
		} catch (err) {
			logger.error('Failed to refresh room state:', err);
		}
	}

	// ========================================
	// Task Methods
	// ========================================

	/**
	 * Create a new task in the room
	 */
	async createTask(title: string, description: string): Promise<NeoTask> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		const { task } = await hub.request<{ task: NeoTask }>('task.create', {
			roomId,
			title,
			description,
		});

		// Task appears in tasks.value via the tasks.byRoom LiveQuery delta.
		return task;
	}

	/**
	 * Approve a task in review status (human approval).
	 * Routes through the runtime so planning tasks trigger phase 2 (merge PR + create tasks).
	 */
	async approveTask(taskId: string): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		await hub.request<{ success: boolean }>('task.approve', {
			roomId,
			taskId,
		});

		// Task state updates arrive via the tasks.byRoom LiveQuery delta.
	}

	/**
	 * Set task status directly (e.g., reactivate completed/cancelled to in_progress).
	 */
	async setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		await hub.request<{ success: boolean }>('task.setStatus', {
			roomId,
			taskId,
			status,
		});

		// Task state updates arrive via the tasks.byRoom LiveQuery delta.
	}

	/**
	 * Reject a task in review status with feedback.
	 */
	async rejectTask(taskId: string, feedback: string): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		await hub.request<{ success: boolean }>('task.reject', {
			roomId,
			taskId,
			feedback,
		});

		// Task state updates arrive via the tasks.byRoom LiveQuery delta.
	}

	// ========================================
	// Session Methods
	// ========================================

	/**
	 * Create a new session in the room
	 */
	async createSession(title?: string): Promise<string> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const room = this.room.value;
		if (!room) {
			throw new Error('Room not loaded');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
			roomId,
			title,
			workspacePath: room.defaultPath ?? room.allowedPaths[0]?.path,
		});

		return sessionId;
	}

	// ========================================
	// Goals Methods
	// ========================================

	/**
	 * Create a new goal
	 */
	async createGoal(goal: CreateGoalParams): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('goal.create', { ...goal, roomId });
		} catch (err) {
			logger.error('Failed to create goal:', err);
			throw err;
		}

		// goals.value is updated automatically by the goals.byRoom LiveQuery delta.
	}

	/**
	 * Update a goal
	 */
	async updateGoal(goalId: string, updates: Partial<RoomGoal>): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('goal.update', { roomId, goalId, updates });
			// goals.value is updated automatically by the goals.byRoom LiveQuery delta.
		} catch (err) {
			logger.error('Failed to update goal:', err);
			throw err;
		}
	}

	/**
	 * Delete a goal
	 */
	async deleteGoal(goalId: string): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('goal.delete', { roomId, goalId });
			// goals.value is updated automatically by the goals.byRoom LiveQuery delta.
		} catch (err) {
			logger.error('Failed to delete goal:', err);
			throw err;
		}
	}

	/**
	 * Link a task to a goal
	 */
	async linkTaskToGoal(goalId: string, taskId: string): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('goal.linkTask', { roomId, goalId, taskId });
		} catch (err) {
			logger.error('Failed to link task to goal:', err);
			throw err;
		}
	}

	/**
	 * List execution history for a recurring mission.
	 */
	async listExecutions(goalId: string, limit = 20): Promise<MissionExecution[]> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');
		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');
		const result = await hub.request<{ executions: MissionExecution[] }>('goal.listExecutions', {
			roomId,
			goalId,
			limit,
		});
		return result.executions;
	}

	/**
	 * Dismiss an auto-completed task notification
	 */
	dismissAutoCompleted(taskId: string): void {
		this.autoCompletedNotifications.value = this.autoCompletedNotifications.value.filter(
			(n) => n.taskId !== taskId
		);
	}

	// ========================================
	// Runtime Control Methods
	// ========================================

	async pauseRuntime(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');
		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');
		await hub.request('room.runtime.pause', { roomId });
	}

	async resumeRuntime(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');
		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');
		await hub.request('room.runtime.resume', { roomId });
	}

	async stopRuntime(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');
		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');
		await hub.request('room.runtime.stop', { roomId });
	}

	async startRuntime(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');
		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');
		await hub.request('room.runtime.start', { roomId });
	}

	/**
	 * Fetch the resolved leader/worker models for the current room
	 */
	async fetchRuntimeModels(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) return;
		const hub = connectionManager.getHubIfConnected();
		if (!hub) return;

		try {
			const models = await hub.request<{ leaderModel: string | null; workerModel: string | null }>(
				'room.runtime.models',
				{ roomId }
			);
			this.runtimeModels.value = models;
		} catch {
			// Runtime may not exist yet, models will remain null
		}
	}

	// ========================================
	// Context Methods
	// ========================================

	/**
	 * Update room context (background + instructions)
	 */
	async updateContext(background?: string, instructions?: string): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('room.update', { roomId, background, instructions });
			// Fetch updated room data to ensure UI is up to date
			const overview = await hub.request<RoomOverview>('room.get', { roomId });
			if (overview) {
				this.room.value = overview.room;
			}
		} catch (err) {
			logger.error('Failed to update context:', err);
			throw err;
		}
	}

	/**
	 * Update room config (reviewers, maxReviewRounds, etc.)
	 */
	async updateConfig(config: Record<string, unknown>): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('room.update', { roomId, config });
			const overview = await hub.request<RoomOverview>('room.get', { roomId });
			if (overview) {
				this.room.value = overview.room;
			}
		} catch (err) {
			logger.error('Failed to update config:', err);
			throw err;
		}
	}

	// ========================================
	// Room Management Methods
	// ========================================

	/**
	 * Update room settings (name, allowedPaths, defaultPath, defaultModel)
	 */
	async updateSettings(params: {
		name?: string;
		allowedPaths?: WorkspacePath[];
		defaultPath?: string;
		defaultModel?: string;
		allowedModels?: string[];
		config?: Record<string, unknown>;
	}): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('room.update', { roomId, ...params });
			// Fetch updated room data to ensure UI is up to date
			const overview = await hub.request<RoomOverview>('room.get', { roomId });
			if (overview) {
				this.room.value = overview.room;
			}
		} catch (err) {
			logger.error('Failed to update room settings:', err);
			throw err;
		}
	}

	/**
	 * Archive the current room (soft delete, data preserved)
	 */
	async archiveRoom(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('room.archive', { roomId });
			// Clear the current room selection
			this.roomId.value = null;
			this.room.value = null;
		} catch (err) {
			logger.error('Failed to archive room:', err);
			throw err;
		}
	}

	/**
	 * Permanently delete the current room and all associated data
	 */
	async deleteRoom(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('room.delete', { roomId });
			// Clear the current room selection
			this.roomId.value = null;
			this.room.value = null;
		} catch (err) {
			logger.error('Failed to delete room:', err);
			throw err;
		}
	}
}

/** Singleton room store instance */
export const roomStore = new RoomStore();
