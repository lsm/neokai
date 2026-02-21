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
 * - recurringJobs: Recurring jobs for the room
 */

import { signal, computed } from '@preact/signals';
import type {
	Room,
	TaskSummary,
	NeoTask,
	SessionSummary,
	RoomOverview,
	RoomGoal,
	GoalPriority,
	RecurringJob,
	CreateRecurringJobParams,
	RoomContextVersion,
	WorkspacePath,
	RoomAgentState,
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
}

/**
 * Event payload for goal events
 */
interface GoalEventPayload {
	roomId: string;
	goal: RoomGoal;
}

/**
 * Event payload for goal deletion
 */
interface GoalDeletedEventPayload {
	roomId: string;
	goalId: string;
}

/**
 * Event payload for recurring job events
 */
interface RecurringJobEventPayload {
	roomId: string;
	job: RecurringJob;
}

/**
 * Event payload for recurring job deletion
 */
interface RecurringJobDeletedEventPayload {
	roomId: string;
	jobId: string;
}

import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';
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

	// ========================================
	// Recurring Jobs Signals
	// ========================================

	/** Recurring jobs for this room */
	readonly recurringJobs = signal<RecurringJob[]>([]);

	/** Jobs loading state */
	readonly jobsLoading = signal<boolean>(false);

	// ========================================
	// Room Agent Signals
	// ========================================

	/** Room agent state (null if agent is not running) */
	readonly agentState = signal<RoomAgentState | null>(null);

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

	/** Session count */
	readonly sessionCount = computed(() => this.sessions.value.length);

	/** Active goals */
	readonly activeGoals = computed(() =>
		this.goals.value.filter((g) => g.status === 'in_progress' || g.status === 'pending')
	);

	/** Enabled recurring jobs */
	readonly enabledRecurringJobs = computed(() => this.recurringJobs.value.filter((j) => j.enabled));

	// ========================================
	// Private State
	// ========================================

	/** Promise-chain lock for atomic room switching */
	private selectPromise: Promise<void> = Promise.resolve();

	/** Subscription cleanup functions */
	private cleanupFunctions: Array<() => void> = [];

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
		this.recurringJobs.value = [];
		this.agentState.value = null;

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

	/**
	 * Start subscriptions for a room
	 */
	private async startSubscriptions(roomId: string): Promise<void> {
		try {
			const hub = await connectionManager.getHub();

			// Join the room channel first
			hub.joinChannel(`room:${roomId}`);

			// 1. Room overview subscription (room + sessions + tasks)
			const unsubRoomOverview = hub.onEvent<RoomOverview>('room.overview', (overview) => {
				if (overview.room.id === roomId) {
					this.room.value = overview.room;
					this.sessions.value = overview.sessions;
					this.tasks.value = overview.activeTasks;
				}
			});
			this.cleanupFunctions.push(unsubRoomOverview);

			// 2. Task updates
			const unsubTaskUpdate = hub.onEvent<{ roomId: string; task: NeoTask }>(
				'room.task.update',
				(event) => {
					if (event.roomId === roomId) {
						const task = event.task;
						const idx = this.tasks.value.findIndex((t) => t.id === task.id);
						if (idx >= 0) {
							this.tasks.value = [
								...this.tasks.value.slice(0, idx),
								task,
								...this.tasks.value.slice(idx + 1),
							];
						} else {
							this.tasks.value = [...this.tasks.value, task];
						}
					}
				}
			);
			this.cleanupFunctions.push(unsubTaskUpdate);

			// 3. Goal events
			const unsubGoalCreated = hub.onEvent<GoalEventPayload>('room.goalCreated', (event) => {
				if (event.roomId === roomId) {
					this.goals.value = [...this.goals.value, event.goal];
				}
			});
			this.cleanupFunctions.push(unsubGoalCreated);

			const unsubGoalUpdated = hub.onEvent<GoalEventPayload>('room.goalUpdated', (event) => {
				if (event.roomId === roomId) {
					const idx = this.goals.value.findIndex((g) => g.id === event.goal.id);
					if (idx >= 0) {
						this.goals.value = [
							...this.goals.value.slice(0, idx),
							event.goal,
							...this.goals.value.slice(idx + 1),
						];
					}
				}
			});
			this.cleanupFunctions.push(unsubGoalUpdated);

			const unsubGoalDeleted = hub.onEvent<GoalDeletedEventPayload>('room.goalDeleted', (event) => {
				if (event.roomId === roomId) {
					this.goals.value = this.goals.value.filter((g) => g.id !== event.goalId);
				}
			});
			this.cleanupFunctions.push(unsubGoalDeleted);

			// 4. Recurring job events
			const unsubJobCreated = hub.onEvent<RecurringJobEventPayload>(
				'recurringJob.created',
				(event) => {
					if (event.roomId === roomId) {
						this.recurringJobs.value = [...this.recurringJobs.value, event.job];
					}
				}
			);
			this.cleanupFunctions.push(unsubJobCreated);

			const unsubJobUpdated = hub.onEvent<RecurringJobEventPayload>(
				'recurringJob.updated',
				(event) => {
					if (event.roomId === roomId) {
						const idx = this.recurringJobs.value.findIndex((j) => j.id === event.job.id);
						if (idx >= 0) {
							this.recurringJobs.value = [
								...this.recurringJobs.value.slice(0, idx),
								event.job,
								...this.recurringJobs.value.slice(idx + 1),
							];
						}
					}
				}
			);
			this.cleanupFunctions.push(unsubJobUpdated);

			const unsubJobDeleted = hub.onEvent<RecurringJobDeletedEventPayload>(
				'recurringJob.deleted',
				(event) => {
					if (event.roomId === roomId) {
						this.recurringJobs.value = this.recurringJobs.value.filter((j) => j.id !== event.jobId);
					}
				}
			);
			this.cleanupFunctions.push(unsubJobDeleted);

			const unsubJobTriggered = hub.onEvent<RecurringJobEventPayload>(
				'recurringJob.triggered',
				(event) => {
					if (event.roomId === roomId) {
						const idx = this.recurringJobs.value.findIndex((j) => j.id === event.job.id);
						if (idx >= 0) {
							this.recurringJobs.value = [
								...this.recurringJobs.value.slice(0, idx),
								event.job,
								...this.recurringJobs.value.slice(idx + 1),
							];
						}
					}
				}
			);
			this.cleanupFunctions.push(unsubJobTriggered);

			// 5. Room agent state changes
			const unsubAgentState = hub.onEvent<{
				roomId: string;
				newState: RoomAgentState['lifecycleState'];
				previousState: RoomAgentState['lifecycleState'];
			}>('roomAgent.stateChanged', (event) => {
				if (event.roomId === roomId) {
					// Refresh full agent state on any state change
					this.fetchAgentState().catch(() => {});
				}
			});
			this.cleanupFunctions.push(unsubAgentState);

			// 6. Fetch initial state via RPC
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
				this.tasks.value = overview.activeTasks;
			} else {
				this.error.value = 'Room not found';
			}

			// Fetch additional data for new features
			await Promise.all([this.fetchGoals(), this.fetchRecurringJobs(), this.fetchAgentState()]);
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

		if (task) {
			this.tasks.value = [...this.tasks.value, task];
		}

		return task;
	}

	// ========================================
	// Goals Methods
	// ========================================

	/**
	 * Fetch goals for the room
	 */
	async fetchGoals(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			return;
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			return;
		}

		try {
			this.goalsLoading.value = true;
			const response = await hub.request<{ goals: RoomGoal[] }>('goal.list', { roomId });
			this.goals.value = response.goals ?? [];
		} catch (err) {
			logger.error('Failed to fetch goals:', err);
		} finally {
			this.goalsLoading.value = false;
		}
	}

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

	// ========================================
	// Recurring Jobs Methods
	// ========================================

	/**
	 * Fetch recurring jobs for the room
	 */
	async fetchRecurringJobs(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			return;
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			return;
		}

		try {
			this.jobsLoading.value = true;
			const response = await hub.request<{ jobs: RecurringJob[] }>('recurringJob.list', {
				roomId,
			});
			this.recurringJobs.value = response.jobs ?? [];
		} catch (err) {
			logger.error('Failed to fetch recurring jobs:', err);
		} finally {
			this.jobsLoading.value = false;
		}
	}

	/**
	 * Create a new recurring job
	 */
	async createRecurringJob(params: CreateRecurringJobParams): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('recurringJob.create', { ...params, roomId });
		} catch (err) {
			logger.error('Failed to create recurring job:', err);
			throw err;
		}
	}

	/**
	 * Update a recurring job
	 */
	async updateRecurringJob(jobId: string, updates: Partial<RecurringJob>): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('recurringJob.update', { roomId, jobId, updates });
		} catch (err) {
			logger.error('Failed to update recurring job:', err);
			throw err;
		}
	}

	/**
	 * Delete a recurring job
	 */
	async deleteRecurringJob(jobId: string): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('recurringJob.delete', { roomId, jobId });
		} catch (err) {
			logger.error('Failed to delete recurring job:', err);
			throw err;
		}
	}

	/**
	 * Manually trigger a recurring job
	 */
	async triggerRecurringJob(jobId: string): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('recurringJob.trigger', { roomId, jobId });
		} catch (err) {
			logger.error('Failed to trigger recurring job:', err);
			throw err;
		}
	}

	// ========================================
	// Context Methods
	// ========================================

	/**
	 * Update room context
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
			await hub.request('room.updateContext', { roomId, background, instructions });
		} catch (err) {
			logger.error('Failed to update context:', err);
			throw err;
		}
	}

	/**
	 * Fetch context version history
	 */
	async fetchContextVersions(): Promise<RoomContextVersion[]> {
		const roomId = this.roomId.value;
		if (!roomId) {
			return [];
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			return [];
		}

		try {
			const response = await hub.request<{ versions: RoomContextVersion[] }>(
				'room.getContextVersions',
				{ roomId }
			);
			return response.versions ?? [];
		} catch (err) {
			logger.error('Failed to fetch context versions:', err);
			return [];
		}
	}

	/**
	 * Rollback context to a specific version
	 */
	async rollbackContext(version: number): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		try {
			await hub.request('room.rollbackContext', { roomId, version });
		} catch (err) {
			logger.error('Failed to rollback context:', err);
			throw err;
		}
	}

	// ========================================
	// Room Agent Methods
	// ========================================

	/**
	 * Fetch the current agent state from the daemon
	 */
	async fetchAgentState(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) return;

		const hub = connectionManager.getHubIfConnected();
		if (!hub) return;

		try {
			const response = await hub.request<{ state: RoomAgentState | null }>('roomAgent.getState', {
				roomId,
			});
			this.agentState.value = response.state ?? null;
		} catch (err) {
			logger.error('Failed to fetch agent state:', err);
		}
	}

	/**
	 * Start the room agent
	 */
	async startAgent(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('roomAgent.start', { roomId });
		await this.fetchAgentState();
	}

	/**
	 * Stop the room agent
	 */
	async stopAgent(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('roomAgent.stop', { roomId });
		await this.fetchAgentState();
	}

	/**
	 * Pause the room agent
	 */
	async pauseAgent(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('roomAgent.pause', { roomId });
		await this.fetchAgentState();
	}

	/**
	 * Resume the room agent
	 */
	async resumeAgent(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) throw new Error('No room selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('roomAgent.resume', { roomId });
		await this.fetchAgentState();
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
