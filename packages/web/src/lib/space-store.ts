/**
 * SpaceStore - Space state management with WebSocket subscriptions
 *
 * ARCHITECTURE: Pure WebSocket (no REST API)
 * - Initial state: Fetched via RPC over WebSocket on space select
 * - Updates: Real-time via event subscriptions
 * - Single subscription source for space data
 * - Promise-chain lock for atomic space switching
 *
 * Signals (reactive state):
 * - spaceId: Current space ID
 * - space: Space metadata
 * - tasks: SpaceTask list for the space
 * - workflowRuns: SpaceWorkflowRun list for the space
 * - agents: SpaceAgent list for the space
 * - workflows: SpaceWorkflow list for the space
 * - runtimeState: Runtime state (running/paused/stopped)
 * - loading: Loading state
 * - error: Error state
 */

import { signal, computed } from '@preact/signals';
import type {
	Space,
	SpaceTask,
	SpaceWorkflowRun,
	SpaceAgent,
	SpaceWorkflow,
	RuntimeState,
	CreateSpaceTaskParams,
	UpdateSpaceTaskParams,
	CreateSpaceAgentParams,
	UpdateSpaceAgentParams,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
	CreateWorkflowRunParams,
	UpdateSpaceParams,
} from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('kai:web:spacestore');

class SpaceStore {
	// ========================================
	// Core Signals
	// ========================================

	/** Current active space ID */
	readonly spaceId = signal<string | null>(null);

	/** Space metadata */
	readonly space = signal<Space | null>(null);

	/** Tasks for this space */
	readonly tasks = signal<SpaceTask[]>([]);

	/** Workflow runs for this space */
	readonly workflowRuns = signal<SpaceWorkflowRun[]>([]);

	/** Agents configured for this space */
	readonly agents = signal<SpaceAgent[]>([]);

	/** Workflow definitions for this space */
	readonly workflows = signal<SpaceWorkflow[]>([]);

	/** Runtime state for this space */
	readonly runtimeState = signal<RuntimeState | null>(null);

	/** Loading state */
	readonly loading = signal<boolean>(false);

	/** Error state */
	readonly error = signal<string | null>(null);

	// ========================================
	// Computed Signals
	// ========================================

	/** Tasks that are currently in progress */
	readonly activeTasks = computed(() => this.tasks.value.filter((t) => t.status === 'in_progress'));

	/** Workflow runs that are currently active (pending or in_progress) */
	readonly activeRuns = computed(() =>
		this.workflowRuns.value.filter((r) => r.status === 'pending' || r.status === 'in_progress')
	);

	/** Tasks grouped by workflow run ID */
	readonly tasksByRun = computed(() => {
		const map = new Map<string, SpaceTask[]>();
		for (const task of this.tasks.value) {
			if (task.workflowRunId) {
				const existing = map.get(task.workflowRunId) ?? [];
				map.set(task.workflowRunId, [...existing, task]);
			}
		}
		return map;
	});

	/** Tasks not associated with any workflow run */
	readonly standaloneTasks = computed(() => this.tasks.value.filter((t) => !t.workflowRunId));

	// ========================================
	// Private State
	// ========================================

	/**
	 * Promise-chain lock for atomic space switching.
	 * The `.catch()` ensures a rejection in `doSelect` never permanently breaks
	 * the chain — future `selectSpace` calls will still execute.
	 */
	private selectPromise: Promise<void> = Promise.resolve();

	/** Subscription cleanup functions */
	private cleanupFunctions: Array<() => void> = [];

	/** The space-specific channel that was joined, for cleanup on switch */
	private activeSpaceChannel: string | null = null;

	// ========================================
	// Space Selection (with Promise-Chain Lock)
	// ========================================

	/**
	 * Select a space with atomic subscription management.
	 *
	 * Uses promise-chain locking to prevent race conditions:
	 * - Each selectSpace() waits for previous selectSpace() to complete
	 * - Unsubscribe -> Update state -> Subscribe happens atomically
	 *
	 * Note: errors from `doSelect` are already handled internally (set on
	 * `this.error`) and are logged. The chain `.catch()` is a safety net so
	 * that an unexpected rejection never permanently breaks the promise chain
	 * — callers always receive a resolved promise and observe errors via the
	 * `error` signal.
	 */
	selectSpace(spaceId: string | null): Promise<void> {
		this.selectPromise = this.selectPromise
			.then(() => this.doSelect(spaceId))
			.catch((err) => {
				logger.error('selectSpace chain error:', err);
			});
		return this.selectPromise;
	}

	/**
	 * Clear the current space selection
	 */
	clearSpace(): Promise<void> {
		return this.selectSpace(null);
	}

	/**
	 * Internal selection logic (called within promise chain)
	 */
	private async doSelect(spaceId: string | null): Promise<void> {
		if (this.spaceId.value === spaceId) {
			return;
		}

		// 1. Stop current subscriptions and leave old channel
		this.stopSubscriptions();
		if (this.activeSpaceChannel) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub.leaveChannel(this.activeSpaceChannel);
			}
			this.activeSpaceChannel = null;
		}

		// 2. Clear state
		this.space.value = null;
		this.tasks.value = [];
		this.workflowRuns.value = [];
		this.agents.value = [];
		this.workflows.value = [];
		this.runtimeState.value = null;
		this.error.value = null;

		// 3. Update active space
		this.spaceId.value = spaceId;

		// 4. Start new subscriptions if space selected
		if (spaceId) {
			this.loading.value = true;
			try {
				await this.startSubscriptions(spaceId);
			} catch (err) {
				logger.error('Failed to start space subscriptions:', err);
				this.error.value = err instanceof Error ? err.message : 'Failed to load space';
			} finally {
				this.loading.value = false;
			}
		}
	}

	// ========================================
	// Subscription Management
	// ========================================

	/**
	 * Start subscriptions for a space
	 */
	private async startSubscriptions(spaceId: string): Promise<void> {
		const hub = await connectionManager.getHub();

		// Join the space-specific channel so spaceAgent.* events are delivered.
		// The daemon emits those events with sessionId: `space:${spaceId}`, which
		// the server router delivers only to members of that channel.
		const spaceChannel = `space:${spaceId}`;
		hub.joinChannel(spaceChannel);
		this.activeSpaceChannel = spaceChannel;

		// --- space.updated ---
		const unsubSpaceUpdated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			space?: Partial<Space>;
		}>('space.updated', (event) => {
			if (event.spaceId === spaceId && event.space && this.space.value) {
				this.space.value = { ...this.space.value, ...event.space } as Space;
			}
		});
		this.cleanupFunctions.push(unsubSpaceUpdated);

		// --- space.archived ---
		const unsubSpaceArchived = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			space: Space;
		}>('space.archived', (event) => {
			if (event.spaceId === spaceId) {
				// Space archived externally — clear selection
				this.clearSpace().catch((err) => {
					logger.error('Failed to clear space after external archive:', err);
				});
			}
		});
		this.cleanupFunctions.push(unsubSpaceArchived);

		// --- space.deleted ---
		const unsubSpaceDeleted = hub.onEvent<{
			sessionId: string;
			spaceId: string;
		}>('space.deleted', (event) => {
			if (event.spaceId === spaceId) {
				// Space deleted externally — clear selection
				this.clearSpace().catch((err) => {
					logger.error('Failed to clear space after external delete:', err);
				});
			}
		});
		this.cleanupFunctions.push(unsubSpaceDeleted);

		// --- space.task.created ---
		const unsubTaskCreated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			taskId: string;
			task: SpaceTask;
		}>('space.task.created', (event) => {
			if (event.spaceId === spaceId) {
				const exists = this.tasks.value.some((t) => t.id === event.task.id);
				if (!exists) {
					this.tasks.value = [...this.tasks.value, event.task];
				}
			}
		});
		this.cleanupFunctions.push(unsubTaskCreated);

		// --- space.task.updated ---
		const unsubTaskUpdated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			taskId: string;
			task: SpaceTask;
		}>('space.task.updated', (event) => {
			if (event.spaceId === spaceId) {
				const idx = this.tasks.value.findIndex((t) => t.id === event.task.id);
				if (idx >= 0) {
					this.tasks.value = [
						...this.tasks.value.slice(0, idx),
						event.task,
						...this.tasks.value.slice(idx + 1),
					];
				} else {
					this.tasks.value = [...this.tasks.value, event.task];
				}
			}
		});
		this.cleanupFunctions.push(unsubTaskUpdated);

		// --- space.workflowRun.created ---
		const unsubRunCreated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			runId: string;
			run: SpaceWorkflowRun;
		}>('space.workflowRun.created', (event) => {
			if (event.spaceId === spaceId) {
				const exists = this.workflowRuns.value.some((r) => r.id === event.run.id);
				if (!exists) {
					this.workflowRuns.value = [...this.workflowRuns.value, event.run];
				}
			}
		});
		this.cleanupFunctions.push(unsubRunCreated);

		// --- space.workflowRun.updated ---
		const unsubRunUpdated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			runId: string;
			run?: Partial<SpaceWorkflowRun>;
		}>('space.workflowRun.updated', (event) => {
			if (event.spaceId === spaceId && event.run) {
				const idx = this.workflowRuns.value.findIndex((r) => r.id === event.runId);
				if (idx >= 0) {
					this.workflowRuns.value = [
						...this.workflowRuns.value.slice(0, idx),
						{ ...this.workflowRuns.value[idx], ...event.run },
						...this.workflowRuns.value.slice(idx + 1),
					];
				}
			}
		});
		this.cleanupFunctions.push(unsubRunUpdated);

		// --- spaceAgent.created ---
		const unsubAgentCreated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			agent: SpaceAgent;
		}>('spaceAgent.created', (event) => {
			if (event.spaceId === spaceId) {
				const exists = this.agents.value.some((a) => a.id === event.agent.id);
				if (!exists) {
					this.agents.value = [...this.agents.value, event.agent];
				}
			}
		});
		this.cleanupFunctions.push(unsubAgentCreated);

		// --- spaceAgent.updated ---
		const unsubAgentUpdated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			agent: SpaceAgent;
		}>('spaceAgent.updated', (event) => {
			if (event.spaceId === spaceId) {
				const idx = this.agents.value.findIndex((a) => a.id === event.agent.id);
				if (idx >= 0) {
					this.agents.value = [
						...this.agents.value.slice(0, idx),
						event.agent,
						...this.agents.value.slice(idx + 1),
					];
				} else {
					this.agents.value = [...this.agents.value, event.agent];
				}
			}
		});
		this.cleanupFunctions.push(unsubAgentUpdated);

		// --- spaceAgent.deleted ---
		const unsubAgentDeleted = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			agentId: string;
		}>('spaceAgent.deleted', (event) => {
			if (event.spaceId === spaceId) {
				this.agents.value = this.agents.value.filter((a) => a.id !== event.agentId);
			}
		});
		this.cleanupFunctions.push(unsubAgentDeleted);

		// --- spaceWorkflow.created ---
		const unsubWorkflowCreated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			workflow: SpaceWorkflow;
		}>('spaceWorkflow.created', (event) => {
			if (event.spaceId === spaceId) {
				const exists = this.workflows.value.some((w) => w.id === event.workflow.id);
				if (!exists) {
					this.workflows.value = [...this.workflows.value, event.workflow];
				}
			}
		});
		this.cleanupFunctions.push(unsubWorkflowCreated);

		// --- spaceWorkflow.updated ---
		const unsubWorkflowUpdated = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			workflow: SpaceWorkflow;
		}>('spaceWorkflow.updated', (event) => {
			if (event.spaceId === spaceId) {
				const idx = this.workflows.value.findIndex((w) => w.id === event.workflow.id);
				if (idx >= 0) {
					this.workflows.value = [
						...this.workflows.value.slice(0, idx),
						event.workflow,
						...this.workflows.value.slice(idx + 1),
					];
				} else {
					this.workflows.value = [...this.workflows.value, event.workflow];
				}
			}
		});
		this.cleanupFunctions.push(unsubWorkflowUpdated);

		// --- spaceWorkflow.deleted ---
		const unsubWorkflowDeleted = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			workflowId: string;
		}>('spaceWorkflow.deleted', (event) => {
			if (event.spaceId === spaceId) {
				this.workflows.value = this.workflows.value.filter((w) => w.id !== event.workflowId);
			}
		});
		this.cleanupFunctions.push(unsubWorkflowDeleted);

		// Fetch initial state via RPC
		await this.fetchInitialState(hub, spaceId);
	}

	/**
	 * Fetch initial state via RPC (pure WebSocket)
	 */
	private async fetchInitialState(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		spaceId: string
	): Promise<void> {
		const overview = await hub.request<{
			space: Space;
			tasks: SpaceTask[];
			workflowRuns: SpaceWorkflowRun[];
			sessions: string[];
		}>('space.overview', { id: spaceId });

		if (!overview) {
			this.error.value = 'Space not found';
			return;
		}

		this.space.value = overview.space;
		this.tasks.value = overview.tasks ?? [];
		this.workflowRuns.value = overview.workflowRuns ?? [];

		// Fetch agents and workflows in parallel
		await Promise.all([this.fetchAgents(hub, spaceId), this.fetchWorkflows(hub, spaceId)]);
	}

	/**
	 * Fetch agents for the space
	 */
	private async fetchAgents(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		spaceId: string
	): Promise<void> {
		try {
			const result = await hub.request<{ agents: SpaceAgent[] }>('spaceAgent.list', {
				spaceId,
			});
			this.agents.value = result?.agents ?? [];
		} catch (err) {
			logger.error('Failed to fetch agents:', err);
		}
	}

	/**
	 * Fetch workflow definitions for the space
	 */
	private async fetchWorkflows(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		spaceId: string
	): Promise<void> {
		try {
			const result = await hub.request<{ workflows: SpaceWorkflow[] }>('spaceWorkflow.list', {
				spaceId,
			});
			this.workflows.value = result?.workflows ?? [];
		} catch (err) {
			logger.error('Failed to fetch workflows:', err);
		}
	}

	/**
	 * Stop all current subscriptions (synchronous)
	 */
	private stopSubscriptions(): void {
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
	// Refresh
	// ========================================

	/**
	 * Refresh current space state from server.
	 * Called by the connection manager on WebSocket reconnect.
	 */
	async refresh(): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) return;

		try {
			const hub = await connectionManager.getHub();
			await this.fetchInitialState(hub, spaceId);
		} catch (err) {
			logger.error('Failed to refresh space state:', err);
		}
	}

	// ========================================
	// Space Methods
	// ========================================

	/**
	 * Update the current space metadata.
	 * Note: daemon's space.update returns Space directly (not wrapped).
	 */
	async updateSpace(params: UpdateSpaceParams): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const space = await hub.request<Space>('space.update', { id: spaceId, ...params });
		if (space) {
			this.space.value = space;
		}
	}

	/**
	 * Archive the current space
	 */
	async archiveSpace(): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('space.archive', { id: spaceId });
		// Clear selection after archive
		await this.clearSpace();
	}

	/**
	 * Permanently delete the current space
	 */
	async deleteSpace(): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('space.delete', { id: spaceId });
		// Clear selection after delete
		await this.clearSpace();
	}

	// ========================================
	// Task Methods
	// ========================================

	/**
	 * Create a new task in the space.
	 * Note: daemon's spaceTask.create returns SpaceTask directly (not wrapped).
	 */
	async createTask(params: Omit<CreateSpaceTaskParams, 'spaceId'>): Promise<SpaceTask> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const task = await hub.request<SpaceTask>('spaceTask.create', { ...params, spaceId });
		return task;
	}

	/**
	 * Update a task.
	 * Note: daemon's spaceTask.update returns SpaceTask directly (not wrapped).
	 */
	async updateTask(taskId: string, params: UpdateSpaceTaskParams): Promise<SpaceTask> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const task = await hub.request<SpaceTask>('spaceTask.update', {
			taskId,
			spaceId,
			...params,
		});
		return task;
	}

	// ========================================
	// Workflow Run Methods
	// ========================================

	/**
	 * Start a new workflow run.
	 *
	 * TODO(M6): The `spaceWorkflowRun.create` RPC handler is not yet registered
	 * in the daemon — workflow runs are currently created internally by the
	 * SpaceRuntime. This method is a stub for the future client-initiated API.
	 * The event subscriptions for space.workflowRun.created/updated are already
	 * active and will reflect runs created by the runtime.
	 */
	async startWorkflowRun(
		params: Omit<CreateWorkflowRunParams, 'spaceId'>
	): Promise<SpaceWorkflowRun> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const run = await hub.request<SpaceWorkflowRun>('spaceWorkflowRun.create', {
			...params,
			spaceId,
		});
		return run;
	}

	// ========================================
	// Agent Methods
	// ========================================

	/**
	 * Create a new agent in the space
	 */
	async createAgent(params: Omit<CreateSpaceAgentParams, 'spaceId'>): Promise<SpaceAgent> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const { agent } = await hub.request<{ agent: SpaceAgent }>('spaceAgent.create', {
			...params,
			spaceId,
		});
		return agent;
	}

	/**
	 * Update an agent
	 */
	async updateAgent(agentId: string, params: UpdateSpaceAgentParams): Promise<SpaceAgent> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const { agent } = await hub.request<{ agent: SpaceAgent }>('spaceAgent.update', {
			id: agentId,
			spaceId,
			...params,
		});
		return agent;
	}

	/**
	 * Delete an agent from the space
	 */
	async deleteAgent(agentId: string): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('spaceAgent.delete', { id: agentId, spaceId });
	}

	// ========================================
	// Workflow Definition Methods
	// ========================================

	/**
	 * Create a new workflow definition
	 */
	async createWorkflow(params: Omit<CreateSpaceWorkflowParams, 'spaceId'>): Promise<SpaceWorkflow> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const { workflow } = await hub.request<{ workflow: SpaceWorkflow }>('spaceWorkflow.create', {
			...params,
			spaceId,
		});
		return workflow;
	}

	/**
	 * Update a workflow definition
	 */
	async updateWorkflow(
		workflowId: string,
		params: UpdateSpaceWorkflowParams
	): Promise<SpaceWorkflow> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const { workflow } = await hub.request<{ workflow: SpaceWorkflow }>('spaceWorkflow.update', {
			id: workflowId,
			spaceId,
			...params,
		});
		return workflow;
	}

	/**
	 * Delete a workflow definition
	 */
	async deleteWorkflow(workflowId: string): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('spaceWorkflow.delete', { id: workflowId, spaceId });
	}
}

/** Singleton space store instance */
export const spaceStore = new SpaceStore();
