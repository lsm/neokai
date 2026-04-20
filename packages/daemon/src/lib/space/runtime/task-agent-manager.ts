/**
 * TaskAgentManager
 *
 * Central integration point that manages the lifecycle of Task Agent sessions
 * and their sub-sessions (node agents). Each SpaceTask gets exactly one Task
 * Agent session, and that session spawns sub-sessions for each workflow node.
 *
 * ## Session hierarchy
 *
 * ```
 * Task Agent session  (space:${spaceId}:task:${taskId})
 *   └── Sub-session   (space:${spaceId}:task:${taskId}:node:${nodeId})
 *   └── Sub-session   (...)
 * ```
 *
 * ## In-memory maps
 *
 * - `taskAgentSessions`  — taskId → Task Agent AgentSession
 * - `subSessions`        — taskId → (nodeId → AgentSession)
 * - `spawningTasks`      — set of taskIds currently being spawned (concurrency guard)
 *
 * The maps are fast-lookup caches; session data is the source of truth in the DB.
 * On daemon restart, maps must be rebuilt via rehydration (Task 5.3).
 *
 * ## Sub-session lifecycle
 *
 * Sub-sessions are created with `AgentSession.fromInit()`, which persists them to
 * the DB. This mirrors the RoomRuntimeService pattern for leader/worker sessions.
 * DB records include `{ internal: true, parentTaskId }` in context metadata so
 * they can be filtered from user-visible session lists.
 *
 * ## Completion detection
 *
 * Uses `SessionObserver`-style `session.updated` subscription on DaemonHub.
 * When a sub-session transitions to `idle` status (after processing completes),
 * registered `onComplete` callbacks are fired.
 */

import { existsSync } from 'node:fs';
import { generateUUID, resolveNodeAgents } from '@neokai/shared';
import type {
	Space,
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	NodeExecution,
	MessageHub,
	McpServerConfig,
	MessageOrigin,
} from '@neokai/shared';
import type { AppMcpLifecycleManager } from '../../mcp/app-mcp-lifecycle-manager';
import type { SkillsManager } from '../../skills-manager';
import type { AppMcpServerRepository } from '../../../storage/repositories/app-mcp-server-repository';
import type { UUID } from 'crypto';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import type { AgentSessionInit } from '../../../lib/agent/agent-session';
import { AgentSession } from '../../../lib/agent/agent-session';
import type { Database } from '../../../storage/database';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { DaemonHub } from '../../daemon-hub';
import type { SessionManager } from '../../session-manager';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceRuntimeService } from './space-runtime-service';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { PendingAgentMessageRepository } from '../../../storage/repositories/pending-agent-message-repository';
import type { SpaceWorktreeManager } from '../managers/space-worktree-manager';
import type { SubSessionMemberInfo } from '../tools/task-agent-tools';
import { createTaskAgentMcpServer } from '../tools/task-agent-tools';
import { createNodeAgentMcpServer } from '../tools/node-agent-tools';
import { createDbQueryMcpServer, type DbQueryMcpServer } from '../../db-query/tools';
import { ChannelResolver } from './channel-resolver';
import { ChannelRouter } from './channel-router';
import { AgentMessageRouter } from './agent-message-router';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import { executeGateScript } from './gate-script-executor';
import { createTaskAgentInit, buildTaskAgentInitialMessage } from '../agents/task-agent';
import {
	buildCustomAgentTaskMessage,
	resolveAgentInit,
	type SlotOverrides,
} from '../agents/custom-agent';
import { TERMINAL_NODE_EXECUTION_STATUSES } from '../managers/node-execution-manager';
import { Logger } from '../../logger';
import { SpaceTaskManager } from '../managers/space-task-manager';
import type { ReportResultInput } from '../tools/task-agent-tool-schemas';
import { jsonResult } from '../tools/tool-result';

const log = new Logger('task-agent-manager');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TaskAgentManagerConfig {
	/** Custom Database wrapper — used to persist sessions */
	db: Database;
	/** SessionManager — used to delete sessions during cleanup */
	sessionManager: SessionManager;
	/** Reactive DB invalidation hooks for LiveQuery-backed task activity */
	reactiveDb?: ReactiveDatabase;
	/** Space manager — used to look up spaces */
	spaceManager: SpaceManager;
	/** Space agent manager — used to look up agents for context */
	spaceAgentManager: SpaceAgentManager;
	/** Workflow manager — used to load workflow definitions */
	spaceWorkflowManager: SpaceWorkflowManager;
	/** SpaceRuntimeService — provides access to WorkflowExecutors */
	spaceRuntimeService: SpaceRuntimeService;
	/** Task repository — direct DB reads */
	taskRepo: SpaceTaskRepository;
	/** Workflow run repository — reading and updating runs */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Gate data repository — for reading and writing gate runtime data in node agent tools */
	gateDataRepo: GateDataRepository;
	/** Channel cycle repository — for per-channel cycle tracking in cyclic workflows */
	channelCycleRepo: ChannelCycleRepository;
	/** DaemonHub — event bus for session state change subscriptions */
	daemonHub: DaemonHub;
	/** MessageHub — used to write SDK messages */
	messageHub: MessageHub;
	/** Factory function to get the API key at call time */
	getApiKey: () => Promise<string | null>;
	/** Default model ID for sessions that don't specify one */
	defaultModel: string;
	/**
	 * Application-level MCP lifecycle manager.
	 * When provided, registry-sourced MCP servers are merged into the Task Agent session's
	 * MCP map via setRuntimeMcpServers(). The in-process task-agent server takes precedence
	 * over registry entries on name collision.
	 */
	appMcpManager?: AppMcpLifecycleManager;
	/**
	 * Space worktree manager for creating and cleaning up task worktrees.
	 * When provided, each task gets its own isolated git worktree at run start.
	 * All sub-sessions (node agents) share the same worktree path as their workspace.
	 */
	worktreeManager?: SpaceWorktreeManager;
	/**
	 * Skills manager — injected into agent sessions so enabled skills (plugins and MCP servers)
	 * are available. `QueryOptionsBuilder.getMcpServersFromSkills()` uses this to merge enabled
	 * `mcp_server`-type skills into the SDK query options at session start.
	 *
	 * Note: `roomSkillOverrides` is NOT applicable to task agent sessions — task agents have no
	 * per-room override concept. Skills are either enabled globally or not.
	 */
	skillsManager: SkillsManager;
	/**
	 * App MCP server repository — used by QueryOptionsBuilder to resolve skills-based MCP configs
	 * (maps `AppSkill.config.appMcpServerId` → `AppMcpServer` entry for the SDK config).
	 */
	appMcpServerRepo: AppMcpServerRepository;
	/** Node execution repository — for CompletionDetector to query workflow-internal execution state */
	nodeExecutionRepo: NodeExecutionRepository;
	/** Absolute path to the SQLite database file. When provided, a space-scoped db-query MCP
	 * server is attached to each task agent session. */
	dbPath?: string;
	/** Workflow run artifact repository — for write_artifact / list_artifacts node agent tools */
	artifactRepo?: WorkflowRunArtifactRepository;
	/**
	 * Persistent queue of Task Agent → peer agent messages waiting for the target
	 * session to activate. When provided, `createSubSession` flushes all pending
	 * messages for the newly-activated agent (by name) and `send_message` can
	 * enqueue instead of failing when the target is declared but not yet active.
	 */
	pendingMessageRepo?: PendingAgentMessageRepository;
	/**
	 * Callback to inject a message into the Space Agent chat session for a space.
	 * Used for Task Agent → Space Agent escalation via `send_message`.
	 */
	spaceAgentInjector?: (spaceId: string, message: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Map of nodeId → all registered completion callbacks for that session */
type CompletionCallbackMap = Map<string, Array<() => Promise<void>>>;

interface SpawnTaskAgentOptions {
	/**
	 * Whether to inject the initial orchestration message immediately after spawn.
	 * `false` keeps the session idle until an explicit inbound message arrives.
	 */
	kickoff?: boolean;
}

// ---------------------------------------------------------------------------
// TaskAgentManager
// ---------------------------------------------------------------------------

export class TaskAgentManager {
	/**
	 * Maps taskId → AgentSession for active Task Agent sessions.
	 * One entry per task while the Task Agent is running.
	 */
	private taskAgentSessions = new Map<string, AgentSession>();

	/**
	 * Maps taskId → (nodeId → AgentSession) for sub-sessions.
	 * Sub-session IDs follow the convention:
	 *   `space:${spaceId}:task:${taskId}:node:${nodeId}`
	 */
	private subSessions = new Map<string, Map<string, AgentSession>>();

	/**
	 * Reverse index from sub-session agentSessionId → AgentSession.
	 * Used by cancelBySessionId() for O(1) lookup when the runtime needs
	 * to cancel a specific agent session by its NodeExecution.agentSessionId.
	 */
	private agentSessionIndex = new Map<string, AgentSession>();

	/**
	 * Tracks taskIds currently being spawned — prevents concurrent
	 * spawnTaskAgent() calls from creating duplicate Task Agent sessions.
	 */
	private spawningTasks = new Set<string>();

	/**
	 * Tracks node_execution IDs currently spawning a workflow-node session.
	 */
	private spawningExecutionIds = new Set<string>();

	/**
	 * Completion callbacks registered via onComplete().
	 * Key: session ID (of the sub-session).
	 * Value: list of callbacks to fire when the session goes idle.
	 */
	private completionCallbacks: CompletionCallbackMap = new Map();

	/**
	 * DaemonHub unsubscribe functions for session.updated listeners.
	 * Key: session ID.
	 */
	private sessionListeners = new Map<string, () => void>();

	/**
	 * Maps taskId → absolute worktree path for active tasks.
	 * Populated in spawnTaskAgent() after worktree creation.
	 * Used by createSubSessionFactory() to forward the worktree path to sub-sessions.
	 * Also populated during rehydrateTaskAgent() from the workflow run config.
	 */
	private taskWorktreePaths = new Map<string, string>();

	/**
	 * Maps taskId → db-query MCP server instance for active Task Agent sessions.
	 * Closed when the task agent session is cleaned up.
	 */
	private taskDbQueryServers = new Map<string, DbQueryMcpServer>();

	/**
	 * Unsubscribe function for the `space.task.updated` listener that triggers
	 * full session cleanup when a task reaches `archived` state.
	 * Populated on first cleanup subscription attempt; cleared in `cleanupAll()`.
	 */
	private taskArchiveListenerUnsub: (() => void) | null = null;

	constructor(private readonly config: TaskAgentManagerConfig) {
		this.subscribeToTaskArchiveEvents();
	}

	/**
	 * Subscribe to `space.task.updated` and run full cleanup for tasks that
	 * reach the `archived` state.
	 *
	 * `archived` is the only truly non-recoverable terminal state for a task —
	 * per issue #1515, node agent sessions must remain reachable (e.g. for
	 * cross-node `send_message` from a reviewer to a completed coder) for the
	 * full lifetime of the parent task run, and are only torn down when the
	 * task is archived.
	 */
	private subscribeToTaskArchiveEvents(): void {
		if (this.taskArchiveListenerUnsub) return;
		this.taskArchiveListenerUnsub = this.config.daemonHub.on('space.task.updated', (event) => {
			if (event.task?.status !== 'archived') return;
			const taskId = event.taskId;
			// Fire-and-forget — cleanup is idempotent and safe to skip on failure
			// (cleanupAll still sweeps leftovers on daemon shutdown).
			void this.cleanup(taskId, 'done').catch((err) => {
				log.warn(`TaskAgentManager: failed to clean up sessions for archived task ${taskId}:`, err);
			});
		});
	}

	// -------------------------------------------------------------------------
	// Public — Task Agent lifecycle
	// -------------------------------------------------------------------------

	/**
	 * Ensure a task has an attached Task Agent session.
	 *
	 * For standalone tasks opened directly in the UI, this provides a deterministic
	 * way to start the orchestration session on demand.
	 *
	 * Behavior:
	 * - If the task already has `taskAgentSessionId`, return the current task.
	 * - Otherwise spawn a Task Agent session and persist the session ID.
	 * - If the task was `pending`, promote it to `in_progress` once the session starts.
	 *
	 * Returns the latest task snapshot from the repository.
	 */
	async ensureTaskAgentSession(taskId: string): Promise<SpaceTask> {
		const initialTask = this.config.taskRepo.getTask(taskId);
		if (!initialTask) {
			throw new Error(`Task not found: ${taskId}`);
		}

		let task = initialTask;

		if (task.taskAgentSessionId) {
			const restored = await this.restoreTaskAgentFromPersistedSession(task);
			if (restored) {
				const refreshedTask = this.config.taskRepo.getTask(taskId);
				if (!refreshedTask) {
					throw new Error(`Task not found after restoring task agent session: ${taskId}`);
				}
				return refreshedTask;
			}

			log.warn(
				`TaskAgentManager.ensureTaskAgentSession: stale taskAgentSessionId "${task.taskAgentSessionId}" on task ${taskId}; clearing and respawning`
			);

			this.taskAgentSessions.delete(taskId);
			this.config.taskRepo.updateTask(taskId, { taskAgentSessionId: null });

			const refreshedTask = this.config.taskRepo.getTask(taskId);
			if (!refreshedTask) {
				throw new Error(`Failed to reload task after clearing stale session: ${taskId}`);
			}
			task = refreshedTask;
		}

		const space = await this.config.spaceManager.getSpace(task.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${task.spaceId}`);
		}

		const workflowRun = task.workflowRunId
			? this.config.workflowRunRepo.getRun(task.workflowRunId)
			: null;
		const workflow = workflowRun
			? this.config.spaceWorkflowManager.getWorkflow(workflowRun.workflowId)
			: null;

		await this.spawnTaskAgent(task, space, workflow ?? null, workflowRun ?? null, {
			kickoff: false,
		});

		if (task.status === 'open') {
			this.config.taskRepo.updateTask(taskId, { status: 'in_progress' });
		}

		const refreshed = this.config.taskRepo.getTask(taskId);
		if (!refreshed) {
			throw new Error(`Failed to reload task after starting Task Agent: ${taskId}`);
		}
		return refreshed;
	}

	/**
	 * Restore an in-memory Task Agent from a persisted session ID on the task.
	 *
	 * Returns true when a live in-memory session is available after this call.
	 */
	private async restoreTaskAgentFromPersistedSession(task: SpaceTask): Promise<boolean> {
		const sessionId = task.taskAgentSessionId;
		if (!sessionId) return false;

		// Already active in memory.
		const live = this.taskAgentSessions.get(task.id);
		if (live) return true;

		// No persisted session metadata means we cannot restore.
		const dbSession = this.config.db.getSession(sessionId) as { type?: string } | null;
		if (!dbSession) return false;
		const sessionType = dbSession.type;

		try {
			if (sessionType !== undefined && sessionType !== 'space_task_agent') {
				return false;
			}
			await this.rehydrateTaskAgent(task, sessionId);
		} catch (err) {
			log.warn(
				`TaskAgentManager: failed to restore persisted task-agent session ${sessionId} for task ${task.id}:`,
				err
			);
			return false;
		}

		return this.taskAgentSessions.has(task.id);
	}

	/**
	 * Spawn a Task Agent session for a SpaceTask.
	 *
	 * Idempotent: if a Task Agent session already exists for this task (or is
	 * currently being spawned), returns its session ID without creating another.
	 *
	 * Flow:
	 *   1. Concurrency guard + idempotency check
	 *   2. Generate session ID (with monotonic suffix on restart if ID collides in DB)
	 *   3. Create AgentSessionInit via createTaskAgentInit()
	 *   4. Create session via AgentSession.fromInit() → persists to DB
	 *   5. Create and attach Task Agent MCP server
	 *   6. Update SpaceTask.taskAgentSessionId
	 *   7. Start streaming query
	 *   8. Inject initial task context message
	 *   9. Store in taskAgentSessions, remove from spawningTasks
	 *
	 * @returns The session ID of the (possibly already-existing) Task Agent session.
	 */
	async spawnTaskAgent(
		task: SpaceTask,
		space: Space,
		workflow: SpaceWorkflow | null,
		workflowRun: SpaceWorkflowRun | null,
		options: SpawnTaskAgentOptions = {}
	): Promise<string> {
		const taskId = task.id;

		// --- Idempotency: already spawned
		const existing = this.taskAgentSessions.get(taskId);
		if (existing) {
			return existing.session.id;
		}

		// --- Concurrency guard: currently being spawned (tick loop race)
		if (this.spawningTasks.has(taskId)) {
			// Poll until the session appears — the concurrently running spawn will
			// complete shortly and add it to taskAgentSessions.
			const CONCURRENT_SPAWN_TIMEOUT_MS = 30_000;
			const deadline = Date.now() + CONCURRENT_SPAWN_TIMEOUT_MS;
			return new Promise((resolve, reject) => {
				const interval = setInterval(() => {
					const session = this.taskAgentSessions.get(taskId);
					if (session) {
						clearInterval(interval);
						resolve(session.session.id);
						return;
					}
					// Also stop if it's no longer spawning (spawn failed)
					if (!this.spawningTasks.has(taskId)) {
						clearInterval(interval);
						reject(
							new Error(`Concurrent spawn for task ${taskId} failed before session was created`)
						);
						return;
					}
					// Timeout guard — prevents indefinite polling if first spawn hangs
					if (Date.now() >= deadline) {
						clearInterval(interval);
						reject(
							new Error(
								`Concurrent spawn for task ${taskId} timed out after ${CONCURRENT_SPAWN_TIMEOUT_MS}ms`
							)
						);
					}
				}, 50);
			});
		}

		this.spawningTasks.add(taskId);

		try {
			// --- Generate session ID with collision avoidance on restart
			const spaceId = space.id;
			const baseSessionId = `space:${spaceId}:task:${taskId}`;
			const sessionId = this.resolveSessionId(baseSessionId);

			// --- Create task worktree (one per task, shared by all node agents).
			// Falls back to space.workspacePath when worktreeManager is not configured.
			let workspacePath = space.workspacePath;
			if (this.config.worktreeManager) {
				try {
					const result = await this.config.worktreeManager.createTaskWorktree(
						spaceId,
						taskId,
						task.title,
						task.taskNumber
					);
					workspacePath = result.path;
					this.taskWorktreePaths.set(taskId, result.path);
					log.info(
						`TaskAgentManager: created worktree for task ${taskId} at ${result.path} (slug: ${result.slug})`
					);

					// Worktree path is stored in-memory in taskWorktreePaths map.
					// Persisting to run config is no longer supported.
					void workflowRun;
				} catch (err) {
					log.warn(
						`TaskAgentManager: failed to create worktree for task ${taskId}, falling back to space workspace: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			// --- Create AgentSessionInit
			const init = createTaskAgentInit({
				task,
				space,
				workflow,
				workflowRun,
				sessionId,
				workspacePath,
			});

			// --- Create the session in DB via AgentSession.fromInit()
			const agentSession = AgentSession.fromInit(
				init,
				this.config.db,
				this.config.messageHub,
				this.config.daemonHub,
				this.config.getApiKey,
				this.config.defaultModel,
				this.config.skillsManager,
				this.config.appMcpServerRepo
			);

			// --- Build the SpaceTaskManager for this space (needed by tool handlers)
			const taskManager = new SpaceTaskManager(
				this.config.db.getDatabase(),
				spaceId,
				this.config.reactiveDb
			);

			// --- Build and attach MCP server with live runtime dependencies
			const workflowRunId = workflowRun?.id ?? '';

			const mcpServer = createTaskAgentMcpServer({
				taskId,
				space,
				workflowRunId,
				taskRepo: this.config.taskRepo,
				nodeExecutionRepo: this.config.nodeExecutionRepo,
				taskManager,
				messageInjector: (subSessionId, message) =>
					this.injectSubSessionMessage(subSessionId, message),
				daemonHub: this.config.daemonHub,
				gateDataRepo: this.config.gateDataRepo,
				workflowRunRepo: this.config.workflowRunRepo,
				workflowManager: this.config.spaceWorkflowManager,
				getSpaceAutonomyLevel: async (sid) => {
					const s = await this.config.spaceManager.getSpace(sid);
					return s?.autonomyLevel ?? 1;
				},
				myAgentName: 'task-agent',
				onGateChanged: (runId, gateId) => {
					void this.config.spaceRuntimeService.notifyGateDataChanged(runId, gateId).catch(() => {});
				},
				pendingMessageRepo: this.config.pendingMessageRepo,
				spaceAgentInjector: this.config.spaceAgentInjector,
				taskAgentManager: this,
			});

			// setRuntimeMcpServers expects McpServerConfig but the MCP SDK's `Server`
			// object is structurally compatible at runtime — the AgentSession only reads
			// the `server` property for the live Server instance. The cast is safe because
			// createTaskAgentMcpServer returns { server, cleanup } which satisfies the
			// runtime shape used inside AgentSession.setRuntimeMcpServers().
			//
			// Merge registry-sourced MCP servers from AppMcpLifecycleManager alongside the
			// in-process task-agent server. The task-agent server always wins on collision
			// since it provides the core orchestration tools required for task management.
			//
			// Note: task agent sessions are short-lived (one per task), so there is no
			// mcp.registry.changed subscription here. Registry changes during a running task
			// are not hot-reloaded; they take effect when the next task agent is spawned.
			const registryMcpServers = this.config.appMcpManager?.getEnabledMcpConfigs() ?? {};
			for (const name of Object.keys(registryMcpServers)) {
				if (name === 'task-agent') {
					log.warn(
						`Task agent session ${sessionId}: MCP server name collision on 'task-agent' — ` +
							`in-process task-agent server takes precedence over registry entry.`
					);
				}
			}
			const taskMcpServers: Record<string, McpServerConfig> = {
				...registryMcpServers,
				'task-agent': mcpServer as unknown as McpServerConfig,
			};
			// Create a space-scoped db-query server when dbPath is configured.
			if (this.config.dbPath) {
				const dbQueryServer = createDbQueryMcpServer({
					dbPath: this.config.dbPath,
					scopeType: 'space',
					scopeValue: spaceId,
				});
				this.taskDbQueryServers.set(taskId, dbQueryServer);
				taskMcpServers['db-query'] = dbQueryServer as unknown as McpServerConfig;
			}

			agentSession.setRuntimeMcpServers(taskMcpServers);

			// --- Persist taskAgentSessionId on the SpaceTask
			this.config.taskRepo.updateTask(taskId, { taskAgentSessionId: sessionId });

			// --- Store in map before streaming start to allow getTaskAgent() calls
			this.taskAgentSessions.set(taskId, agentSession);

			// --- Register in SessionManager cache so getSessionAsync() returns the live
			// instance with MCP tools attached rather than creating a duplicate from DB.
			// Without this, RPC handlers (message.send, message.sdkMessages, etc.) would
			// create a competing AgentSession with duplicate DaemonHub subscriptions.
			this.config.sessionManager.registerSession(agentSession);

			// --- Start streaming query
			await agentSession.startStreamingQuery();

			// --- Optional kickoff message
			// Event-driven mode can spawn the session in an idle state and let
			// explicit inbound messages (human/agent) wake orchestration.
			const shouldKickoff = options.kickoff ?? true;
			if (shouldKickoff) {
				const availableAgents = this.config.spaceAgentManager.listBySpaceId(spaceId);
				const initialMessage = buildTaskAgentInitialMessage({
					task,
					space,
					workflow: workflow ?? undefined,
					workflowRun: workflowRun ?? undefined,
					availableAgents,
				});
				await this.injectMessageIntoSession(agentSession, initialMessage);
			}

			log.info(`TaskAgentManager: spawned task agent for task ${taskId}, session ${sessionId}`);
			return sessionId;
		} catch (err) {
			// Remove from map if we added it prematurely
			this.taskAgentSessions.delete(taskId);
			throw err;
		} finally {
			this.spawningTasks.delete(taskId);
		}
	}

	/**
	 * Spawn a workflow node-agent session for a specific node_execution row.
	 *
	 * Unlike spawnTaskAgent(), this creates a workflow worker session directly
	 * (no Task Agent orchestration layer).
	 */
	async spawnWorkflowNodeAgentForExecution(
		task: SpaceTask,
		space: Space,
		workflow: SpaceWorkflow,
		workflowRun: SpaceWorkflowRun,
		execution: NodeExecution,
		options: SpawnTaskAgentOptions = {}
	): Promise<string> {
		if (execution.agentSessionId && this.agentSessionIndex.has(execution.agentSessionId)) {
			return execution.agentSessionId;
		}

		if (this.spawningExecutionIds.has(execution.id)) {
			const CONCURRENT_SPAWN_TIMEOUT_MS = 30_000;
			const deadline = Date.now() + CONCURRENT_SPAWN_TIMEOUT_MS;
			return new Promise((resolve, reject) => {
				const interval = setInterval(() => {
					const fresh = this.config.nodeExecutionRepo.getById(execution.id);
					if (fresh?.agentSessionId) {
						clearInterval(interval);
						resolve(fresh.agentSessionId);
						return;
					}
					if (!this.spawningExecutionIds.has(execution.id)) {
						clearInterval(interval);
						reject(
							new Error(
								`Concurrent spawn for execution ${execution.id} failed before session was created`
							)
						);
						return;
					}
					if (Date.now() >= deadline) {
						clearInterval(interval);
						reject(
							new Error(
								`Concurrent spawn for execution ${execution.id} timed out after ${CONCURRENT_SPAWN_TIMEOUT_MS}ms`
							)
						);
					}
				}, 50);
			});
		}

		this.spawningExecutionIds.add(execution.id);
		let spawnedSessionId: string | null = null;

		try {
			const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
			if (!node) {
				throw new Error(
					`Workflow node "${execution.workflowNodeId}" not found in workflow "${workflow.id}"`
				);
			}

			const nodeAgents = resolveNodeAgents(node);
			const slot =
				nodeAgents.length === 1
					? nodeAgents[0]
					: nodeAgents.find((agentSlot) => agentSlot.name === execution.agentName);
			if (!slot?.agentId) {
				throw new Error(
					`No agent slot found for agent name "${execution.agentName}" in node "${execution.workflowNodeId}"`
				);
			}

			const taskId = task.id;
			const baseSessionId = `space:${space.id}:task:${taskId}:exec:${execution.id}`;
			const sessionId = this.resolveSessionId(baseSessionId);

			let workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;
			if (!this.taskWorktreePaths.has(taskId) && this.config.worktreeManager) {
				try {
					const result = await this.config.worktreeManager.createTaskWorktree(
						space.id,
						taskId,
						task.title,
						task.taskNumber
					);
					workspacePath = result.path;
					this.taskWorktreePaths.set(taskId, result.path);
				} catch (err) {
					log.warn(
						`TaskAgentManager: failed to create worktree for workflow task ${taskId}, falling back to space workspace: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

			// Resolve customPrompt from the slot. Support legacy JSON blobs that may still
			// have the old `systemPrompt`/`instructions` shape from before migration 79.
			let slotCustomPrompt: string | undefined = slot.customPrompt?.value;
			if (!slotCustomPrompt) {
				// Backward compat: combine legacy systemPrompt + instructions into a single string.
				const legacySlot = slot as {
					systemPrompt?: { value: string };
					instructions?: { value: string };
				};
				const legacySp = legacySlot.systemPrompt?.value?.trim() ?? '';
				const legacyInstr = legacySlot.instructions?.value?.trim() ?? '';
				if (legacySp && legacyInstr) {
					slotCustomPrompt = `${legacySp}\n\n${legacyInstr}`;
				} else {
					slotCustomPrompt = legacySp || legacyInstr || undefined;
				}
			}
			const slotOverrides: SlotOverrides = {
				model: slot.model,
				customPrompt: slotCustomPrompt,
				disabledSkillIds: slot.disabledSkillIds,
				extraMcpServers: slot.extraMcpServers,
			};

			let init = resolveAgentInit({
				task,
				space,
				agentManager: this.config.spaceAgentManager,
				sessionId,
				workspacePath,
				workflowRun,
				workflow,
				slotOverrides,
				agentId: slot.agentId,
			});

			const shouldKickoff = options.kickoff ?? true;
			const customAgent = shouldKickoff
				? this.config.spaceAgentManager.getById(slot.agentId)
				: null;
			if (shouldKickoff && !customAgent) {
				throw new Error(`Agent not found: ${slot.agentId}`);
			}

			const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
				taskId,
				sessionId,
				execution.agentName,
				space.id,
				workflowRun.id,
				workspacePath,
				execution.workflowNodeId
			);
			init = {
				...init,
				mcpServers: {
					...init.mcpServers,
					'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
				},
			};

			const actualSessionId = await this.createSubSession(taskId, sessionId, init, {
				agentId: slot.agentId,
			});
			spawnedSessionId = actualSessionId;

			const spawned = this.getSubSession(actualSessionId);
			if (!spawned) {
				throw new Error(`Spawned node session ${actualSessionId} is not registered in memory`);
			}

			this.registerCompletionCallback(actualSessionId, async () => {
				await this.handleSubSessionComplete(taskId, execution.workflowNodeId, actualSessionId);
			});

			if (shouldKickoff) {
				const initialMessage = buildCustomAgentTaskMessage({
					customAgent: customAgent!,
					task,
					workflowRun,
					workflow,
					space,
					sessionId: actualSessionId,
					workspacePath,
					slotOverrides,
				});
				const runtimeContract = this.buildNodeExecutionRuntimeContract(workflow, execution);
				const kickoffMessage = runtimeContract
					? `${initialMessage}\n\n${runtimeContract}`
					: initialMessage;
				await this.injectMessageIntoSession(spawned, kickoffMessage);
			}

			return actualSessionId;
		} catch (err) {
			// Roll back partially-created sessions so executions do not get stuck as pending with a stale session.
			if (spawnedSessionId) {
				this.cancelBySessionId(spawnedSessionId);
			}
			throw err;
		} finally {
			this.spawningExecutionIds.delete(execution.id);
		}
	}

	/**
	 * Create a sub-session for a workflow node.
	 *
	 * Called internally from the SubSessionFactory.create() closure. Creates the
	 * session via AgentSession.fromInit() to ensure DB persistence. Registers the
	 * session in the subSessions map for fast lookup by taskId + nodeId.
	 *
	 * @param taskId    The parent task ID
	 * @param sessionId The session ID to use (generated by the tool handler)
	 * @param init      Session init config from resolveAgentInit()
	 * @returns The session ID of the created sub-session.
	 */
	async createSubSession(
		taskId: string,
		sessionId: string,
		init: AgentSessionInit,
		memberInfo?: SubSessionMemberInfo
	): Promise<string> {
		// --- Session reuse: if this agent already has a live session, reuse it.
		// Each named agent gets exactly one AgentSession per task lifetime; subsequent
		// node executions inject a new message into the existing session rather than
		// spawning a fresh one. Sessions are only torn down when the task is archived.
		// Primary state is in DB: query nodeExecutionRepo for the most recent session ID
		// for this agent, then check agentSessionIndex (fast path) or lazily rehydrate.
		if (memberInfo?.agentName) {
			const parentTask = this.config.taskRepo.getTask(taskId);
			if (parentTask?.workflowRunId) {
				const existingExecs = this.config.nodeExecutionRepo
					.listByWorkflowRun(parentTask.workflowRunId)
					.filter((e) => e.agentName === memberInfo.agentName && e.agentSessionId);
				// listByWorkflowRun returns rows ORDER BY created_at ASC, so .at(-1) is the most recent.
				const prevExec = existingExecs.at(-1);
				if (prevExec?.agentSessionId) {
					// Reuse existing session — get from memory or restore from DB
					const existing =
						this.agentSessionIndex.get(prevExec.agentSessionId) ??
						(await this.rehydrateSubSession(prevExec.agentSessionId));
					if (existing) {
						const existingSessionId = prevExec.agentSessionId;
						log.info(
							`TaskAgentManager: reusing session ${existingSessionId} for agent "${memberInfo.agentName}" (task ${taskId}); skipping new session ${sessionId}`
						);

						// Point the new NodeExecution at the existing session ID.
						if (memberInfo.nodeId) {
							const nodeExecs = this.config.nodeExecutionRepo.listByNode(
								parentTask.workflowRunId,
								memberInfo.nodeId
							);
							const match = nodeExecs.find(
								(e) => e.agentName === memberInfo.agentName && !e.agentSessionId
							);
							if (match) {
								this.config.nodeExecutionRepo.updateSessionId(match.id, existingSessionId);
							}
						}

						// Register a fresh completion callback for this execution turn.
						// Clear any stale callback registered by a previous execution (e.g. from
						// rehydrateSubSession, which registers with the old nodeId). Without this,
						// two callbacks would fire on the next idle: one for the old execution and
						// one for the new — causing a double NODE_COMPLETE notification.
						if (memberInfo.nodeId) {
							this.completionCallbacks.delete(existingSessionId);
							this.registerCompletionCallback(existingSessionId, async () => {
								await this.handleSubSessionComplete(taskId, memberInfo.nodeId!, existingSessionId);
							});
						}

						// Flush any pending messages for this agent.
						const runId = parentTask.workflowRunId;
						void this.flushPendingMessagesForTarget(
							runId,
							memberInfo.agentName,
							existingSessionId
						).catch((err) => {
							log.warn(
								`TaskAgentManager: flushPendingMessagesForTarget failed for ${memberInfo.agentName} (session ${existingSessionId}): ${err instanceof Error ? err.message : String(err)}`
							);
						});

						return existingSessionId;
					}
				}
			}
		}

		// --- First execution for this agent: create a new session.
		const subSession = AgentSession.fromInit(
			init,
			this.config.db,
			this.config.messageHub,
			this.config.daemonHub,
			this.config.getApiKey,
			this.config.defaultModel,
			this.config.skillsManager,
			this.config.appMcpServerRepo
		);

		// Inject registry-sourced MCP servers so sub-sessions have the same app-level MCP
		// access as the parent task agent session.
		//
		// IMPORTANT: preserve MCP servers already present in init.mcpServers (notably
		// the per-session node-agent server attached by spawnWorkflowNodeAgentForExecution).
		// setRuntimeMcpServers() replaces the in-memory map, so we must merge first.
		//
		// Precedence rule: init.mcpServers wins on key collisions so internal workflow
		// servers (e.g. 'node-agent') cannot be shadowed by registry entries.
		//
		// Note: skills-based MCP servers (from skillsManager) are injected separately at query
		// start time via QueryOptionsBuilder.getMcpServersFromSkills(), NOT via setRuntimeMcpServers.
		const subSessionRegistryMcpServers = this.config.appMcpManager?.getEnabledMcpConfigs() ?? {};
		const mergedSubSessionMcpServers = {
			...subSessionRegistryMcpServers,
			...init.mcpServers,
		};
		if (Object.keys(mergedSubSessionMcpServers).length > 0) {
			subSession.setRuntimeMcpServers(mergedSubSessionMcpServers);
		}

		// Determine node ID from session convention or task context.
		// The subSessions map uses the actual session ID as both the map key and session ID.
		// We store by session ID directly (not node ID) in the flat map for getProcessingState.
		if (!this.subSessions.has(taskId)) {
			this.subSessions.set(taskId, new Map());
		}
		this.subSessions.get(taskId)!.set(sessionId, subSession);
		this.agentSessionIndex.set(sessionId, subSession);

		// Register in SessionManager cache to prevent duplicate AgentSession creation.
		this.config.sessionManager.registerSession(subSession);

		// Write agent_session_id on the matching NodeExecution record so that
		// AgentMessageRouter, sibling cleanup, and live-query SQL can resolve
		// the session. Requires nodeId (workflowNodeId) and agentName.
		if (memberInfo?.nodeId && memberInfo.agentName) {
			const parentTask = this.config.taskRepo.getTask(taskId);
			if (parentTask?.workflowRunId) {
				const nodeExecs = this.config.nodeExecutionRepo.listByNode(
					parentTask.workflowRunId,
					memberInfo.nodeId
				);
				const match = nodeExecs.find((e) => e.agentName === memberInfo.agentName);
				if (match && !match.agentSessionId) {
					this.config.nodeExecutionRepo.updateSessionId(match.id, sessionId);
				} else if (match && match.agentSessionId) {
					log.warn(
						`TaskAgentManager: NodeExecution ${match.id} already has agentSessionId ${match.agentSessionId}; skipping update for new session ${sessionId}`
					);
				} else {
					log.warn(
						`TaskAgentManager: no matching NodeExecution found for (run=${parentTask.workflowRunId}, node=${memberInfo.nodeId}, agent=${memberInfo.agentName})`
					);
				}
			}
		}

		// Start streaming query for the sub-session
		await subSession.startStreamingQuery();

		// Flush any queued messages addressed to this agent name so that the
		// reopen/startup race doesn't drop Task Agent → node-agent messages.
		if (memberInfo?.agentName) {
			const parentTask = this.config.taskRepo.getTask(taskId);
			const runId = parentTask?.workflowRunId;
			if (runId) {
				void this.flushPendingMessagesForTarget(runId, memberInfo.agentName, sessionId).catch(
					(err) => {
						log.warn(
							`TaskAgentManager: flushPendingMessagesForTarget failed for ${memberInfo.agentName} (session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`
						);
					}
				);
			}
		}

		log.info(`TaskAgentManager: created sub-session ${sessionId} for task ${taskId}`);
		return sessionId;
	}

	/**
	 * Drain the pending-message queue for a specific target in a workflow run,
	 * delivering each pending message in FIFO order to the given session.
	 *
	 * Called immediately after `createSubSession()` activates a sub-session, and
	 * also invoked by rehydration paths after daemon restart. Safe to call
	 * repeatedly — rows already marked delivered/expired/failed are ignored.
	 *
	 * Expired rows are swept first so they're never delivered. Each successful
	 * injection calls `markDelivered`; each failure increments attempts via
	 * `markAttemptFailed` and the row stays pending until `max_attempts` is hit.
	 */
	async flushPendingMessagesForTarget(
		workflowRunId: string,
		targetAgentName: string,
		sessionId: string
	): Promise<void> {
		const repo = this.config.pendingMessageRepo;
		if (!repo) return;

		// Expire stale rows first so we don't deliver messages that have exceeded their TTL.
		repo.expireStale(workflowRunId);

		const pending = repo.listPendingForTarget(workflowRunId, targetAgentName);
		if (pending.length === 0) return;

		log.info(
			`TaskAgentManager: flushing ${pending.length} pending message(s) for agent=${targetAgentName} session=${sessionId}`
		);

		for (const row of pending) {
			const prefixed = `[Message from ${row.sourceAgentName}]: ${row.message}`;
			try {
				await this.injectSubSessionMessage(sessionId, prefixed);
				repo.markDelivered(row.id, sessionId);
				this.emitPendingDelivered(row.id, sessionId, row);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.warn(
					`TaskAgentManager: pending message ${row.id} delivery to ${sessionId} failed: ${errMsg}`
				);
				repo.markAttemptFailed(row.id, errMsg);
				// Keep going — a single per-row failure must not block the rest of the queue.
			}
		}
	}

	/**
	 * Drain the pending-message queue for the Space Agent target of a workflow run.
	 * Uses the configured `spaceAgentInjector`. Called after space chat session
	 * provisioning / rehydration so that Task Agent escalations survive restarts.
	 */
	async flushPendingMessagesForSpaceAgent(spaceId: string, workflowRunId: string): Promise<void> {
		const repo = this.config.pendingMessageRepo;
		const inject = this.config.spaceAgentInjector;
		if (!repo || !inject) return;

		repo.expireStale(workflowRunId);

		const pending = repo
			.listPendingForTarget(workflowRunId, 'space-agent')
			.filter((r) => r.targetKind === 'space_agent');
		if (pending.length === 0) return;

		const spaceChatSessionId = `space:chat:${spaceId}`;
		log.info(
			`TaskAgentManager: flushing ${pending.length} pending message(s) for Space Agent session=${spaceChatSessionId}`
		);

		for (const row of pending) {
			const prefixed = `[Message from ${row.sourceAgentName}]: ${row.message}`;
			try {
				await inject(spaceId, prefixed);
				repo.markDelivered(row.id, spaceChatSessionId);
				this.emitPendingDelivered(row.id, spaceChatSessionId, row);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.warn(`TaskAgentManager: Space Agent delivery for ${row.id} failed: ${errMsg}`);
				repo.markAttemptFailed(row.id, errMsg);
			}
		}
	}

	/** Emit observability event that a queued message was delivered. */
	private emitPendingDelivered(
		messageId: string,
		sessionId: string,
		row: { spaceId: string; workflowRunId: string; targetAgentName: string; targetKind: string }
	): void {
		if (!this.config.daemonHub) return;
		void this.config.daemonHub
			.emit('space.pendingMessage.delivered', {
				sessionId: 'global',
				spaceId: row.spaceId,
				workflowRunId: row.workflowRunId,
				targetAgentName: row.targetAgentName,
				targetKind: row.targetKind,
				messageId,
				deliveredSessionId: sessionId,
			})
			.catch(() => {});
	}

	// -------------------------------------------------------------------------
	// Public — message injection
	// -------------------------------------------------------------------------

	/**
	 * Inject a message into a Task Agent session.
	 * Used by Space Agent's `send_message_to_task` tool.
	 */
	async injectTaskAgentMessage(taskId: string, message: string): Promise<void> {
		let session = this.taskAgentSessions.get(taskId);
		if (!session) {
			const task = this.config.taskRepo.getTask(taskId);
			if (task?.taskAgentSessionId) {
				const restored = await this.restoreTaskAgentFromPersistedSession(task);
				if (restored) {
					session = this.taskAgentSessions.get(taskId);
				}
			}
		}
		if (!session) {
			throw new Error(`Task Agent session not found for task ${taskId}`);
		}
		// Human-initiated message — not synthetic. isSyntheticMessage=false so the
		// compact thread feed can distinguish this from agent→agent task injections.
		await this.injectMessageIntoSession(session, message, 'immediate', undefined, false);
	}

	/**
	 * Inject a message into a sub-session.
	 * Called by the Task Agent MCP tool handler via the messageInjector callback.
	 */
	async injectSubSessionMessage(subSessionId: string, message: string): Promise<void> {
		const indexed = this.agentSessionIndex.get(subSessionId);
		if (indexed) {
			await this.injectMessageIntoSession(indexed, message);
			return;
		}

		// Find the sub-session by ID across all task maps
		for (const [, nodeMap] of this.subSessions) {
			const session = nodeMap.get(subSessionId);
			if (session) {
				await this.injectMessageIntoSession(session, message);
				return;
			}
		}

		// Not in memory — attempt lazy rehydration from DB
		const rehydrated = await this.rehydrateSubSession(subSessionId);
		if (rehydrated) {
			await this.injectMessageIntoSession(rehydrated, message);
			return;
		}
		throw new Error(`Sub-session not found: ${subSessionId}`);
	}

	/**
	 * Find the live AgentSession for a named agent within a task.
	 *
	 * Queries NodeExecution records from DB to find the most recent agentSessionId
	 * for the given agent name, then returns the live session from agentSessionIndex
	 * (fast path) or lazily rehydrates it from DB (after daemon restart).
	 *
	 * Returns null if the agent has never been spawned for this task.
	 */
	async getSubSessionByAgentName(taskId: string, agentName: string): Promise<AgentSession | null> {
		const task = this.config.taskRepo.getTask(taskId);
		if (!task?.workflowRunId) return null;

		const executions = this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
		// Most recent execution for this agent that has a session ID assigned
		const exec = executions.filter((e) => e.agentName === agentName && e.agentSessionId).at(-1);
		if (!exec?.agentSessionId) return null;

		// Fast path: session already live in memory
		const cached = this.agentSessionIndex.get(exec.agentSessionId);
		if (cached) return cached;

		// Slow path: restore from DB (lazy rehydration — no explicit startup step needed)
		return this.rehydrateSubSession(exec.agentSessionId);
	}

	/**
	 * Return all agent names that have an assigned session in this task's workflow run.
	 * Used by the broadcast ('*') path in send_message.
	 * Reads from DB so it is correct after daemon restarts without any rehydration step.
	 */
	async getAgentNamesForTask(taskId: string): Promise<string[]> {
		const task = this.config.taskRepo.getTask(taskId);
		if (!task?.workflowRunId) return [];
		const executions = this.config.nodeExecutionRepo.listByWorkflowRun(task.workflowRunId);
		const names = new Set(executions.filter((e) => e.agentSessionId).map((e) => e.agentName));
		return [...names];
	}

	// -------------------------------------------------------------------------
	// Public — helpers / query methods
	// -------------------------------------------------------------------------

	/** Returns true if the given taskId is currently being spawned. */
	isSpawning(taskId: string): boolean {
		return this.spawningTasks.has(taskId);
	}

	/** Returns true if the given node execution is currently being spawned. */
	isExecutionSpawning(executionId: string): boolean {
		return this.spawningExecutionIds.has(executionId);
	}

	/** Returns true if a session ID maps to an alive in-memory agent session. */
	isSessionAlive(sessionId: string): boolean {
		const indexed = this.agentSessionIndex.get(sessionId);
		if (indexed) return this.isAgentSessionAlive(indexed);

		for (const taskAgent of this.taskAgentSessions.values()) {
			if (taskAgent.session.id === sessionId) {
				return this.isAgentSessionAlive(taskAgent);
			}
		}

		// Final check: if SessionManager still holds the live object, treat as alive.
		const session = this.config.sessionManager.getSession(sessionId);
		return session ? this.isAgentSessionAlive(session) : false;
	}

	/** Returns true if the Task Agent session for the given task is in a live state. */
	isTaskAgentAlive(taskId: string): boolean {
		const session = this.taskAgentSessions.get(taskId);
		return session ? this.isAgentSessionAlive(session) : false;
	}

	private isAgentSessionAlive(session: AgentSession): boolean {
		const state = session.getProcessingState();
		return (
			state.status === 'idle' ||
			state.status === 'queued' ||
			state.status === 'processing' ||
			state.status === 'waiting_for_input' ||
			state.status === 'interrupted'
		);
	}

	/**
	 * Returns the worktree path for a task, or undefined if no worktree was created.
	 * Useful for test assertions and M6 artifact RPCs.
	 */
	getTaskWorktreePath(taskId: string): string | undefined {
		return this.taskWorktreePaths.get(taskId);
	}

	/** Returns the Task Agent's AgentSession, or undefined if not spawned. */
	getTaskAgent(taskId: string): AgentSession | undefined {
		return this.taskAgentSessions.get(taskId);
	}

	/** Returns a sub-session by its session ID, or undefined if not found. */
	getSubSession(subSessionId: string): AgentSession | undefined {
		for (const [, nodeMap] of this.subSessions) {
			const session = nodeMap.get(subSessionId);
			if (session) return session;
		}
		return undefined;
	}

	// -------------------------------------------------------------------------
	// Public — cleanup
	// -------------------------------------------------------------------------

	/**
	 * Cancel a sub-session by its agent session ID.
	 *
	 * Used by SpaceRuntime to cancel sibling node agent sessions when the
	 * workflow run completes via end-node short-circuit. Looks up the
	 * session via the reverse index and interrupts it.
	 *
	 * No-op if the session is not found (already cleaned up or never registered).
	 */
	cancelBySessionId(agentSessionId: string): void {
		const session = this.agentSessionIndex.get(agentSessionId);
		if (!session) return;
		// Remove from reverse index immediately to prevent double-cancel
		// if cleanup(taskId) is called later for the same task.
		this.agentSessionIndex.delete(agentSessionId);
		void this.stopAndDeleteSession(agentSessionId, session).catch((err) => {
			log.warn(
				`TaskAgentManager.cancelBySessionId: failed to cancel session ${agentSessionId}:`,
				err
			);
		});
	}

	/**
	 * Interrupt a sub-session by its agent session ID WITHOUT deleting it.
	 *
	 * Unlike `cancelBySessionId`, this preserves the session in memory and in
	 * the DB, so it remains reachable via `send_message` / `injectSubSessionMessage`
	 * while the parent task is still active.
	 *
	 * Use this when the workflow run completes (end node fires) but the task
	 * is not yet `archived` — siblings should stop processing but remain
	 * messageable in case a downstream node needs to follow up (e.g. a reviewer
	 * sending feedback back to a coder whose node has already finished).
	 *
	 * No-op if the session is not found or is not in a state that can be interrupted.
	 */
	async interruptBySessionId(agentSessionId: string): Promise<void> {
		const session = this.agentSessionIndex.get(agentSessionId);
		if (!session) return;
		try {
			await session.handleInterrupt();
		} catch (err) {
			log.warn(
				`TaskAgentManager.interruptBySessionId: failed to interrupt session ${agentSessionId}:`,
				err
			);
		}
	}

	// -------------------------------------------------------------------------
	// Public — rehydration
	// -------------------------------------------------------------------------

	/**
	 * Rehydrate Task Agent sessions after a daemon restart.
	 *
	 * Queries `space_tasks` for tasks with status `in_progress` or `blocked`
	 * that have a non-null `taskAgentSessionId`. For each such task that has a
	 * `space_task_agent` session type in the DB, restores the Task Agent session via
	 * `AgentSession.restore()`, re-attaches the MCP server and system prompt,
	 * restarts the streaming query, and injects a re-orientation message so the
	 * agent resumes from where it left off.
	 *
	 * Sub-sessions are NOT fully rehydrated — the Task Agent will re-spawn them
	 * via its MCP tools after receiving the re-orientation message. The in-memory
	 * `subSessions` map is rebuilt from sub-session tasks found in the DB (so
	 * cleanup works correctly), but their streaming queries are not restarted.
	 *
	 * This method is called from `SpaceRuntime.rehydrateExecutors()` after
	 * WorkflowExecutors are loaded, so executors are ready when Task Agents run.
	 */
	async rehydrate(): Promise<void> {
		const activeTasks = this.config.taskRepo.listActiveWithTaskAgentSession();

		let attempted = 0;
		let failed = 0;

		for (const task of activeTasks) {
			const sessionId = task.taskAgentSessionId;
			if (!sessionId) continue;

			// Skip if already in the map (e.g. double rehydrate call)
			if (this.taskAgentSessions.has(task.id)) continue;

			const dbSession = this.config.db.getSession(sessionId);
			if (!dbSession) continue;
			if (dbSession.type !== 'space_task_agent') continue;

			attempted++;
			try {
				await this.rehydrateTaskAgent(task, sessionId);
			} catch (err) {
				failed++;
				log.warn(
					`TaskAgentManager.rehydrate: failed to rehydrate task ${task.id} (session ${sessionId}):`,
					err
				);
			}
		}

		const succeeded = attempted - failed;
		log.info(
			`TaskAgentManager.rehydrate: attempted=${attempted} succeeded=${succeeded} failed=${failed}`
		);
	}

	/**
	 * Stop and clean up all active Task Agent sessions and their sub-sessions.
	 * Called on daemon shutdown to release all resources.
	 */
	async cleanupAll(): Promise<void> {
		if (this.taskArchiveListenerUnsub) {
			this.taskArchiveListenerUnsub();
			this.taskArchiveListenerUnsub = null;
		}
		const taskIds = Array.from(this.taskAgentSessions.keys());
		await Promise.allSettled(taskIds.map((taskId) => this.cleanup(taskId)));
		log.info(`TaskAgentManager: cleanupAll complete (${taskIds.length} tasks cleaned up)`);
	}

	/**
	 * Stop and clean up all sessions for a task.
	 *
	 * Stops the Task Agent session and all sub-sessions, removes DB records
	 * via SessionManager.deleteSession(), and clears in-memory maps.
	 *
	 * @param taskId - The task to clean up.
	 * @param reason - 'cancelled': remove the worktree immediately.
	 *                 'completed' (default): mark the worktree as completed for TTL-based cleanup.
	 */
	async cleanup(taskId: string, reason: 'done' | 'cancelled' = 'done'): Promise<void> {
		// Collect the exact session IDs that belong to this task so that
		// the callback/listener cleanup in steps 3 & 4 uses precise matches
		// rather than a fragile substring check.
		const sessionIdsToClean = new Set<string>();

		// 1. Cleanup sub-sessions first
		const nodeMap = this.subSessions.get(taskId);
		if (nodeMap) {
			for (const [subSessionId, session] of nodeMap) {
				sessionIdsToClean.add(subSessionId);
				await this.stopAndDeleteSession(subSessionId, session);
			}
			this.subSessions.delete(taskId);
			// Clean up reverse index entries for all sub-sessions of this task
			for (const sid of sessionIdsToClean) {
				this.agentSessionIndex.delete(sid);
			}
		}

		// 2. Cleanup Task Agent session
		const taskAgentSession = this.taskAgentSessions.get(taskId);
		if (taskAgentSession) {
			const agentSessionId = taskAgentSession.session.id;
			sessionIdsToClean.add(agentSessionId);
			await this.stopAndDeleteSession(agentSessionId, taskAgentSession);
			this.taskAgentSessions.delete(taskId);
		}

		// 3. Remove any dangling completion callbacks for known session IDs.
		// We use the exact session IDs collected above (sub-sessions + task agent)
		// rather than a substring match to avoid false positives.
		for (const sessionId of sessionIdsToClean) {
			this.completionCallbacks.delete(sessionId);
		}

		// 4. Remove session listeners for known session IDs
		for (const sessionId of sessionIdsToClean) {
			const unsub = this.sessionListeners.get(sessionId);
			if (unsub) {
				unsub();
				this.sessionListeners.delete(sessionId);
			}
		}

		// 5. Worktree lifecycle: remove on cancellation, mark completed otherwise.
		if (this.config.worktreeManager) {
			const spaceId = this.config.taskRepo.getTask(taskId)?.spaceId;
			if (spaceId) {
				if (reason === 'cancelled') {
					try {
						await this.config.worktreeManager.removeTaskWorktree(spaceId, taskId);
						log.info(`TaskAgentManager: removed worktree for cancelled task ${taskId}`);
					} catch (err) {
						log.warn(
							`TaskAgentManager: failed to remove worktree for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
						);
					}
				} else {
					this.config.worktreeManager.markTaskWorktreeCompleted(spaceId, taskId);
					log.info(`TaskAgentManager: marked worktree completed for task ${taskId}`);
				}
			}
		}
		// Always remove from in-memory path map regardless of worktreeManager presence.
		this.taskWorktreePaths.delete(taskId);

		// Close db-query server connection for this task.
		const dbQueryServer = this.taskDbQueryServers.get(taskId);
		if (dbQueryServer) {
			try {
				dbQueryServer.close();
			} catch (err) {
				log.warn(`TaskAgentManager: failed to close db-query server for task ${taskId}:`, err);
			}
			this.taskDbQueryServers.delete(taskId);
		}

		log.info(`TaskAgentManager: cleaned up all sessions for task ${taskId} (reason: ${reason})`);
	}

	// -------------------------------------------------------------------------
	// Private — completion callbacks
	// -------------------------------------------------------------------------

	/**
	 * Register a completion callback for a sub-session.
	 * Subscribes to DaemonHub session.updated events for the session.
	 * The callback is called at most once when the session first goes idle.
	 * Also subscribes to session.error to mark the group member as 'failed'.
	 */
	registerCompletionCallback(subSessionId: string, callback: () => Promise<void>): void {
		// Add to callback list
		if (!this.completionCallbacks.has(subSessionId)) {
			this.completionCallbacks.set(subSessionId, []);
		}
		this.completionCallbacks.get(subSessionId)!.push(callback);

		// Only subscribe once per session
		if (this.sessionListeners.has(subSessionId)) return;

		// Track whether we've fired (to make callback fire exactly once)
		let fired = false;

		const unsubscribeUpdated = this.config.daemonHub.on(
			'session.updated',
			(event) => {
				if (fired) return;
				if (!event.processingState) return;
				const status = event.processingState.status;

				// Fire when session reaches idle — meaning it has completed its work
				if (status === 'idle') {
					const session = this.getSubSession(subSessionId);
					if (!session) return;

					// Only fire if the session has actually done some processing
					const sdkCount = session.getSDKMessageCount();
					if (sdkCount === 0) return; // Not started yet

					fired = true;
					// Unsubscribe immediately to prevent double-firing
					const unsub = this.sessionListeners.get(subSessionId);
					if (unsub) {
						unsub();
						this.sessionListeners.delete(subSessionId);
					}

					// Fire all registered callbacks
					const callbacks = this.completionCallbacks.get(subSessionId) ?? [];
					this.completionCallbacks.delete(subSessionId);
					for (const cb of callbacks) {
						cb().catch((err) => {
							log.error(
								`TaskAgentManager: completion callback error for session ${subSessionId}:`,
								err
							);
						});
					}
				}
			},
			{ sessionId: subSessionId }
		);

		// Subscribe to session.error to mark the session as fired so that a subsequent idle
		// transition does not overwrite the error state.
		// Also self-unsubscribes both listeners to prevent multiple invocations.
		const unsubscribeError = this.config.daemonHub.on(
			'session.error',
			(event) => {
				if (fired) return; // Already handled by completion path
				fired = true;

				// Push an explicit failure event back to the Task Agent so orchestration
				// stays event-driven (no polling loop required to discover crashes).
				void this.handleSubSessionError(subSessionId, event.error).catch((err) => {
					log.warn(
						`TaskAgentManager: failed to handle sub-session error for ${subSessionId}:`,
						err
					);
				});

				// Tear down both listeners now that the error terminal state is handled.
				const unsub = this.sessionListeners.get(subSessionId);
				if (unsub) {
					unsub();
					this.sessionListeners.delete(subSessionId);
				}
			},
			{ sessionId: subSessionId }
		);

		// Store a combined unsubscribe that tears down both listeners at once.
		this.sessionListeners.set(subSessionId, () => {
			unsubscribeUpdated();
			unsubscribeError();
		});
	}

	/**
	 * Called when a node agent sub-session completes (session goes idle).
	 *
	 * Automatically transitions the execution to `idle` when the agent's session
	 * finishes naturally — no explicit `report_result` call needed.
	 * Notifies the Task Agent (when present) about workflow node session completion.
	 */
	private async handleSubSessionComplete(
		taskId: string,
		nodeId: string,
		subSessionId: string
	): Promise<void> {
		log.info(
			`TaskAgentManager: sub-session complete — task ${taskId}, node ${nodeId}, session ${subSessionId}`
		);

		const workflowRunId = this.getWorkflowRunId(taskId);
		let execution = workflowRunId
			? this.config.nodeExecutionRepo
					.listByWorkflowRun(workflowRunId)
					.find((candidate) => candidate.agentSessionId === subSessionId)
			: null;

		// Auto-transition to idle when the session finishes while still in_progress.
		// This is the normal completion path — agents don't need to call a separate tool.
		if (execution && execution.status === 'in_progress') {
			this.config.nodeExecutionRepo.update(execution.id, { status: 'idle' });
			execution = this.config.nodeExecutionRepo.getById(execution.id);
		}

		const resolvedNodeId = execution?.workflowNodeId ?? nodeId;
		const resultSummary = execution?.result ? `\nAgent result summary: ${execution.result}` : '';

		// Notify the Task Agent that a sub-session has completed.
		const taskAgentSession = this.taskAgentSessions.get(taskId);
		if (taskAgentSession) {
			try {
				await this.injectMessageIntoSession(
					taskAgentSession,
					`[NODE_COMPLETE] Node "${resolvedNodeId}" sub-session (${subSessionId}) has completed.${resultSummary}\nUse this event for communication context only. Workflow progression is driven by Space Runtime and workflow agents.`,
					'defer'
				);
			} catch (err) {
				log.warn(
					`TaskAgentManager: failed to notify task agent of node completion for task ${taskId}:`,
					err
				);
			}
		}
	}

	/**
	 * Handle a sub-session error event and notify the parent Task Agent.
	 *
	 * This enables event-driven orchestration: Task Agent can react to failures
	 * without polling node status.
	 *
	 * Task-status cascade: marking the execution `blocked` here is picked up on
	 * the next runtime tick by `space-runtime.ts`'s blocked-execution detection,
	 * which transitions the canonical task to `status='blocked'` with
	 * `blockReason='execution_failed'`. End-node failures are surfaced the same
	 * way — there's no separate end-node-specific handler because any blocked
	 * execution that can't be auto-recovered (`attemptBlockedRunRecovery`)
	 * leaves the workflow stuck and needs human/agent intervention.
	 */
	private async handleSubSessionError(subSessionId: string, error: string): Promise<void> {
		const parentTaskId = this.findParentTaskIdForSubSession(subSessionId);
		if (!parentTaskId) return;

		const workflowRunId = this.getWorkflowRunId(parentTaskId);
		const failedExecution = workflowRunId
			? this.config.nodeExecutionRepo
					.listByWorkflowRun(workflowRunId)
					.find((candidate) => candidate.agentSessionId === subSessionId)
			: null;
		if (failedExecution && !TERMINAL_NODE_EXECUTION_STATUSES.has(failedExecution.status)) {
			this.config.nodeExecutionRepo.update(failedExecution.id, {
				status: 'blocked',
				result: error,
			});
		}

		const taskAgentSession = this.taskAgentSessions.get(parentTaskId);
		if (!taskAgentSession) return;

		const failedNodeId = failedExecution?.workflowNodeId ?? 'unknown-node';
		await this.injectMessageIntoSession(
			taskAgentSession,
			`[NODE_FAILED] Node "${failedNodeId}" sub-session (${subSessionId}) reported an error: ${error}\nWorkflow progression is runtime-driven; use this as context for human coordination only.`,
			'defer'
		);
	}

	/**
	 * Build a runtime contract for a specific node execution from the current
	 * workflow graph, including gate requirements derived from outbound channels.
	 */
	private buildNodeExecutionRuntimeContract(
		workflow: SpaceWorkflow | null,
		execution: NodeExecution
	): string {
		const isEndNode = !!workflow?.endNodeId && execution.workflowNodeId === workflow.endNodeId;

		const fallback = [
			'## Runtime Execution Contract',
			`Role: "${execution.agentName}"`,
			'Tools available:',
			'  - send_message({ target, message, data? }) — communicate with peers; data is automatically written to the gate when the channel is gated',
			'  - save({ summary?, data? }) — persist your output at any time (call multiple times as needed)',
			isEndNode
				? '  - report_result({ status, summary }) — YOU ARE THE END NODE: call this when the workflow is complete to close the run'
				: null,
			'Only contact the task-agent via send_message if you are blocked or need human input.',
		]
			.filter(Boolean)
			.join('\n');

		if (!workflow) {
			return fallback;
		}

		const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
		if (!node) {
			return fallback;
		}

		const fromRefs = new Set<string>([
			execution.agentName,
			node.name,
			node.id,
			`${node.id}/${execution.agentName}`,
		]);

		const outboundGatedChannels = (workflow.channels ?? []).filter(
			(channel) => !!channel.gateId && (channel.from === '*' || fromRefs.has(channel.from))
		);

		const lines: string[] = [
			'## Runtime Execution Contract',
			`Node: "${node.name}" (${node.id})`,
			`Agent: "${execution.agentName}"`,
			'Tools available:',
			'  - send_message({ target, message, data? }) — communicate with peers; when a channel is gated, `data` is automatically merged into the gate',
			'  - save({ summary?, data? }) — persist your output (summary text and/or structured data like pr_url)',
		];

		if (isEndNode) {
			lines.push(
				'  - report_result({ status, summary }) — YOU ARE THE END NODE: call this when the workflow is complete'
			);
		}

		lines.push(
			'  - list_peers / list_reachable_agents / list_channels / list_gates / read_gate — discovery'
		);

		if (outboundGatedChannels.length === 0) {
			lines.push('No outbound gated channels are currently mapped from this agent/node.');
		} else {
			const gateById = new Map((workflow.gates ?? []).map((gate) => [gate.id, gate]));
			const agentNameAliases = this.buildAgentNameAliasesForExecution(workflow, execution);
			lines.push('Outbound gated channels (data in send_message satisfies these gates):');

			for (const channel of outboundGatedChannels) {
				const gateId = channel.gateId!;
				const target = Array.isArray(channel.to) ? channel.to.join(', ') : channel.to;
				lines.push(`- Gate "${gateId}" for channel "${channel.from}" -> "${target}"`);

				const gate = gateById.get(gateId);
				if (!gate) {
					lines.push('  - Gate definition not found in workflow (treat as blocked until fixed).');
					continue;
				}

				const writableFields = (gate.fields ?? []).filter((field) =>
					this.isWriterAuthorizedForAgentNameAliases(field.writers, agentNameAliases)
				);
				if (writableFields.length === 0) {
					const aliasSuffix =
						agentNameAliases.length > 1 ? ` (aliases: ${agentNameAliases.join(', ')})` : '';
					lines.push(
						`  - No gate fields are writable by agent "${execution.agentName}"${aliasSuffix}; ensure required artifacts/checks are ready.`
					);
					continue;
				}

				lines.push(`  - Include in send_message data:`);
				for (const field of writableFields) {
					lines.push(
						`    • ${field.name} (${field.type}) — check: ${this.describeGateCheck(field.check)}`
					);
				}
			}
		}

		lines.push(
			'Only contact the task-agent via send_message if you are blocked or need human input.'
		);
		if (isEndNode) {
			lines.push(
				'When your work is complete, call report_result({ status: "done", summary: "..." }) to close the workflow run.'
			);
		}
		return lines.join('\n');
	}

	private describeGateCheck(check: {
		op: string;
		value?: unknown;
		match?: unknown;
		min?: number;
	}): string {
		if (check.op === 'exists') return 'exists';
		if (check.op === 'count') {
			return `count(${JSON.stringify(check.match)}) >= ${check.min ?? 0}`;
		}
		if (check.op === '==') return `== ${JSON.stringify(check.value)}`;
		if (check.op === '!=') return `!= ${JSON.stringify(check.value)}`;
		return check.op;
	}

	private normalizeAgentNameToken(value: string): string {
		return value.trim().toLowerCase();
	}

	private agentNameVariants(value: string): string[] {
		const trimmed = value.trim();
		if (!trimmed) return [];
		const variants = new Set<string>([trimmed]);
		const kebab = trimmed
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		if (kebab) variants.add(kebab);
		return [...variants];
	}

	private buildAgentNameAliasesForExecution(
		workflow: SpaceWorkflow | null,
		execution: NodeExecution
	): string[] {
		const aliases = new Set<string>(this.agentNameVariants(execution.agentName));
		if (!workflow) return [...aliases];

		const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
		if (!node) return [...aliases];

		const nodeAgents = resolveNodeAgents(node);
		const slot =
			nodeAgents.find((agent) => agent.name === execution.agentName) ??
			(execution.agentId
				? nodeAgents.find((agent) => agent.agentId === execution.agentId)
				: undefined);
		if (slot?.name) {
			for (const variant of this.agentNameVariants(slot.name)) {
				aliases.add(variant);
			}
		}

		const spaceAgentId = execution.agentId ?? slot?.agentId;
		if (spaceAgentId) {
			const spaceAgent = this.config.spaceAgentManager.getById(spaceAgentId);
			if (spaceAgent?.name) {
				for (const variant of this.agentNameVariants(spaceAgent.name)) {
					aliases.add(variant);
				}
			}
		}

		return [...aliases];
	}

	private isWriterAuthorizedForAgentNameAliases(
		writers: string[],
		agentNameAliases: string[]
	): boolean {
		const normalizedAliases = new Set(
			agentNameAliases
				.map((alias) => this.normalizeAgentNameToken(alias))
				.filter((alias) => alias.length > 0)
		);
		return writers.some((writer) => {
			const normalizedWriter = this.normalizeAgentNameToken(writer);
			return normalizedWriter === '*' || normalizedAliases.has(normalizedWriter);
		});
	}

	// -------------------------------------------------------------------------
	// Private — session creation helpers
	// -------------------------------------------------------------------------

	/**
	 * Resolve a session ID that does not already exist in the DB.
	 * If the base ID exists (e.g., from a previous crashed attempt), appends a
	 * monotonic suffix until an unused ID is found.
	 */
	private resolveSessionId(baseId: string): string {
		// Check if base ID is already free
		if (!this.config.db.getSession(baseId)) {
			return baseId;
		}

		// Append monotonic suffix starting from 1; cap at 100 to avoid an
		// unbounded loop if the DB is in an unexpected state.
		const MAX_ATTEMPTS = 100;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const candidateId = `${baseId}:${attempt}`;
			if (!this.config.db.getSession(candidateId)) {
				return candidateId;
			}
		}
		throw new Error(
			`Could not find available session ID for base "${baseId}" after ${MAX_ATTEMPTS} attempts`
		);
	}

	/**
	 * Rehydrate a single Task Agent session after daemon restart.
	 *
	 * 1. Loads the associated Space, Workflow, and WorkflowRun from the DB.
	 * 2. Restores the AgentSession via `AgentSession.restore()` — the session
	 *    already exists in the DB; `restore()` skips fingerprint comparison and
	 *    avoids any risk of invalidating `sdkSessionId` across restarts.
	 * 3. Re-attaches MCP server and system prompt (runtime-only, not persisted).
	 * 4. Adds the session to `taskAgentSessions` before streaming starts.
	 * 5. Restarts the streaming query so the SDK resumes from conversation history.
	 * 6. Injects a re-orientation message so the agent checks its current state and
	 *    continues from where it left off.
	 * 7. Rebuilds the `subSessions` map from node tasks in the same workflow run.
	 */
	private async rehydrateTaskAgent(task: SpaceTask, sessionId: string): Promise<void> {
		const taskId = task.id;
		const spaceId = task.spaceId;

		// --- Load Space
		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space) {
			log.warn(
				`TaskAgentManager.rehydrate: space ${spaceId} not found for task ${taskId}, skipping`
			);
			return;
		}

		// --- Load Workflow and WorkflowRun (if applicable)
		let workflow: SpaceWorkflow | null = null;
		let workflowRun: SpaceWorkflowRun | null = null;
		if (task.workflowRunId) {
			workflowRun = this.config.workflowRunRepo.getRun(task.workflowRunId);
			if (workflowRun) {
				workflow = this.config.spaceWorkflowManager.getWorkflow(workflowRun.workflowId);
			}
		}

		// --- Restore the existing AgentSession from DB via restore().
		// restore() is the correct path for daemon-restart rehydration of an already-persisted
		// session: it skips fingerprint comparison and avoids invalidating sdkSessionId
		// (which would break conversation continuity for tasks resuming mid-execution).
		const agentSession = AgentSession.restore(
			sessionId,
			this.config.db,
			this.config.messageHub,
			this.config.daemonHub,
			this.config.getApiKey,
			this.config.skillsManager,
			this.config.appMcpServerRepo
		);
		if (!agentSession) {
			log.warn(
				`TaskAgentManager.rehydrate: session ${sessionId} not found in DB for task ${taskId}, skipping`
			);
			return;
		}

		// --- Restore worktree path from SpaceWorktreeRepository (persisted at spawn time).
		// Only restores the path when the worktree directory still exists on disk —
		// if the directory was deleted between restarts (manual cleanup, disk failure),
		// fall back to space.workspacePath to avoid directing sub-sessions at a
		// non-existent location.
		const rehydrateWorkspacePath = await (async () => {
			if (!this.config.worktreeManager) {
				return space.workspacePath;
			}
			const storedPath = await this.config.worktreeManager.getTaskWorktreePath(spaceId, taskId);
			if (storedPath && existsSync(storedPath)) {
				this.taskWorktreePaths.set(taskId, storedPath);
				return storedPath;
			}
			if (storedPath) {
				log.warn(
					`TaskAgentManager.rehydrate: worktree path ${storedPath} no longer exists on disk for task ${taskId} — falling back to space workspace`
				);
			}
			return space.workspacePath;
		})();

		// --- Build the SpaceTaskManager for this space
		const taskManager = new SpaceTaskManager(
			this.config.db.getDatabase(),
			spaceId,
			this.config.reactiveDb
		);

		// --- Build and attach MCP server (runtime-only, not persisted)
		const rehydrateWorkflowRunId = workflowRun?.id ?? '';

		const mcpServer = createTaskAgentMcpServer({
			taskId,
			space,
			workflowRunId: rehydrateWorkflowRunId,
			taskRepo: this.config.taskRepo,
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			taskManager,
			messageInjector: (subSessionId, message) =>
				this.injectSubSessionMessage(subSessionId, message),
			daemonHub: this.config.daemonHub,
			gateDataRepo: this.config.gateDataRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			workflowManager: this.config.spaceWorkflowManager,
			getSpaceAutonomyLevel: async (sid) => {
				const s = await this.config.spaceManager.getSpace(sid);
				return s?.autonomyLevel ?? 1;
			},
			myAgentName: 'task-agent',
			onGateChanged: (runId, gateId) => {
				void this.config.spaceRuntimeService.notifyGateDataChanged(runId, gateId).catch(() => {});
			},
			pendingMessageRepo: this.config.pendingMessageRepo,
			spaceAgentInjector: this.config.spaceAgentInjector,
			taskAgentManager: this,
		});

		// Merge registry-sourced MCP servers alongside the in-process task-agent server,
		// mirroring the same logic in spawnTaskAgent() so rehydrated sessions have the
		// same MCP configuration as freshly spawned ones.
		const rehydrateRegistryMcpServers = this.config.appMcpManager?.getEnabledMcpConfigs() ?? {};
		for (const name of Object.keys(rehydrateRegistryMcpServers)) {
			if (name === 'task-agent') {
				log.warn(
					`Rehydrating task agent session ${sessionId}: MCP server name collision on 'task-agent' — ` +
						`in-process task-agent server takes precedence over registry entry.`
				);
			}
		}
		const rehydrateMcpServers: Record<string, McpServerConfig> = {
			...rehydrateRegistryMcpServers,
			'task-agent': mcpServer as unknown as McpServerConfig,
		};
		// Create a space-scoped db-query server when dbPath is configured.
		if (this.config.dbPath) {
			const rehydrateDbQueryServer = createDbQueryMcpServer({
				dbPath: this.config.dbPath,
				scopeType: 'space',
				scopeValue: spaceId,
			});
			// Close any stale server for this taskId before storing the new one.
			const staleDbQueryServer = this.taskDbQueryServers.get(taskId);
			if (staleDbQueryServer) {
				try {
					staleDbQueryServer.close();
				} catch (err) {
					log.warn(
						`Failed to close stale db-query server during rehydration for task ${taskId}:`,
						err
					);
				}
			}
			this.taskDbQueryServers.set(taskId, rehydrateDbQueryServer);
			rehydrateMcpServers['db-query'] = rehydrateDbQueryServer as unknown as McpServerConfig;
		}

		agentSession.setRuntimeMcpServers(rehydrateMcpServers);

		// Re-attach system prompt (runtime-only, not persisted).
		// Generated fresh from createTaskAgentInit() so it reflects the current task/workflow state.
		const init = createTaskAgentInit({
			task,
			space,
			workflow,
			workflowRun,
			sessionId,
			workspacePath: rehydrateWorkspacePath,
		});
		if (init.systemPrompt) {
			agentSession.setRuntimeSystemPrompt(init.systemPrompt);
		}

		// --- Store in map before streaming start
		this.taskAgentSessions.set(taskId, agentSession);

		// --- Restart the streaming query (SDK resumes from conversation history in DB)
		await agentSession.startStreamingQuery();

		// --- Inject re-orientation message so the agent checks state and continues.
		const reorientMessage = task.workflowRunId
			? 'You are resuming after a daemon restart. Your previous conversation state has been restored. ' +
				'Please review recent [NODE_*] event messages and continue orchestration in event-driven mode.'
			: 'You are resuming after a daemon restart. Your previous conversation state has been restored. ' +
				'Please check the current task status and continue from where you left off.';
		await this.injectMessageIntoSession(agentSession, reorientMessage);

		log.info(
			`TaskAgentManager.rehydrate: rehydrated task agent for task ${taskId} (session ${sessionId})`
		);
	}

	/**
	 * Lazily rehydrate a node-agent sub-session from DB when a message arrives for
	 * a session that is no longer in the in-memory maps (e.g., after a daemon restart).
	 *
	 * Steps:
	 * 1. Look up the NodeExecution by agentSessionId.
	 * 2. Find the parent SpaceTask via the execution's workflowRunId.
	 * 3. Load Space, WorkflowRun, and Workflow from DB.
	 * 4. Restore the AgentSession from DB via AgentSession.restore().
	 * 5. Re-inject the node-agent MCP server (runtime-only, not persisted).
	 * 6. Register the session in in-memory maps and SessionManager.
	 * 7. Register a completion callback so handleSubSessionComplete fires normally.
	 * 8. Restart the streaming query (idempotent if already running).
	 *
	 * Returns the rehydrated AgentSession, or null if the session cannot be found
	 * in the DB or its parent context is missing.
	 */
	private async rehydrateSubSession(subSessionId: string): Promise<AgentSession | null> {
		log.warn(`TaskAgentManager: rehydrating ghost sub-session ${subSessionId} from DB...`);

		// --- Look up the NodeExecution by agentSessionId
		const execution = this.config.nodeExecutionRepo.getByAgentSessionId(subSessionId);
		if (!execution) {
			log.warn(
				`TaskAgentManager.rehydrateSubSession: no NodeExecution found with agentSessionId=${subSessionId}`
			);
			return null;
		}

		// --- Find the parent SpaceTask via workflowRunId
		const tasks = this.config.taskRepo.listByWorkflowRun(execution.workflowRunId);
		// The parent task is the one that owns the workflow run (not a sub-task created by it).
		// We identify it by having a task_agent_session_id set (the orchestrating task agent).
		// Fall back to the first task in the run if none has a task agent session.
		const parentTask = tasks.find((t) => t.taskAgentSessionId != null) ?? tasks[0] ?? null;
		if (!parentTask) {
			log.warn(
				`TaskAgentManager.rehydrateSubSession: no parent task found for workflowRunId=${execution.workflowRunId}`
			);
			return null;
		}

		const taskId = parentTask.id;
		const spaceId = parentTask.spaceId;

		// --- Load Space
		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space) {
			log.warn(
				`TaskAgentManager.rehydrateSubSession: space ${spaceId} not found for task ${taskId}`
			);
			return null;
		}

		// --- Load WorkflowRun and Workflow
		const workflowRun = this.config.workflowRunRepo.getRun(execution.workflowRunId);
		const workflow = workflowRun?.workflowId
			? this.config.spaceWorkflowManager.getWorkflow(workflowRun.workflowId)
			: null;
		const workflowRunId = execution.workflowRunId;

		// --- Restore the AgentSession from DB
		const agentSession = AgentSession.restore(
			subSessionId,
			this.config.db,
			this.config.messageHub,
			this.config.daemonHub,
			this.config.getApiKey,
			this.config.skillsManager,
			this.config.appMcpServerRepo
		);
		if (!agentSession) {
			log.warn(
				`TaskAgentManager.rehydrateSubSession: AgentSession.restore() returned null for ${subSessionId} — session not in DB`
			);
			return null;
		}

		// --- Determine workspace path
		const workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;

		// --- Re-build and attach node-agent MCP server (runtime-only, not persisted)
		const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
			taskId,
			subSessionId,
			execution.agentName,
			spaceId,
			workflowRunId,
			workspacePath,
			execution.workflowNodeId
		);

		// Merge registry-sourced MCP servers, letting node-agent server take precedence.
		const registryMcpServers = this.config.appMcpManager?.getEnabledMcpConfigs() ?? {};
		const mergedMcpServers: Record<string, McpServerConfig> = {
			...registryMcpServers,
			'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
		};
		agentSession.setRuntimeMcpServers(mergedMcpServers);

		// --- Register in in-memory maps
		if (!this.subSessions.has(taskId)) {
			this.subSessions.set(taskId, new Map());
		}
		this.subSessions.get(taskId)!.set(subSessionId, agentSession);
		this.agentSessionIndex.set(subSessionId, agentSession);

		// --- Register in SessionManager cache to prevent duplicate AgentSession creation
		this.config.sessionManager.registerSession(agentSession);

		// --- Register completion callback so the workflow continues normally after this turn
		this.registerCompletionCallback(subSessionId, async () => {
			await this.handleSubSessionComplete(taskId, execution.workflowNodeId, subSessionId);
		});

		// --- Restart the streaming query (idempotent if already running)
		await agentSession.startStreamingQuery();

		// Flush any pending Task Agent → this agent messages that accumulated while
		// the sub-session was not alive in memory.
		void this.flushPendingMessagesForTarget(workflowRunId, execution.agentName, subSessionId).catch(
			(err) => {
				log.warn(
					`TaskAgentManager.rehydrateSubSession: flushPendingMessagesForTarget failed for ${execution.agentName} (session ${subSessionId}): ${err instanceof Error ? err.message : String(err)}`
				);
			}
		);

		log.info(
			`TaskAgentManager.rehydrateSubSession: rehydrated sub-session ${subSessionId} for task ${taskId} (node ${execution.workflowNodeId})`
		);

		void workflow; // Loaded for context but not needed directly; suppresses unused-var lint.
		return agentSession;
	}

	// -------------------------------------------------------------------------
	// Private — message injection
	// -------------------------------------------------------------------------

	/**
	 * Inject a plain-text message into an AgentSession.
	 * Uses the same pattern as RoomRuntimeService.injectMessage().
	 */
	private async injectMessageIntoSession(
		session: AgentSession,
		message: string,
		deliveryMode: 'immediate' | 'defer' = 'immediate',
		origin?: MessageOrigin,
		isSyntheticMessage = true
	): Promise<void> {
		const sessionId = session.session.id;
		const state = session.getProcessingState();
		// 'processing'/'queued' = actively running; 'waiting_for_input' = human gate open;
		// 'interrupted' = the current turn was interrupted but the session is still alive.
		// All four states mean a defer message cannot be safely delivered right now —
		// defer it for replay after the current interaction resolves.
		//
		// Note on 'interrupted': an interrupted session CAN accept a new immediate
		// message (ensureQueryStarted restarts the query), so only defer delivery is
		// deferred. This matches the pattern for 'processing'/'queued': the message is
		// persisted as deferred and replayed once the session becomes idle.
		const isBusy =
			state.status === 'processing' ||
			state.status === 'queued' ||
			state.status === 'waiting_for_input' ||
			state.status === 'interrupted';

		const messageId = generateUUID();
		const sdkUserMessage: SDKUserMessage & { isSynthetic: boolean } = {
			type: 'user' as const,
			uuid: messageId as UUID,
			session_id: sessionId,
			parent_tool_use_id: null,
			isSynthetic: isSyntheticMessage,
			message: {
				role: 'user' as const,
				content: [{ type: 'text' as const, text: message }],
			},
		};

		// defer + busy → persist as deferred for replay after current turn completes
		if (deliveryMode === 'defer' && isBusy) {
			this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'deferred', origin);
			return;
		}

		await session.ensureQueryStarted();
		this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued', origin);
		await session.messageQueue.enqueueWithId(messageId, message);
	}

	// -------------------------------------------------------------------------
	// Private — session cleanup helpers
	// -------------------------------------------------------------------------

	/**
	 * Interrupt and clean up a session, then delete its DB record.
	 */
	private async stopAndDeleteSession(sessionId: string, session: AgentSession): Promise<void> {
		// Unsubscribe any completion listeners first
		const unsub = this.sessionListeners.get(sessionId);
		if (unsub) {
			unsub();
			this.sessionListeners.delete(sessionId);
		}
		this.completionCallbacks.delete(sessionId);

		try {
			await session.handleInterrupt();
		} catch (err) {
			log.warn(`TaskAgentManager: failed to interrupt session ${sessionId}:`, err);
		}

		try {
			await session.cleanup();
		} catch (err) {
			log.warn(`TaskAgentManager: failed to cleanup session ${sessionId}:`, err);
		}

		// Remove DB record via SessionManager
		try {
			await this.config.sessionManager.deleteSession(sessionId);
		} catch (err) {
			log.warn(`TaskAgentManager: failed to delete session record ${sessionId}:`, err);
		}
	}

	// -------------------------------------------------------------------------
	// Private — utility lookups
	// -------------------------------------------------------------------------

	/** Returns the workflow run ID for a task by looking it up in the task repo. */
	private getWorkflowRunId(taskId: string): string | null {
		const task = this.config.taskRepo.getTask(taskId);
		return task?.workflowRunId ?? null;
	}

	/**
	 * Resolve the parent task ID that owns a given sub-session ID.
	 */
	private findParentTaskIdForSubSession(subSessionId: string): string | null {
		for (const [taskId, nodeMap] of this.subSessions) {
			if (nodeMap.has(subSessionId)) {
				return taskId;
			}
		}
		return null;
	}

	/**
	 * Build a node agent MCP server for a newly spawned sub-session.
	 * Called from the `buildNodeAgentMcpServer` callback passed to createTaskAgentMcpServer().
	 *
	 * Creates a ChannelResolver from the workflow run's config at spawn time and injects
	 * it directly into the node agent MCP server config. This avoids a per-call DB lookup
	 * and ensures each sub-session has its own resolver scoped to the channels declared
	 * at node-start (stored in the run config by SpaceRuntime.storeResolvedChannels()).
	 *
	 * The server gives the node agent peer communication tools (list_peers, send_message,
	 * report_result) that are scoped to its group, channel topology, and node task.
	 */
	private buildNodeAgentMcpServerForSession(
		taskId: string,
		subSessionId: string,
		agentName: string,
		spaceId: string,
		workflowRunId: string,
		workspacePath: string,
		workflowNodeIdHint?: string
	) {
		const nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
		const bySession = nodeExecutions.find((exec) => exec.agentSessionId === subSessionId);
		const byAgentName = nodeExecutions.find((exec) => exec.agentName === agentName);
		const execution = bySession ?? byAgentName;
		const workflowNodeId = workflowNodeIdHint ?? execution?.workflowNodeId ?? '';
		const run = this.config.workflowRunRepo.getRun(workflowRunId);
		const workflow = run?.workflowId
			? (this.config.spaceWorkflowManager.getWorkflow(run.workflowId) ?? null)
			: null;
		const channels = workflow?.channels ?? [];
		const channelResolver = new ChannelResolver(channels);

		const nodeGroups = workflow
			? Object.fromEntries(
					workflow.nodes.map((node) => [
						node.name,
						resolveNodeAgents(node).map((agent) => agent.name),
					])
				)
			: undefined;

		// Build a ChannelRouter so write_gate can trigger onGateDataChanged, which
		// re-evaluates gated channels and lazily activates target nodes when a gate opens.
		const spaceManager = this.config.spaceManager;
		const nodeAgentChannelRouter = new ChannelRouter({
			taskRepo: this.config.taskRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			workflowManager: this.config.spaceWorkflowManager,
			agentManager: this.config.spaceAgentManager,
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			gateDataRepo: this.config.gateDataRepo,
			channelCycleRepo: this.config.channelCycleRepo,
			db: this.config.db.getDatabase(),
			workspacePath,
			getSpaceAutonomyLevel: async (spaceId) => {
				const s = await spaceManager.getSpace(spaceId);
				return s?.autonomyLevel ?? 1;
			},
			isSessionAlive: (sid) => this.isSessionAlive(sid),
			// Forward the runtime's current sink so a peer-agent `send_message`
			// that auto-reopens a terminal run still emits `workflow_run_reopened`
			// into the Space Agent session.
			notificationSink: this.config.spaceRuntimeService.getSharedRuntime().getNotificationSink(),
		});
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			workflowRunId,
			workflowChannels: channels,
			messageInjector: (targetSessionId, message) =>
				this.injectSubSessionMessage(targetSessionId, message),
			channelRouter: nodeAgentChannelRouter,
			nodeGroups,
			taskAgentRouter: async (message) => {
				const ensuredTask = await this.ensureTaskAgentSession(taskId);
				await this.injectTaskAgentMessage(taskId, message);
				return { sessionId: ensuredTask.taskAgentSessionId ?? '' };
			},
		});

		const agentNameAliases = execution
			? this.buildAgentNameAliasesForExecution(workflow, execution)
			: this.agentNameVariants(agentName);

		// Build onReportResult callback for end-node agents so they can close the workflow run.
		//
		// Records the agent's reported intent (status + summary) into
		// `space_tasks.reported_status` / `reported_summary`, but does NOT directly
		// transition `space_tasks.status`. The runtime resolves the final task status
		// on the next tick via `resolveCompletionWithActions`, which honors the
		// supervised-mode review gate. See `CompletionDetector.isComplete`.
		const isEndNode = !!workflow?.endNodeId && workflowNodeId === workflow.endNodeId;
		let onReportResult:
			| ((args: ReportResultInput) => Promise<ReturnType<typeof jsonResult>>)
			| undefined;
		if (isEndNode) {
			const capturedTaskId = taskId;
			const capturedSpaceId = spaceId;
			onReportResult = async (args: ReportResultInput) => {
				const task = this.config.taskRepo.getTask(capturedTaskId);
				if (!task)
					return jsonResult({ success: false, error: `Task not found: ${capturedTaskId}` });

				// Idempotency: if the agent re-invokes report_result with the same outcome
				// (retry, double-call, etc.), skip the DB write and the broadcast — they
				// would be no-ops that still wake every subscriber.
				const successPayload = jsonResult({
					success: true,
					taskId: capturedTaskId,
					status: args.status,
					summary: args.summary,
					message: `Result reported as "${args.status}". The runtime will resolve the final task status (supervised mode may pause for human approval).`,
				});
				if (task.reportedStatus === args.status && task.reportedSummary === args.summary) {
					return successPayload;
				}

				try {
					const updated = this.config.taskRepo.updateTask(capturedTaskId, {
						reportedStatus: args.status,
						reportedSummary: args.summary,
					});

					if (this.config.daemonHub && updated) {
						void this.config.daemonHub
							.emit('space.task.updated', {
								sessionId: 'global',
								spaceId: capturedSpaceId,
								taskId: capturedTaskId,
								task: updated,
							})
							.catch((err) => {
								log.warn(
									`Failed to emit space.task.updated for task ${capturedTaskId}: ${err instanceof Error ? err.message : String(err)}`
								);
							});
					}

					return successPayload;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return jsonResult({ success: false, error: message });
				}
			};
		}

		return createNodeAgentMcpServer({
			mySessionId: subSessionId,
			myAgentName: agentName,
			myAgentNameAliases: agentNameAliases,
			taskId,
			spaceId,
			channelResolver,
			workflowRunId,
			workflowNodeId,
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			agentMessageRouter,
			daemonHub: this.config.daemonHub,
			workflow,
			gateDataRepo: this.config.gateDataRepo,
			onGateDataChanged: (runId, gateId) => nodeAgentChannelRouter.onGateDataChanged(runId, gateId),
			scriptExecutor: executeGateScript,
			// gateId is overridden per-gate by the handler ({ ...scriptContext, gateId })
			scriptContext: { workspacePath, runId: workflowRunId, gateId: '' },
			onReportResult,
			artifactRepo: this.config.artifactRepo,
			getSpaceAutonomyLevel: async (sid) => {
				const s = await spaceManager.getSpace(sid);
				return s?.autonomyLevel ?? 1;
			},
		});
	}
}
