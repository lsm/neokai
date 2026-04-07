/**
 * TaskAgentManager
 *
 * Central integration point that manages the lifecycle of Task Agent sessions
 * and their sub-sessions (node agents). Each SpaceTask gets exactly one Task
 * Agent session, and that session spawns sub-sessions for each workflow step.
 *
 * ## Session hierarchy
 *
 * ```
 * Task Agent session  (space:${spaceId}:task:${taskId})
 *   └── Sub-session   (space:${spaceId}:task:${taskId}:step:${stepId})
 *   └── Sub-session   (...)
 * ```
 *
 * ## In-memory maps
 *
 * - `taskAgentSessions`  — taskId → Task Agent AgentSession
 * - `subSessions`        — taskId → (stepId → AgentSession)
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
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { SpaceWorktreeManager } from '../managers/space-worktree-manager';
import type {
	SubSessionFactory,
	SubSessionMemberInfo,
	SubSessionState,
} from '../tools/task-agent-tools';
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

const log = new Logger('task-agent-manager');

/**
 * Number of runtime reminders sent to a node agent that became idle without
 * calling report_done() before the execution is escalated to blocked.
 */
const MAX_MISSING_REPORT_DONE_REMINDERS = 3;

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
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Map of stepId → all registered completion callbacks for that session */
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
	 * Maps taskId → (stepId → AgentSession) for sub-sessions.
	 * Sub-session IDs follow the convention:
	 *   `space:${spaceId}:task:${taskId}:step:${stepId}`
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
	 * Tracks how many runtime reminders were sent for each node execution that
	 * became idle without calling report_done().
	 *
	 * Key: node_execution.id
	 * Value: reminder attempt count (1..MAX_MISSING_REPORT_DONE_REMINDERS)
	 */
	private missingReportDoneReminders = new Map<string, number>();

	constructor(private readonly config: TaskAgentManagerConfig) {}

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
			const subSessionFactory = this.createSubSessionFactory(taskId);

			const workflowRunId = workflowRun?.id ?? '';

			// Build shared channel routing instance.
			const channelRouter = new ChannelRouter({
				taskRepo: this.config.taskRepo,
				workflowRunRepo: this.config.workflowRunRepo,
				workflowManager: this.config.spaceWorkflowManager,
				agentManager: this.config.spaceAgentManager,
				nodeExecutionRepo: this.config.nodeExecutionRepo,
				gateDataRepo: this.config.gateDataRepo,
				db: this.config.db.getDatabase(),
				workspacePath,
			});

			const mcpServer = createTaskAgentMcpServer({
				taskId,
				space,
				workflowRunId,
				workspacePath,
				workflowManager: this.config.spaceWorkflowManager,
				taskRepo: this.config.taskRepo,
				workflowRunRepo: this.config.workflowRunRepo,
				nodeExecutionRepo: this.config.nodeExecutionRepo,
				agentManager: this.config.spaceAgentManager,
				taskManager,
				sessionFactory: subSessionFactory,
				messageInjector: (subSessionId, message) =>
					this.injectSubSessionMessage(subSessionId, message),
				onSubSessionComplete: (stepId, subSessionId) =>
					this.handleSubSessionComplete(taskId, stepId, subSessionId),
				daemonHub: this.config.daemonHub,
				channelRouter,
				buildNodeAgentMcpServer: (subSessionId, role, _stepTaskId) =>
					this.buildNodeAgentMcpServerForSession(
						taskId,
						subSessionId,
						role,
						spaceId,
						workflowRunId,
						workspacePath
					) as unknown as McpServerConfig,
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
					`No agent slot found for role "${execution.agentName}" in node "${execution.workflowNodeId}"`
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

			const slotOverrides: SlotOverrides = {
				model: slot.model,
				systemPrompt: slot.systemPrompt,
				instructions: slot.instructions,
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
	 * Create a sub-session for a workflow step.
	 *
	 * Called internally from the SubSessionFactory.create() closure. Creates the
	 * session via AgentSession.fromInit() to ensure DB persistence. Registers the
	 * session in the subSessions map for fast lookup by taskId + stepId.
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

		// Determine step ID from session convention or task context.
		// The subSessions map uses the actual session ID as both the map key and session ID.
		// We store by session ID directly (not step ID) in the flat map for getProcessingState.
		if (!this.subSessions.has(taskId)) {
			this.subSessions.set(taskId, new Map());
		}
		this.subSessions.get(taskId)!.set(sessionId, subSession);
		this.agentSessionIndex.set(sessionId, subSession);

		// Register in SessionManager cache to prevent duplicate AgentSession creation.
		this.config.sessionManager.registerSession(subSession);

		// Write agent_session_id on the matching NodeExecution record so that
		// AgentMessageRouter, sibling cleanup, and live-query SQL can resolve
		// the session. Requires stepId (workflowNodeId) and role (agentName).
		if (memberInfo?.stepId && memberInfo.role) {
			const parentTask = this.config.taskRepo.getTask(taskId);
			if (parentTask?.workflowRunId) {
				const nodeExecs = this.config.nodeExecutionRepo.listByNode(
					parentTask.workflowRunId,
					memberInfo.stepId
				);
				const match = nodeExecs.find((e) => e.agentName === memberInfo.role);
				if (match && !match.agentSessionId) {
					this.config.nodeExecutionRepo.updateSessionId(match.id, sessionId);
				} else if (match && match.agentSessionId) {
					log.warn(
						`TaskAgentManager: NodeExecution ${match.id} already has agentSessionId ${match.agentSessionId}; skipping update for new session ${sessionId}`
					);
				} else {
					log.warn(
						`TaskAgentManager: no matching NodeExecution found for (run=${parentTask.workflowRunId}, node=${memberInfo.stepId}, agent=${memberInfo.role})`
					);
				}
			}
		}

		// Start streaming query for the sub-session
		await subSession.startStreamingQuery();

		log.info(`TaskAgentManager: created sub-session ${sessionId} for task ${taskId}`);
		return sessionId;
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
		await this.injectMessageIntoSession(session, message);
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
		for (const [, stepMap] of this.subSessions) {
			const session = stepMap.get(subSessionId);
			if (session) {
				await this.injectMessageIntoSession(session, message);
				return;
			}
		}
		throw new Error(`Sub-session not found: ${subSessionId}`);
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
		for (const [, stepMap] of this.subSessions) {
			const session = stepMap.get(subSessionId);
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
		const taskIds = Array.from(this.taskAgentSessions.keys());
		await Promise.allSettled(taskIds.map((taskId) => this.cleanup(taskId)));
		this.missingReportDoneReminders.clear();
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
		const stepMap = this.subSessions.get(taskId);
		if (stepMap) {
			for (const [subSessionId, session] of stepMap) {
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

		const taskWorkflowRunId = this.config.taskRepo.getTask(taskId)?.workflowRunId;
		if (taskWorkflowRunId) {
			const executions = this.config.nodeExecutionRepo.listByWorkflowRun(taskWorkflowRunId);
			for (const execution of executions) {
				this.missingReportDoneReminders.delete(execution.id);
			}
		}

		log.info(`TaskAgentManager: cleaned up all sessions for task ${taskId} (reason: ${reason})`);
	}

	// -------------------------------------------------------------------------
	// Private — SubSessionFactory
	// -------------------------------------------------------------------------

	/**
	 * Create a `SubSessionFactory` implementation bound to a specific taskId.
	 * Passed to `createTaskAgentMcpServer()` for the given Task Agent session.
	 */
	private createSubSessionFactory(taskId: string): SubSessionFactory {
		// Capture workflowRunId once at factory-creation time to avoid a DB round-trip
		// on every spawn. The run ID is immutable once assigned, so this is safe.
		// Log a warning if the task lacks a workflow run — node-agent tools will
		// produce an empty ChannelResolver (no declared channels) in that case.
		const taskWorkflowRunId = this.config.taskRepo.getTask(taskId)?.workflowRunId ?? '';
		if (!taskWorkflowRunId) {
			log.warn(
				`TaskAgentManager.createSubSessionFactory: task ${taskId} has no workflowRunId — ` +
					`node-agent channel topology will be unavailable`
			);
		}

		return {
			create: async (
				init: AgentSessionInit,
				_memberInfo?: SubSessionMemberInfo
			): Promise<string> => {
				// Forward the task's worktree path to every sub-session so all node
				// agents share the same isolated git worktree for the duration of the run.
				const worktreePath = this.taskWorktreePaths.get(taskId);
				const effectiveInit: AgentSessionInit = worktreePath
					? { ...init, workspacePath: worktreePath }
					: init;
				const sessionId = await this.createSubSession(
					taskId,
					effectiveInit.sessionId,
					effectiveInit,
					_memberInfo
				);
				return sessionId;
			},

			getProcessingState: (subSessionId: string): SubSessionState | null => {
				// Look up session by ID
				const session = this.getSubSession(subSessionId);
				if (!session) return null;

				const state = session.getProcessingState();
				const isProcessing = state.status === 'processing' || state.status === 'queued';
				// Terminal states: if the session's query has ended and it never processes again,
				// we consider it complete. The sub-session is marked complete when the Task Agent's
				// completion callback fires (see onComplete + handleSubSessionComplete).
				// For getProcessingState, 'idle' after having processed at least once = complete.
				// We use a heuristic: if the session has received at least one SDK message and is
				// now idle, it is complete.
				const sdkCount = session.getSDKMessageCount();
				const isIdle = state.status === 'idle';
				const isComplete = isIdle && sdkCount > 0;

				return {
					isProcessing,
					isComplete,
					error: undefined,
				};
			},

			onComplete: (subSessionId: string, callback: () => Promise<void>): void => {
				this.registerCompletionCallback(subSessionId, callback);
			},
		};
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
	private registerCompletionCallback(subSessionId: string, callback: () => Promise<void>): void {
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
	 * Called by the MCP onSubSessionComplete callback (registered in spawn_node_agent).
	 * Notifies the Task Agent (when present) about workflow node session completion.
	 */
	private async handleSubSessionComplete(
		taskId: string,
		stepId: string,
		subSessionId: string
	): Promise<void> {
		log.info(
			`TaskAgentManager: sub-session complete — task ${taskId}, step ${stepId}, session ${subSessionId}`
		);

		const workflowRunId = this.getWorkflowRunId(taskId);
		let execution = workflowRunId
			? this.config.nodeExecutionRepo
					.listByWorkflowRun(workflowRunId)
					.find((candidate) => candidate.agentSessionId === subSessionId)
			: null;

		if (execution && execution.status === 'in_progress') {
			const handled = await this.handleIdleExecutionWithoutReportDone(
				taskId,
				subSessionId,
				execution
			);
			if (handled) {
				return;
			}
			execution = this.config.nodeExecutionRepo.getById(execution.id);
		}

		if (execution && execution.status !== 'in_progress') {
			this.missingReportDoneReminders.delete(execution.id);
		}

		const resolvedStepId = execution?.workflowNodeId ?? stepId;
		const resultSummary = execution?.result ? `\nAgent result summary: ${execution.result}` : '';

		// Notify the Task Agent that a sub-session has completed.
		const taskAgentSession = this.taskAgentSessions.get(taskId);
		if (taskAgentSession) {
			try {
				await this.injectMessageIntoSession(
					taskAgentSession,
					`[STEP_COMPLETE] Step "${resolvedStepId}" sub-session (${subSessionId}) has completed.${resultSummary}\nUse this event for communication context only. Workflow progression is driven by Space Runtime and workflow agents.`,
					'defer'
				);
			} catch (err) {
				log.warn(
					`TaskAgentManager: failed to notify task agent of step completion for task ${taskId}:`,
					err
				);
			}
		}
	}

	/**
	 * Recover from node agents that went idle without calling report_done().
	 *
	 * Sends deterministic runtime reminders (with gate/channel requirements) for a
	 * bounded number of attempts, then escalates the execution to blocked.
	 *
	 * @returns true when the completion event was fully handled here (reminder sent
	 *          or execution escalated), false when normal completion flow should continue.
	 */
	private async handleIdleExecutionWithoutReportDone(
		taskId: string,
		subSessionId: string,
		execution: NodeExecution
	): Promise<boolean> {
		const refreshed = this.config.nodeExecutionRepo.getById(execution.id);
		if (!refreshed || refreshed.status !== 'in_progress') {
			this.missingReportDoneReminders.delete(execution.id);
			return false;
		}

		const attempt = (this.missingReportDoneReminders.get(execution.id) ?? 0) + 1;
		this.missingReportDoneReminders.set(execution.id, attempt);

		const run = this.config.workflowRunRepo.getRun(refreshed.workflowRunId);
		const workflow = run
			? (this.config.spaceWorkflowManager.getWorkflow(run.workflowId) ?? null)
			: null;

		if (attempt <= MAX_MISSING_REPORT_DONE_REMINDERS) {
			const reminder = this.buildMissingReportDoneReminder(
				workflow,
				refreshed,
				attempt,
				MAX_MISSING_REPORT_DONE_REMINDERS
			);
			const subSession = this.getSubSession(subSessionId);
			if (!subSession) {
				log.warn(
					`TaskAgentManager: sub-session ${subSessionId} not found while sending missing-report_done reminder for execution ${execution.id}`
				);
				return false;
			}

			// Re-arm completion detection for the next idle transition after this reminder.
			this.registerCompletionCallback(subSessionId, async () => {
				await this.handleSubSessionComplete(taskId, refreshed.workflowNodeId, subSessionId);
			});

			await this.injectMessageIntoSession(subSession, reminder, 'defer');
			log.warn(
				`TaskAgentManager: reminded execution ${execution.id} (${attempt}/${MAX_MISSING_REPORT_DONE_REMINDERS}) to call report_done()`
			);
			return true;
		}

		const reason =
			`Node agent session became idle without calling report_done after ` +
			`${MAX_MISSING_REPORT_DONE_REMINDERS} reminder attempts.`;
		this.missingReportDoneReminders.delete(execution.id);
		await this.handleSubSessionError(subSessionId, reason);
		log.warn(
			`TaskAgentManager: escalated execution ${execution.id} to blocked after missing report_done reminders`
		);
		return true;
	}

	/**
	 * Handle a sub-session error event and notify the parent Task Agent.
	 *
	 * This enables event-driven orchestration: Task Agent can react to failures
	 * without continuously polling check_node_status.
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

		if (failedExecution) {
			this.missingReportDoneReminders.delete(failedExecution.id);
		}

		const taskAgentSession = this.taskAgentSessions.get(parentTaskId);
		if (!taskAgentSession) return;

		const stepId = failedExecution?.workflowNodeId ?? 'unknown-step';
		await this.injectMessageIntoSession(
			taskAgentSession,
			`[STEP_FAILED] Step "${stepId}" sub-session (${subSessionId}) reported an error: ${error}\nWorkflow progression is runtime-driven; use this as context for human coordination only.`,
			'defer'
		);
	}

	private buildMissingReportDoneReminder(
		workflow: SpaceWorkflow | null,
		execution: NodeExecution,
		attempt: number,
		maxAttempts: number
	): string {
		const contract = this.buildNodeExecutionRuntimeContract(workflow, execution);
		return [
			`[RUNTIME_REMINDER ${attempt}/${maxAttempts}] Node session became idle, but execution "${execution.id}" is still in_progress.`,
			'Workflow progression is blocked until this execution is completed.',
			contract,
			'Take action now: satisfy required gate checks/writes (if any), then call report_done({ summary: "..." }).',
		].join('\n\n');
	}

	/**
	 * Build a runtime contract for a specific node execution from the current
	 * workflow graph, including gate requirements derived from outbound channels.
	 */
	private buildNodeExecutionRuntimeContract(
		workflow: SpaceWorkflow | null,
		execution: NodeExecution
	): string {
		const fallback = [
			'## Runtime Execution Contract',
			`Role: "${execution.agentName}"`,
			'When your work is complete, call report_done({ summary: "..." }).',
			'If blocked, send a clear blocker message instead of stopping silently.',
		].join('\n');

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
			`Role: "${execution.agentName}"`,
		];

		if (outboundGatedChannels.length === 0) {
			lines.push('No outbound gated channels are currently mapped from this role/node.');
		} else {
			const gateById = new Map((workflow.gates ?? []).map((gate) => [gate.id, gate]));
			const roleAliases = this.buildRoleAliasesForExecution(workflow, execution);
			lines.push('Before completion, satisfy outbound gate requirements:');

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
					this.isWriterAuthorizedForRoleAliases(field.writers, roleAliases)
				);
				if (writableFields.length === 0) {
					const aliasSuffix = roleAliases.length > 1 ? ` (aliases: ${roleAliases.join(', ')})` : '';
					lines.push(
						`  - No gate fields are writable by role "${execution.agentName}"${aliasSuffix}; ensure required artifacts/checks are ready.`
					);
					continue;
				}

				lines.push(`  - Write via write_gate("${gateId}", { ... }) with:`);
				for (const field of writableFields) {
					lines.push(
						`    • ${field.name} (${field.type}) — check: ${this.describeGateCheck(field.check)}`
					);
				}
			}
		}

		lines.push('After requirements are met, call report_done({ summary: "..." }).');
		lines.push('If blocked, send a clear blocker message instead of stopping silently.');
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

	private normalizeRoleToken(value: string): string {
		return value.trim().toLowerCase();
	}

	private roleNameVariants(value: string): string[] {
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

	private buildRoleAliasesForExecution(
		workflow: SpaceWorkflow | null,
		execution: NodeExecution
	): string[] {
		const aliases = new Set<string>(this.roleNameVariants(execution.agentName));
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
			for (const variant of this.roleNameVariants(slot.name)) {
				aliases.add(variant);
			}
		}

		const spaceAgentId = execution.agentId ?? slot?.agentId;
		if (spaceAgentId) {
			const spaceAgent = this.config.spaceAgentManager.getById(spaceAgentId);
			if (spaceAgent?.name) {
				for (const variant of this.roleNameVariants(spaceAgent.name)) {
					aliases.add(variant);
				}
			}
		}

		return [...aliases];
	}

	private isWriterAuthorizedForRoleAliases(writers: string[], roleAliases: string[]): boolean {
		const normalizedAliases = new Set(
			roleAliases.map((alias) => this.normalizeRoleToken(alias)).filter((alias) => alias.length > 0)
		);
		return writers.some((writer) => {
			const normalizedWriter = this.normalizeRoleToken(writer);
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
	 * 7. Rebuilds the `subSessions` map from step tasks in the same workflow run.
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
		const subSessionFactory = this.createSubSessionFactory(taskId);

		const rehydrateWorkflowRunId = workflowRun?.id ?? '';

		// Build shared channel routing instance for rehydration.
		const rehydrateChannelRouter = new ChannelRouter({
			taskRepo: this.config.taskRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			workflowManager: this.config.spaceWorkflowManager,
			agentManager: this.config.spaceAgentManager,
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			gateDataRepo: this.config.gateDataRepo,
			channelCycleRepo: this.config.channelCycleRepo,
			db: this.config.db.getDatabase(),
			workspacePath: rehydrateWorkspacePath,
		});

		const mcpServer = createTaskAgentMcpServer({
			taskId,
			space,
			workflowRunId: rehydrateWorkflowRunId,
			workspacePath: rehydrateWorkspacePath,
			workflowManager: this.config.spaceWorkflowManager,
			taskRepo: this.config.taskRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			agentManager: this.config.spaceAgentManager,
			taskManager,
			sessionFactory: subSessionFactory,
			messageInjector: (subSessionId, message) =>
				this.injectSubSessionMessage(subSessionId, message),
			onSubSessionComplete: (stepId, subSessionId) =>
				this.handleSubSessionComplete(taskId, stepId, subSessionId),
			daemonHub: this.config.daemonHub,
			channelRouter: rehydrateChannelRouter,
			buildNodeAgentMcpServer: (subSessionId, role, _stepTaskId) =>
				this.buildNodeAgentMcpServerForSession(
					taskId,
					subSessionId,
					role,
					spaceId,
					rehydrateWorkflowRunId,
					rehydrateWorkspacePath
				) as unknown as McpServerConfig,
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
		// For workflow tasks: ask the agent to use check_node_status to resume workflow execution.
		// For standalone tasks (no workflowRunId): ask the agent to check status and continue.
		const reorientMessage = task.workflowRunId
			? 'You are resuming after a daemon restart. Your previous conversation state has been restored. ' +
				'Please review pending tasks and recent [STEP_*] event messages, then continue orchestration in event-driven mode. ' +
				'Use `check_node_status` only for specific reconciliation checks.'
			: 'You are resuming after a daemon restart. Your previous conversation state has been restored. ' +
				'Please check the current task status and continue from where you left off.';
		await this.injectMessageIntoSession(agentSession, reorientMessage);

		log.info(
			`TaskAgentManager.rehydrate: rehydrated task agent for task ${taskId} (session ${sessionId})`
		);
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
		origin?: MessageOrigin
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
		const sdkUserMessage: SDKUserMessage = {
			type: 'user' as const,
			uuid: messageId as UUID,
			session_id: sessionId,
			parent_tool_use_id: null,
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
		for (const [taskId, stepMap] of this.subSessions) {
			if (stepMap.has(subSessionId)) {
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
	 * at step-start (stored in the run config by SpaceRuntime.storeResolvedChannels()).
	 *
	 * The server gives the node agent peer communication tools (list_peers, send_message,
	 * report_done) that are scoped to its group, channel topology, and step task.
	 */
	private buildNodeAgentMcpServerForSession(
		taskId: string,
		subSessionId: string,
		role: string,
		spaceId: string,
		workflowRunId: string,
		workspacePath: string,
		workflowNodeIdHint?: string
	) {
		const nodeExecutions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
		const bySession = nodeExecutions.find((exec) => exec.agentSessionId === subSessionId);
		const byRole = nodeExecutions.find((exec) => exec.agentName === role);
		const execution = bySession ?? byRole;
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

		const roleAliases = execution
			? this.buildRoleAliasesForExecution(workflow, execution)
			: this.roleNameVariants(role);

		return createNodeAgentMcpServer({
			mySessionId: subSessionId,
			myRole: role,
			myRoleAliases: roleAliases,
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
		});
	}
}
