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
 * - agentTemplates: Built-in agent templates from daemon seeding source
 * - workflows: SpaceWorkflow list for the space
 * - workflowTemplates: Built-in workflow templates from daemon seeding source
 * - runtimeState: Runtime state (running/paused/stopped)
 * - nodeExecutions: NodeExecution list for all workflow runs in the space
 * - nodeExecutionsByNodeId: NodeExecutions grouped by workflow node ID
 * - loading: Loading state
 * - error: Error state
 */

import type {
	CreateSpaceAgentParams,
	CreateSpaceTaskParams,
	CreateSpaceWorkflowParams,
	LiveQueryDeltaEvent,
	LiveQuerySnapshotEvent,
	NodeExecution,
	RuntimeState,
	Space,
	SpaceAgent,
	SpaceTask,
	SpaceTaskActivityMember,
	SpaceWorkflow,
	SpaceWorkflowRun,
	UpdateSpaceAgentParams,
	UpdateSpaceParams,
	UpdateSpaceTaskParams,
	UpdateSpaceWorkflowParams,
	WorkflowRunArtifact,
} from '@neokai/shared';
import { isUUID, Logger } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { computed, signal } from '@preact/signals';
import { connectionManager } from './connection-manager';

const logger = new Logger('kai:web:spacestore');

export interface SpaceSessionSummary {
	id: string;
	title: string;
	status: string;
	type: string;
	lastActiveAt: number;
}

/** Space enriched with active tasks and recent sessions for the global list */
export interface SpaceWithTasks extends Space {
	tasks: SpaceTask[];
	sessions: SpaceSessionSummary[];
}

export interface SpaceAgentTemplate {
	name: string;
	description: string;
	tools: string[];
	customPrompt: string;
}

class SpaceStore {
	// ========================================
	// Core Signals
	// ========================================

	/**
	 * Global list of all spaces (across all spaces, for the sidebar list).
	 * Populated by initGlobalList(); not tied to any selected space.
	 */
	readonly spaces = signal<Space[]>([]);

	/**
	 * Spaces with their active (non-completed, non-cancelled) tasks.
	 * Used by the Context Panel thread-style list.
	 */
	readonly spacesWithTasks = signal<SpaceWithTasks[]>([]);

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

	/** Built-in agent templates sourced from daemon seeding definitions */
	readonly agentTemplates = signal<SpaceAgentTemplate[]>([]);

	/** Workflow definitions for this space */
	readonly workflows = signal<SpaceWorkflow[]>([]);

	/** Built-in workflow templates sourced from daemon seeding definitions */
	readonly workflowTemplates = signal<SpaceWorkflow[]>([]);

	/** Runtime state for this space */
	readonly runtimeState = signal<RuntimeState | null>(null);

	/** Live task-agent activity rows keyed by task ID */
	readonly taskActivity = signal<Map<string, SpaceTaskActivityMember[]>>(new Map());

	/** Loading state */
	readonly loading = signal<boolean>(false);

	/** Error state */
	readonly error = signal<string | null>(null);

	/** Whether configure-view data (agents, workflows, templates) has been loaded for the current space */
	readonly configDataLoaded = signal<boolean>(false);

	/** Whether node executions have been loaded for the current space */
	readonly nodeExecLoaded = signal<boolean>(false);

	/** Sessions for this space — reactive via LiveQuery (title, status changes) */
	readonly sessions = signal<
		Array<{ id: string; title: string; status: string; lastActiveAt: number }>
	>([]);

	/** Cleanup functions for the space sessions LiveQuery subscription */
	private spaceSessionsCleanupFns: Array<() => void> = [];

	/** Stale-event guard for space sessions LiveQuery subscription */
	private activeSpaceSessionsSubscriptionId: string | null = null;

	/** Tasks needing human attention — reactive via LiveQuery */
	readonly attentionTasks = signal<
		Array<{
			id: string;
			title: string;
			status: string;
			blockReason: string | null;
			result: string | null;
			taskNumber: number;
			spaceId: string;
			updatedAt: number;
		}>
	>([]);

	/** Cleanup functions for the attention tasks LiveQuery subscription */
	private attentionTasksCleanupFns: Array<() => void> = [];

	/** Stale-event guard for attention tasks LiveQuery subscription */
	private activeAttentionTasksSubscriptionId: string | null = null;

	// ========================================
	// Private Helpers
	// ========================================

	/** Derive runtime state from Space fields */
	private updateRuntimeState(space: Space): void {
		if (space.status === 'archived') {
			this.runtimeState.value = 'stopped';
			return;
		}
		if (space.stopped) {
			this.runtimeState.value = 'stopped';
			return;
		}
		this.runtimeState.value = space.paused ? 'paused' : 'running';
	}

	// ========================================
	// Computed Signals
	// ========================================

	/** Number of tasks needing human attention (review + human-blocked) */
	readonly attentionCount = computed(() => this.attentionTasks.value.length);

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

	/** Node executions for all workflow runs — loaded via initial fetch and LiveQuery subscriptions */
	readonly nodeExecutions = signal<NodeExecution[]>([]);

	/** Node executions grouped by workflow node ID */
	readonly nodeExecutionsByNodeId = computed(() => {
		const map = new Map<string, NodeExecution[]>();
		for (const exec of this.nodeExecutions.value) {
			let arr = map.get(exec.workflowNodeId);
			if (!arr) {
				arr = [];
				map.set(exec.workflowNodeId, arr);
			}
			arr.push(exec);
		}
		return map;
	});

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

	/** Whether global list subscriptions have been set up */
	private globalListInitialized = false;

	/**
	 * Cleanup functions for global list event subscriptions.
	 * Stored so re-initialization (on reconnect) can remove old handlers
	 * before registering new ones on the same hub instance.
	 */
	private globalListCleanupFns: Array<() => void> = [];

	/** Cleanup functions for the active task-activity LiveQuery subscription */
	private taskActivityCleanupFns: Array<() => void> = [];

	/** Active task ID for the current task-activity LiveQuery subscription */
	private activeTaskActivityTaskId: string | null = null;

	/** Stale-event guard for task-activity LiveQuery subscriptions */
	private activeTaskActivitySubscriptionIds = new Set<string>();

	/** Cleanup functions for node execution LiveQuery subscriptions */
	private nodeExecCleanupFns: Array<() => void> = [];

	/** Stale-event guard for node execution LiveQuery subscriptions */
	private activeNodeExecSubscriptionIds = new Set<string>();

	/** In-flight promise for ensureConfigData to prevent duplicate fetches */
	private configDataPromise: Promise<void> | null = null;

	/** In-flight promise for ensureNodeExecutions to prevent duplicate fetches */
	private nodeExecPromise: Promise<void> | null = null;

	private upsertTaskOnePerRun(tasks: SpaceTask[], task: SpaceTask): SpaceTask[] {
		const withoutSameId = tasks.filter((current) => current.id !== task.id);
		if (!task.workflowRunId) {
			return [...withoutSameId, task].sort((a, b) => b.updatedAt - a.updatedAt);
		}

		const sameRun = withoutSameId.filter((current) => current.workflowRunId === task.workflowRunId);
		const others = withoutSameId.filter((current) => current.workflowRunId !== task.workflowRunId);
		const runTitle =
			this.workflowRuns.value
				.find((run) => run.id === task.workflowRunId)
				?.title?.trim()
				.toLowerCase() ?? null;
		const merged = [...sameRun, task];
		const canonical = merged.find((candidate) => {
			if (!runTitle) return false;
			return candidate.title.trim().toLowerCase() === runTitle;
		});
		const fallback =
			canonical ??
			[...merged].sort((a, b) => {
				if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
				return a.taskNumber - b.taskNumber;
			})[0];
		return [...others, fallback].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private removeTaskOnePerRun(tasks: SpaceTask[], task: SpaceTask): SpaceTask[] {
		return tasks.filter(
			(current) =>
				current.id !== task.id &&
				(!task.workflowRunId || current.workflowRunId !== task.workflowRunId)
		);
	}

	private collapseTasksOnePerRun(tasks: SpaceTask[], runs: SpaceWorkflowRun[]): SpaceTask[] {
		if (tasks.length === 0) return [];
		const runsById = new Map(runs.map((run) => [run.id, run]));
		const groupedByRun = new Map<string, SpaceTask[]>();
		const standalone: SpaceTask[] = [];

		for (const task of tasks) {
			if (!task.workflowRunId) {
				standalone.push(task);
				continue;
			}
			const existing = groupedByRun.get(task.workflowRunId) ?? [];
			existing.push(task);
			groupedByRun.set(task.workflowRunId, existing);
		}

		const canonicalWorkflowTasks = Array.from(groupedByRun.entries()).map(([runId, runTasks]) => {
			const runTitle = runsById.get(runId)?.title?.trim().toLowerCase() ?? null;
			const byRunTitle = runTitle
				? runTasks.find((task) => task.title.trim().toLowerCase() === runTitle)
				: undefined;
			return (
				byRunTitle ??
				[...runTasks].sort((a, b) => {
					if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
					return a.taskNumber - b.taskNumber;
				})[0]
			);
		});

		return [...standalone, ...canonicalWorkflowTasks].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	// ========================================
	// Global Space List
	// ========================================

	/**
	 * Initialize the global space list.
	 * Fetches all spaces from the server and subscribes to global create/archive/delete events.
	 * Safe to call multiple times — idempotent after first call.
	 *
	 * On reconnect, refresh() resets `globalListInitialized` so this runs again.
	 * Before re-registering, any stale handlers from the previous run are removed
	 * via `globalListCleanupFns` to prevent duplicate subscriptions on the same hub.
	 */
	async initGlobalList(): Promise<void> {
		if (this.globalListInitialized) return;
		this.globalListInitialized = true;

		// Remove stale handlers from the previous registration (e.g. after a refresh reset).
		// This prevents duplicate event firings when the same hub instance is reused.
		for (const cleanup of this.globalListCleanupFns) {
			try {
				cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.globalListCleanupFns = [];

		try {
			const hub = await connectionManager.getHub();
			const enriched = await hub.request<SpaceWithTasks[]>('space.listWithTasks', {});
			const spaces = (enriched ?? []).map(
				({ tasks: _tasks, sessions: _sessions, ...space }) => space
			);
			this.spaces.value = spaces;
			this.spacesWithTasks.value = enriched ?? [];

			// Subscribe to global space events to keep list up-to-date
			this.globalListCleanupFns.push(
				hub.onEvent<{ spaceId: string; space: Space }>('space.created', (event) => {
					if (event.space) {
						const exists = this.spaces.value.some((s) => s.id === event.spaceId);
						if (!exists) {
							this.spaces.value = [...this.spaces.value, event.space];
							this.spacesWithTasks.value = [
								...this.spacesWithTasks.value,
								{ ...event.space, tasks: [], sessions: [] },
							];
						}
					}
				})
			);

			this.globalListCleanupFns.push(
				hub.onEvent<{ spaceId: string; space?: Partial<Space> }>('space.updated', (event) => {
					this.spaces.value = this.spaces.value.map((s) =>
						s.id === event.spaceId ? ({ ...s, ...event.space } as Space) : s
					);
					this.spacesWithTasks.value = this.spacesWithTasks.value.map((s) =>
						s.id === event.spaceId ? ({ ...s, ...event.space } as SpaceWithTasks) : s
					);
				})
			);

			this.globalListCleanupFns.push(
				hub.onEvent<{ spaceId: string; space: Space }>('space.archived', (event) => {
					this.spaces.value = this.spaces.value.map((s) =>
						s.id === event.spaceId ? event.space : s
					);
					this.spacesWithTasks.value = this.spacesWithTasks.value.map((s) =>
						s.id === event.spaceId
							? ({ ...event.space, tasks: s.tasks, sessions: s.sessions } as SpaceWithTasks)
							: s
					);
				})
			);

			this.globalListCleanupFns.push(
				hub.onEvent<{ spaceId: string }>('space.deleted', (event) => {
					this.spaces.value = this.spaces.value.filter((s) => s.id !== event.spaceId);
					this.spacesWithTasks.value = this.spacesWithTasks.value.filter(
						(s) => s.id !== event.spaceId
					);
				})
			);

			// Keep spacesWithTasks in sync when tasks are created/updated
			this.globalListCleanupFns.push(
				hub.onEvent<{
					sessionId: string;
					spaceId: string;
					taskId: string;
					task: SpaceTask;
				}>('space.task.created', (event) => {
					const swt = this.spacesWithTasks.value;
					const idx = swt.findIndex((s) => s.id === event.spaceId);
					if (idx >= 0) {
						// Only add if not completed/cancelled
						if (event.task.status !== 'done' && event.task.status !== 'cancelled') {
							const nextTasks = this.upsertTaskOnePerRun(swt[idx].tasks, event.task);
							this.spacesWithTasks.value = [
								...swt.slice(0, idx),
								{ ...swt[idx], tasks: nextTasks },
								...swt.slice(idx + 1),
							];
						}
					}
				})
			);

			this.globalListCleanupFns.push(
				hub.onEvent<{
					sessionId: string;
					spaceId: string;
					taskId: string;
					task: SpaceTask;
				}>('space.task.updated', (event) => {
					const swt = this.spacesWithTasks.value;
					const idx = swt.findIndex((s) => s.id === event.spaceId);
					if (idx >= 0) {
						const spaceTasks = swt[idx].tasks;
						// If task was completed/cancelled, remove it
						if (event.task.status === 'done' || event.task.status === 'cancelled') {
							const updated = this.removeTaskOnePerRun(spaceTasks, event.task);
							this.spacesWithTasks.value = [
								...swt.slice(0, idx),
								{ ...swt[idx], tasks: updated },
								...swt.slice(idx + 1),
							];
						} else {
							const updated = this.upsertTaskOnePerRun(spaceTasks, event.task);
							this.spacesWithTasks.value = [
								...swt.slice(0, idx),
								{ ...swt[idx], tasks: updated },
								...swt.slice(idx + 1),
							];
						}
					}
				})
			);
		} catch (err) {
			logger.error('Failed to initialize global space list:', err);
			// Reset flag so retries work on reconnect
			this.globalListInitialized = false;
		}
	}

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
	 * Internal selection logic (called within promise chain).
	 * The spaceIdOrSlug parameter can be either a UUID or a slug — both are resolved
	 * to the canonical UUID during initial state fetch.
	 */
	private async doSelect(spaceIdOrSlug: string | null): Promise<void> {
		if (this.spaceId.value === spaceIdOrSlug) {
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
		this.agentTemplates.value = [];
		this.workflows.value = [];
		this.workflowTemplates.value = [];
		this.nodeExecutions.value = [];
		this.runtimeState.value = null;
		this.taskActivity.value = new Map();
		this.error.value = null;
		this.configDataLoaded.value = false;
		this.configDataPromise = null;
		this.nodeExecLoaded.value = false;
		this.nodeExecPromise = null;
		this.sessions.value = [];
		this.disposeSpaceSessionsSubscription();
		this.attentionTasks.value = [];
		this.disposeAttentionTasksSubscription();

		// 3. Update active space (may be updated to real UUID after fetch)
		this.spaceId.value = spaceIdOrSlug;

		// 4. Start new subscriptions if space selected
		if (spaceIdOrSlug) {
			this.loading.value = true;
			try {
				// Resolve slug to UUID via overview fetch, then subscribe with the real UUID
				const resolvedId = await this.fetchAndResolveSpace(spaceIdOrSlug);
				if (resolvedId) {
					// Update spaceId to the canonical UUID if it was a slug
					if (resolvedId !== spaceIdOrSlug) {
						this.spaceId.value = resolvedId;
					}
					await this.startSubscriptions(resolvedId);
				}
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
				const updated = { ...this.space.value, ...event.space } as Space;
				this.space.value = updated;
				this.updateRuntimeState(updated);
			}
		});
		this.cleanupFunctions.push(unsubSpaceUpdated);

		// --- spaceSessions.bySpace LiveQuery ---
		this.subscribeSpaceSessions(hub, spaceId);

		// --- spaceTasks.needingAttention LiveQuery ---
		this.subscribeAttentionTasks(hub, spaceId);

		// --- space.archived ---
		const unsubSpaceArchived = hub.onEvent<{
			sessionId: string;
			spaceId: string;
			space: Space;
		}>('space.archived', (event) => {
			if (event.spaceId === spaceId) {
				// Conditional clear: only clear if still on this space when the promise chain
				// executes. A late-arriving event for a previous space can otherwise clear the
				// newly-selected space (race between selectSpace chain and delayed WS events).
				this.selectPromise = this.selectPromise
					.then(() => {
						if (this.spaceId.value === spaceId) {
							return this.doSelect(null);
						}
					})
					.catch((err) => {
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
				// Conditional clear: only clear if still on this space when the promise chain
				// executes. A late-arriving event for a previous space can otherwise clear the
				// newly-selected space (race between selectSpace chain and delayed WS events).
				this.selectPromise = this.selectPromise
					.then(() => {
						if (this.spaceId.value === spaceId) {
							return this.doSelect(null);
						}
					})
					.catch((err) => {
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
				this.tasks.value = this.upsertTaskOnePerRun(this.tasks.value, event.task);
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
				this.tasks.value = this.upsertTaskOnePerRun(this.tasks.value, event.task);
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
					// Subscribe to the new run's LiveQuery for real-time updates
					this.subscribeNodeExecutionsByRun(hub, event.run.id);
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
	}

	/**
	 * Fetch initial state and resolve slug to UUID.
	 * Returns the resolved space UUID, or null if not found.
	 */
	private async fetchAndResolveSpace(spaceIdOrSlug: string): Promise<string | null> {
		const hub = await connectionManager.getHub();

		const overview = await hub.request<{
			space: Space;
			tasks: SpaceTask[];
			workflowRuns: SpaceWorkflowRun[];
			sessions: string[];
		}>('space.overview', isUUID(spaceIdOrSlug) ? { id: spaceIdOrSlug } : { slug: spaceIdOrSlug });

		if (!overview) {
			this.error.value = 'Space not found';
			return null;
		}

		this.space.value = overview.space;
		this.updateRuntimeState(overview.space);
		this.workflowRuns.value = overview.workflowRuns ?? [];
		// Server already returns collapsed tasks via collapseToCanonicalTasks — use directly
		this.tasks.value = overview.tasks ?? [];

		return overview.space.id;
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
	 * Fetch built-in agent templates from daemon seeding source.
	 */
	private async fetchAgentTemplates(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		spaceId: string
	): Promise<void> {
		try {
			const result = await hub.request<{ templates: SpaceAgentTemplate[] }>(
				'spaceAgent.listBuiltInTemplates',
				{
					spaceId,
				}
			);
			this.agentTemplates.value = result?.templates ?? [];
		} catch (err) {
			logger.error('Failed to fetch agent templates:', err);
			this.agentTemplates.value = [];
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
	 * Fetch built-in workflow templates from daemon seeding source.
	 */
	private async fetchWorkflowTemplates(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		spaceId: string
	): Promise<void> {
		try {
			const result = await hub.request<{ workflows: SpaceWorkflow[] }>(
				'spaceWorkflow.listBuiltInTemplates',
				{
					spaceId,
				}
			);
			this.workflowTemplates.value = result?.workflows ?? [];
		} catch (err) {
			logger.error('Failed to fetch workflow templates:', err);
			this.workflowTemplates.value = [];
		}
	}

	/**
	 * Fetch node executions for all workflow runs in the space.
	 * Calls nodeExecution.list for each run and aggregates the results.
	 */
	private async fetchNodeExecutions(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		spaceId: string
	): Promise<void> {
		try {
			const runs = this.workflowRuns.value;
			if (runs.length === 0) {
				this.nodeExecutions.value = [];
				return;
			}
			const results = await Promise.allSettled(
				runs.map((run) =>
					hub
						.request<{ executions: NodeExecution[] }>('nodeExecution.list', {
							workflowRunId: run.id,
							spaceId,
						})
						.then((r) => r?.executions ?? [])
				)
			);
			const allExecs: NodeExecution[] = [];
			for (const result of results) {
				if (result.status === 'fulfilled') {
					allExecs.push(...result.value);
				} else {
					logger.warn('Failed to fetch node executions for a run:', result.reason);
				}
			}
			this.nodeExecutions.value = allExecs;
		} catch (err) {
			logger.error('Failed to fetch node executions:', err);
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
		this.unsubscribeTaskActivity();
		this.unsubscribeNodeExecutions();
		this.disposeAttentionTasksSubscription();
	}

	// ========================================
	// Lazy-Loading: Config Data & Node Executions
	// ========================================

	/**
	 * Lazily load agents, agent templates, workflows, and workflow templates.
	 * Called by components that need this data (SpaceConfigurePage, SpaceTaskPane).
	 * Safe to call multiple times — deduplicates via promise + flag.
	 */
	async ensureConfigData(): Promise<void> {
		if (this.configDataLoaded.value) return;
		if (this.configDataPromise) return this.configDataPromise;

		const spaceId = this.spaceId.value;
		if (!spaceId) return;

		this.configDataPromise = this.doEnsureConfigData(spaceId);
		try {
			await this.configDataPromise;
		} finally {
			this.configDataPromise = null;
		}
	}

	private async doEnsureConfigData(spaceId: string): Promise<void> {
		try {
			const hub = await connectionManager.getHub();
			await Promise.all([
				this.fetchAgents(hub, spaceId),
				this.fetchAgentTemplates(hub, spaceId),
				this.fetchWorkflows(hub, spaceId),
				this.fetchWorkflowTemplates(hub, spaceId),
			]);
			// Only mark loaded if still the same space
			if (this.spaceId.value === spaceId) {
				this.configDataLoaded.value = true;
			}
		} catch (err) {
			logger.error('Failed to load config data:', err);
		}
	}

	/**
	 * Lazily load node executions and subscribe to LiveQuery updates.
	 * Called by components that render the workflow canvas.
	 * Safe to call multiple times — deduplicates via promise + flag.
	 */
	async ensureNodeExecutions(): Promise<void> {
		if (this.nodeExecLoaded.value) return;
		if (this.nodeExecPromise) return this.nodeExecPromise;

		const spaceId = this.spaceId.value;
		if (!spaceId) return;

		this.nodeExecPromise = this.doEnsureNodeExecutions(spaceId);
		try {
			await this.nodeExecPromise;
		} finally {
			this.nodeExecPromise = null;
		}
	}

	private async doEnsureNodeExecutions(spaceId: string): Promise<void> {
		try {
			const hub = await connectionManager.getHub();
			await this.fetchNodeExecutions(hub, spaceId);
			// Subscribe to real-time updates
			if (this.spaceId.value === spaceId) {
				this.subscribeNodeExecutions(hub);
				this.nodeExecLoaded.value = true;
			}
		} catch (err) {
			logger.error('Failed to load node executions:', err);
		}
	}

	private applyTaskActivityDelta(
		currentRows: SpaceTaskActivityMember[],
		event: LiveQueryDeltaEvent
	): SpaceTaskActivityMember[] {
		const next = new Map(currentRows.map((row) => [row.id, row]));

		for (const row of (event.removed ?? []) as SpaceTaskActivityMember[]) {
			next.delete(row.id);
		}
		for (const row of (event.updated ?? []) as SpaceTaskActivityMember[]) {
			next.set(row.id, row);
		}
		for (const row of (event.added ?? []) as SpaceTaskActivityMember[]) {
			next.set(row.id, row);
		}

		return Array.from(next.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	}

	async subscribeTaskActivity(taskId: string): Promise<void> {
		if (!taskId) return;
		if (this.activeTaskActivityTaskId === taskId) return;

		this.unsubscribeTaskActivity();
		this.activeTaskActivityTaskId = taskId;

		const subscriptionId = `spaceTaskActivity-${taskId}`;

		try {
			const hub = await connectionManager.getHub();
			if (this.activeTaskActivityTaskId !== taskId) return;

			this.activeTaskActivitySubscriptionIds.add(subscriptionId);

			const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
				if (event.subscriptionId !== subscriptionId) return;
				if (!this.activeTaskActivitySubscriptionIds.has(subscriptionId)) return;
				this.taskActivity.value = new Map(this.taskActivity.value).set(
					taskId,
					(event.rows as SpaceTaskActivityMember[]) ?? []
				);
			});
			this.taskActivityCleanupFns.push(unsubSnapshot);
			this.taskActivityCleanupFns.push(() =>
				this.activeTaskActivitySubscriptionIds.delete(subscriptionId)
			);

			const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
				if (event.subscriptionId !== subscriptionId) return;
				if (!this.activeTaskActivitySubscriptionIds.has(subscriptionId)) return;
				const currentRows = this.taskActivity.value.get(taskId) ?? [];
				const nextRows = this.applyTaskActivityDelta(currentRows, event);
				this.taskActivity.value = new Map(this.taskActivity.value).set(taskId, nextRows);
			});
			this.taskActivityCleanupFns.push(unsubDelta);

			const unsubReconnect = hub.onConnection((state) => {
				if (state !== 'connected') return;
				if (!this.activeTaskActivitySubscriptionIds.has(subscriptionId)) return;
				hub
					.request('liveQuery.subscribe', {
						queryName: 'spaceTaskActivity.byTask',
						params: [taskId],
						subscriptionId,
					})
					.catch((err) => {
						logger.warn('Task activity LiveQuery re-subscribe failed:', err);
					});
			});
			this.taskActivityCleanupFns.push(unsubReconnect);

			await hub.request('liveQuery.subscribe', {
				queryName: 'spaceTaskActivity.byTask',
				params: [taskId],
				subscriptionId,
			});

			if (this.activeTaskActivityTaskId !== taskId) {
				this.unsubscribeTaskActivity(taskId);
			}
		} catch (err) {
			this.unsubscribeTaskActivity(taskId);
			throw err;
		}
	}

	unsubscribeTaskActivity(taskId?: string): void {
		const activeTaskId = this.activeTaskActivityTaskId;
		if (!activeTaskId || (taskId && activeTaskId !== taskId)) return;

		const subscriptionId = `spaceTaskActivity-${activeTaskId}`;
		this.activeTaskActivitySubscriptionIds.delete(subscriptionId);

		for (const cleanup of this.taskActivityCleanupFns) {
			try {
				cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.taskActivityCleanupFns = [];
		this.activeTaskActivityTaskId = null;

		const hub = connectionManager.getHubIfConnected();
		if (hub) {
			hub.request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
		}
	}

	// ========================================
	// Node Execution LiveQuery subscriptions
	// ========================================

	/**
	 * Subscribe to nodeExecutions.byRun LiveQueries for all current workflow runs.
	 * Called after initial fetch to enable real-time status updates.
	 */
	private subscribeNodeExecutions(hub: Awaited<ReturnType<typeof connectionManager.getHub>>): void {
		this.unsubscribeNodeExecutions();

		const runs = this.workflowRuns.value;
		if (runs.length === 0) return;

		for (const run of runs) {
			this.subscribeNodeExecutionsByRun(hub, run.id);
		}
	}

	/**
	 * Subscribe to nodeExecutions.byRun for a single workflow run.
	 */
	private subscribeNodeExecutionsByRun(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		runId: string
	): void {
		const subscriptionId = `nodeExecutions-byRun-${runId}`;
		if (this.activeNodeExecSubscriptionIds.has(subscriptionId)) return;
		this.activeNodeExecSubscriptionIds.add(subscriptionId);

		const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== subscriptionId) return;
			if (!this.activeNodeExecSubscriptionIds.has(subscriptionId)) return;
			this.mergeNodeExecSnapshot(event.rows as NodeExecution[], runId);
		});
		this.nodeExecCleanupFns.push(unsubSnapshot);

		const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId !== subscriptionId) return;
			if (!this.activeNodeExecSubscriptionIds.has(subscriptionId)) return;
			this.mergeNodeExecDelta(event);
		});
		this.nodeExecCleanupFns.push(unsubDelta);

		const unsubReconnect = hub.onConnection((state) => {
			if (state !== 'connected') return;
			if (!this.activeNodeExecSubscriptionIds.has(subscriptionId)) return;
			hub
				.request('liveQuery.subscribe', {
					queryName: 'nodeExecutions.byRun',
					params: [runId],
					subscriptionId,
				})
				.catch((err) => {
					logger.warn('Node execution LiveQuery re-subscribe failed:', err);
				});
		});
		this.nodeExecCleanupFns.push(unsubReconnect);

		hub
			.request('liveQuery.subscribe', {
				queryName: 'nodeExecutions.byRun',
				params: [runId],
				subscriptionId,
			})
			.catch((err) => {
				logger.warn('Node execution LiveQuery subscribe failed:', err);
			});
	}

	/**
	 * Merge a LiveQuery snapshot (full replace for one run) into nodeExecutions.
	 */
	private mergeNodeExecSnapshot(rows: NodeExecution[], runId: string): void {
		const current = this.nodeExecutions.value;
		// Remove old executions for this run, add fresh snapshot
		const filtered = current.filter((e) => e.workflowRunId !== runId);
		this.nodeExecutions.value = [...filtered, ...rows];
	}

	/**
	 * Merge a LiveQuery delta (add/remove/update) into nodeExecutions.
	 */
	private mergeNodeExecDelta(event: LiveQueryDeltaEvent): void {
		const current = this.nodeExecutions.value;
		const next = new Map(current.map((e) => [e.id, e]));

		for (const row of (event.removed ?? []) as NodeExecution[]) {
			next.delete(row.id);
		}
		for (const row of (event.updated ?? []) as NodeExecution[]) {
			next.set(row.id, row);
		}
		for (const row of (event.added ?? []) as NodeExecution[]) {
			next.set(row.id, row);
		}

		this.nodeExecutions.value = Array.from(next.values());
	}

	/**
	 * Unsubscribe from all node execution LiveQueries.
	 */
	private unsubscribeNodeExecutions(): void {
		for (const cleanup of this.nodeExecCleanupFns) {
			try {
				cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.nodeExecCleanupFns = [];

		for (const subId of this.activeNodeExecSubscriptionIds) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub.request('liveQuery.unsubscribe', { subscriptionId: subId }).catch(() => {});
			}
		}
		this.activeNodeExecSubscriptionIds = new Set();
	}

	// ========================================
	// Space Sessions LiveQuery
	// ========================================

	/**
	 * Subscribe to spaceSessions.bySpace LiveQuery for real-time session title/status updates.
	 */
	private subscribeSpaceSessions(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		spaceId: string
	): void {
		const subscriptionId = `spaceSessions-bySpace-${spaceId}`;
		if (this.activeSpaceSessionsSubscriptionId === subscriptionId) return;
		this.disposeSpaceSessionsSubscription();
		this.activeSpaceSessionsSubscriptionId = subscriptionId;

		type SessionRow = { id: string; title: string; status: string; lastActiveAt: number };

		const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== subscriptionId) return;
			if (this.activeSpaceSessionsSubscriptionId !== subscriptionId) return;
			this.sessions.value = (event.rows as SessionRow[]) ?? [];
		});
		this.spaceSessionsCleanupFns.push(unsubSnapshot);

		const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId !== subscriptionId) return;
			if (this.activeSpaceSessionsSubscriptionId !== subscriptionId) return;
			const current = this.sessions.value;
			const next = new Map(current.map((s) => [s.id, s]));
			for (const row of (event.removed ?? []) as SessionRow[]) next.delete(row.id);
			for (const row of (event.updated ?? []) as SessionRow[]) next.set(row.id, row);
			for (const row of (event.added ?? []) as SessionRow[]) next.set(row.id, row);
			this.sessions.value = [...next.values()];
		});
		this.spaceSessionsCleanupFns.push(unsubDelta);

		const unsubReconnect = hub.onConnection((state) => {
			if (state !== 'connected') return;
			if (this.activeSpaceSessionsSubscriptionId !== subscriptionId) return;
			hub
				.request('liveQuery.subscribe', {
					queryName: 'spaceSessions.bySpace',
					params: [spaceId],
					subscriptionId,
				})
				.catch((err) => {
					logger.warn('Space sessions LiveQuery re-subscribe failed:', err);
				});
		});
		this.spaceSessionsCleanupFns.push(unsubReconnect);

		hub
			.request('liveQuery.subscribe', {
				queryName: 'spaceSessions.bySpace',
				params: [spaceId],
				subscriptionId,
			})
			.catch((err) => {
				logger.warn('Space sessions LiveQuery subscribe failed:', err);
			});
	}

	private disposeSpaceSessionsSubscription(): void {
		for (const cleanup of this.spaceSessionsCleanupFns) {
			try {
				cleanup();
			} catch {
				// Ignore
			}
		}
		this.spaceSessionsCleanupFns = [];

		if (this.activeSpaceSessionsSubscriptionId) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub
					.request('liveQuery.unsubscribe', {
						subscriptionId: this.activeSpaceSessionsSubscriptionId,
					})
					.catch(() => {});
			}
			this.activeSpaceSessionsSubscriptionId = null;
		}
	}

	// ========================================
	// LiveQuery: Tasks Needing Attention
	// ========================================

	private subscribeAttentionTasks(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		spaceId: string
	): void {
		const subscriptionId = `spaceTasks-needingAttention-${spaceId}`;
		if (this.activeAttentionTasksSubscriptionId === subscriptionId) return;
		this.disposeAttentionTasksSubscription();
		this.activeAttentionTasksSubscriptionId = subscriptionId;

		type AttentionRow = {
			id: string;
			title: string;
			status: string;
			blockReason: string | null;
			result: string | null;
			taskNumber: number;
			spaceId: string;
			updatedAt: number;
		};

		const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId !== subscriptionId) return;
			if (this.activeAttentionTasksSubscriptionId !== subscriptionId) return;
			this.attentionTasks.value = (event.rows as AttentionRow[]) ?? [];
		});
		this.attentionTasksCleanupFns.push(unsubSnapshot);

		const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId !== subscriptionId) return;
			if (this.activeAttentionTasksSubscriptionId !== subscriptionId) return;
			const current = this.attentionTasks.value;
			const next = new Map(current.map((t) => [t.id, t]));
			for (const row of (event.removed ?? []) as AttentionRow[]) next.delete(row.id);
			for (const row of (event.updated ?? []) as AttentionRow[]) next.set(row.id, row);
			for (const row of (event.added ?? []) as AttentionRow[]) next.set(row.id, row);
			this.attentionTasks.value = [...next.values()];
		});
		this.attentionTasksCleanupFns.push(unsubDelta);

		const unsubReconnect = hub.onConnection((state) => {
			if (state !== 'connected') return;
			if (this.activeAttentionTasksSubscriptionId !== subscriptionId) return;
			hub
				.request('liveQuery.subscribe', {
					queryName: 'spaceTasks.needingAttention',
					params: [spaceId],
					subscriptionId,
				})
				.catch((err) => {
					logger.warn('Attention tasks LiveQuery re-subscribe failed:', err);
				});
		});
		this.attentionTasksCleanupFns.push(unsubReconnect);

		hub
			.request('liveQuery.subscribe', {
				queryName: 'spaceTasks.needingAttention',
				params: [spaceId],
				subscriptionId,
			})
			.catch((err) => {
				logger.warn('Attention tasks LiveQuery subscribe failed:', err);
			});
	}

	private disposeAttentionTasksSubscription(): void {
		for (const cleanup of this.attentionTasksCleanupFns) {
			try {
				cleanup();
			} catch {
				// Ignore
			}
		}
		this.attentionTasksCleanupFns = [];

		if (this.activeAttentionTasksSubscriptionId) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub
					.request('liveQuery.unsubscribe', {
						subscriptionId: this.activeAttentionTasksSubscriptionId,
					})
					.catch(() => {});
			}
			this.activeAttentionTasksSubscriptionId = null;
		}
	}

	// ========================================
	// Refresh
	// ========================================

	/**
	 * Refresh current space state from server.
	 * Called by the connection manager on WebSocket reconnect.
	 *
	 * Also re-initializes the global space list when it was previously set up.
	 * The old hub connection is closed on disconnect, tearing down any event
	 * subscriptions registered in initGlobalList(). Resetting the flag here
	 * ensures initGlobalList() runs again with the new hub connection — either
	 * immediately (if the global list was active) or lazily (on next Spaces
	 * section navigation).
	 */
	async refresh(): Promise<void> {
		// Re-initialize global list subscriptions on the new hub if they existed
		if (this.globalListInitialized) {
			this.globalListInitialized = false;
			this.initGlobalList().catch((err) => {
				logger.error('Failed to re-initialize global space list on reconnect:', err);
			});
		}

		const spaceId = this.spaceId.value;
		if (!spaceId) return;

		// Track what was loaded before reconnect so we can re-fetch it
		const hadConfigData = this.configDataLoaded.value;
		const hadNodeExec = this.nodeExecLoaded.value;

		// Reset lazy-load flags so ensureX methods will re-fetch
		this.configDataLoaded.value = false;
		this.configDataPromise = null;
		this.nodeExecLoaded.value = false;
		this.nodeExecPromise = null;
		this.sessions.value = [];
		this.disposeSpaceSessionsSubscription();
		this.attentionTasks.value = [];
		this.disposeAttentionTasksSubscription();

		try {
			await this.fetchAndResolveSpace(spaceId);
			await this.startSubscriptions(spaceId);
			// Re-fetch previously loaded data in background
			if (hadConfigData) {
				this.ensureConfigData().catch((err) => {
					logger.error('Failed to refresh config data:', err);
				});
			}
			if (hadNodeExec) {
				this.ensureNodeExecutions().catch((err) => {
					logger.error('Failed to refresh node executions:', err);
				});
			}
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
			this.updateRuntimeState(space);
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
	 * Stop the current space: terminates all running agent sessions and cancels
	 * in-progress tasks/workflow runs. Marks the space as stopped so it does not
	 * auto-start on daemon restart. The space remains active and can be restarted.
	 */
	async stopSpace(): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const space = await hub.request<Space>('space.stop', { id: spaceId });
		if (space) {
			this.space.value = space;
			this.updateRuntimeState(space);
		}
	}

	/**
	 * Start (or restart) the current space after it has been stopped.
	 * Clears the stopped flag so the runtime resumes scheduling new work.
	 */
	async startSpace(): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const space = await hub.request<Space>('space.start', { id: spaceId });
		if (space) {
			this.space.value = space;
			this.updateRuntimeState(space);
		}
	}

	/**
	 * Pause the current space (stops task scheduling without archiving)
	 */
	async pauseSpace(): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const space = await hub.request<Space>('space.pause', { id: spaceId });
		if (space) {
			this.space.value = space;
			this.updateRuntimeState(space);
		}
	}

	/**
	 * Resume a paused space
	 */
	async resumeSpace(): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const space = await hub.request<Space>('space.resume', { id: spaceId });
		if (space) {
			this.space.value = space;
			this.updateRuntimeState(space);
		}
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

	/**
	 * Approve or reject a task awaiting human sign-off at a `submit_for_approval`
	 * checkpoint (`pendingCheckpointType === 'task_completion'`). Routes to the
	 * `spaceTask.approvePendingCompletion` RPC which handles status transition,
	 * pending-field cleanup, and reason capture atomically.
	 */
	async approvePendingCompletion(
		taskId: string,
		approved: boolean,
		reason?: string | null
	): Promise<SpaceTask> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const task = await hub.request<SpaceTask>('spaceTask.approvePendingCompletion', {
			taskId,
			spaceId,
			approved,
			reason: reason ?? null,
		});
		return task;
	}

	/**
	 * Ensure a Task Agent session exists for a task and return latest task state.
	 */
	async ensureTaskAgentSession(taskId: string): Promise<SpaceTask> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const response = await hub.request<{ task: SpaceTask }>('space.task.ensureAgentSession', {
			taskId,
			spaceId,
		});

		if (!response?.task) throw new Error('Task session response missing task payload');

		const nextTask = response.task;
		this.tasks.value = this.upsertTaskOnePerRun(this.tasks.value, nextTask);

		return nextTask;
	}

	/**
	 * Send a human message into a task's agent thread.
	 */
	async sendTaskMessage(taskId: string, message: string): Promise<void> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		await hub.request('space.task.sendMessage', {
			taskId,
			spaceId,
			message,
		});
	}

	// ========================================
	// Gate Methods
	// ========================================

	/**
	 * List all gate data records for a workflow run.
	 */
	async listGateData(
		runId: string
	): Promise<
		Array<{ runId: string; gateId: string; data: Record<string, unknown>; updatedAt: number }>
	> {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const result = await hub.request<{
			gateData: Array<{
				runId: string;
				gateId: string;
				data: Record<string, unknown>;
				updatedAt: number;
			}>;
		}>('spaceWorkflowRun.listGateData', { runId });
		return result?.gateData ?? [];
	}

	/**
	 * List all artifacts for a workflow run.
	 */
	async listArtifacts(runId: string): Promise<WorkflowRunArtifact[]> {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const result = await hub.request<{ artifacts: WorkflowRunArtifact[] }>(
			'spaceWorkflowRun.listArtifacts',
			{ runId }
		);
		return result?.artifacts ?? [];
	}

	/**
	 * Fetch a paginated snapshot of task-thread messages.
	 */
	async getTaskMessages(
		taskId: string,
		options?: { cursor?: string; limit?: number }
	): Promise<{ messages: SDKMessage[]; hasMore: boolean; sessionId: string }> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const result = await hub.request<{
			messages: SDKMessage[];
			hasMore: boolean;
			sessionId: string;
		}>('space.task.getMessages', {
			taskId,
			spaceId,
			cursor: options?.cursor,
			limit: options?.limit,
		});
		return {
			messages: result?.messages ?? [],
			hasMore: result?.hasMore ?? false,
			sessionId: result?.sessionId ?? '',
		};
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

	/**
	 * Sync a workflow from its built-in template, overwriting current content.
	 * Requires the workflow to have been created from a built-in template (templateName set).
	 */
	async syncWorkflowFromTemplate(workflowId: string): Promise<SpaceWorkflow> {
		const spaceId = this.spaceId.value;
		if (!spaceId) throw new Error('No space selected');

		const hub = connectionManager.getHubIfConnected();
		if (!hub) throw new Error('Not connected');

		const { workflow } = await hub.request<{ workflow: SpaceWorkflow }>(
			'spaceWorkflow.syncFromTemplate',
			{ id: workflowId, spaceId }
		);
		return workflow;
	}
}

/** Singleton space store instance */
export const spaceStore = new SpaceStore();
