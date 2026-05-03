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
	WorkflowNodeAgent,
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
import type { ToolContinuationRecoveryRepository } from '../../../storage/repositories/tool-continuation-recovery-repository';
import type { SpaceWorktreeManager } from '../managers/space-worktree-manager';
import type { SubSessionMemberInfo } from '../tools/task-agent-tools';
import { createTaskAgentMcpServer } from '../tools/task-agent-tools';
import { createNodeAgentMcpServer } from '../tools/node-agent-tools';
import { createEndNodeHandlers, createMarkCompleteHandler } from '../tools/end-node-handlers';
import { createSpaceAgentMcpServer } from '../tools/space-agent-tools';
import { jsonResult } from '../tools/tool-result';
import {
	assertExecutionValidAgainstWorkflow,
	PermanentSpawnError,
	validateTaskAllowsSpawn,
} from './workflow-node-execution-validation';
import { createDbQueryMcpServer, type DbQueryMcpServer } from '../../db-query/tools';
import { ChannelResolver } from './channel-resolver';
import { ChannelRouter } from './channel-router';
import { AgentMessageRouter } from './agent-message-router';
import { RUNTIME_ESCALATION_REASONS } from './escalation-reasons';
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TaskAgentManagerConfig {
	/** Custom Database wrapper — used to persist sessions */
	db: Database;
	/**
	 * SessionManager — used to register externally-created AgentSessions
	 * (Task Agent + sub-sessions) in the shared cache and to interrupt
	 * in-memory sessions during cleanup. Task #85: never used here to delete
	 * persisted session data.
	 */
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
	 * Note: session skill overrides are NOT applicable to task agent sessions — task agents have no
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
	/** Durable recovery store for pending Codex tool_result continuations. */
	toolContinuationRepo?: ToolContinuationRecoveryRepository;
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
	attachToolContinuationRepo(repo: ToolContinuationRecoveryRepository): void {
		this.config.toolContinuationRepo = repo;
	}

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
	 * Eager sub-session index: taskId → (agentName → sessionId).
	 *
	 * Populated by `eagerlySpawnWorkflowNodeAgents()` at task-agent spawn time.
	 * Consulted by `createSubSession()`'s reuse path so that a later
	 * workflow-node activation for the same `agentName` picks up the already-
	 * alive eager session instead of creating a second one.
	 *
	 * This is an in-memory fast path. The authoritative record is the
	 * corresponding `node_executions` row (with `agentSessionId` set), which
	 * also drives DB-backed rehydration after daemon restarts.
	 */
	private eagerSubSessionIds = new Map<string, Map<string, string>>();

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
	 * Subscribe to `space.task.updated` and run the archive pipeline for tasks
	 * that reach the `archived` state.
	 *
	 * `archived` is the only truly non-recoverable terminal state for a task —
	 * per issue #1515, node agent sessions must remain reachable (e.g. for
	 * cross-node `send_message` from a reviewer to a completed coder) for the
	 * full lifetime of the parent task run, and are only torn down when the
	 * task is archived.
	 *
	 * Task #85: archive is a UI-initiated action. It removes the task's
	 * worktree + each attached session's SDK `.jsonl` files, but preserves
	 * the `sessions` DB row + `sdk_messages` so the conversation history
	 * remains viewable.
	 */
	private subscribeToTaskArchiveEvents(): void {
		if (this.taskArchiveListenerUnsub) return;
		this.taskArchiveListenerUnsub = this.config.daemonHub.on('space.task.updated', (event) => {
			if (event.task?.status !== 'archived') return;
			// Task #85: skip the cleanup cascade for automated duplicate-run
			// reconciliation archives. Only user-initiated archives (missing or
			// explicit `'user'` marker) may remove the task worktree and archive
			// the SDK `.jsonl` files.
			if (event.archiveSource === 'system_reconcile') return;
			const taskId = event.taskId;
			// Fire-and-forget — archiveOnTaskArchived is idempotent and safe to
			// skip on failure (cleanupAll still sweeps leftovers on daemon shutdown).
			void this.archiveOnTaskArchived(taskId).catch((err) => {
				log.warn(`TaskAgentManager: failed to archive resources for archived task ${taskId}:`, err);
			});
		});
	}

	/**
	 * Archive pipeline for a task that has transitioned to `archived`.
	 *
	 * Task #85 invariant:
	 *   - DB row + `sdk_messages` for each attached session: PRESERVED.
	 *   - Worktree + SDK `.jsonl` files for each attached session: REMOVED
	 *     (archive is user-initiated; disk space is freed but the DB row
	 *     keeps a pointer to the archived jsonl via `sdkArchivePath`).
	 *
	 * Steps:
	 *   1. Collect IDs of the attached task-agent + sub-session sessions.
	 *   2. `cleanup(taskId)` — stop in-memory sessions and clear maps.
	 *   3. For each collected session, call
	 *      `SessionManager.archiveSessionResources(id, 'ui_task_archive')`,
	 *      which stamps the session row as `archived` and archives its
	 *      SDK `.jsonl` files to a `.archive/` sidecar.
	 *   4. Remove the space-level task worktree so disk space is freed.
	 */
	private async archiveOnTaskArchived(taskId: string): Promise<void> {
		// 1. Snapshot session IDs BEFORE cleanup clears the maps.
		const sessionIds = new Set<string>();
		const taskAgentSession = this.taskAgentSessions.get(taskId);
		if (taskAgentSession) sessionIds.add(taskAgentSession.session.id);
		const nodeMap = this.subSessions.get(taskId);
		if (nodeMap) {
			for (const [sid] of nodeMap) sessionIds.add(sid);
		}
		// Fallback: if the in-memory map is empty (e.g. after daemon restart
		// without rehydrate), use the DB-recorded task-agent session ID.
		const task = this.config.taskRepo.getTask(taskId);
		if (task?.taskAgentSessionId) sessionIds.add(task.taskAgentSessionId);

		// 2. In-memory teardown (DB + worktree + jsonl preserved by cleanup).
		try {
			await this.cleanup(taskId, 'done');
		} catch (err) {
			log.warn(`TaskAgentManager.archiveOnTaskArchived: cleanup failed for task ${taskId}:`, err);
		}

		// 3. Archive SDK .jsonl files + mark each attached session as archived.
		for (const sessionId of sessionIds) {
			try {
				await this.config.sessionManager.archiveSessionResources(sessionId, 'ui_task_archive');
			} catch (err) {
				log.warn(
					`TaskAgentManager.archiveOnTaskArchived: failed to archive session ${sessionId} for task ${taskId}:`,
					err
				);
			}
		}

		// 4. Remove the space-level task worktree (disk cleanup). The DB task
		// row remains so the UI can still display the archived task.
		if (this.config.worktreeManager && task?.spaceId) {
			try {
				await this.config.worktreeManager.removeTaskWorktree(task.spaceId, taskId);
				log.info(`TaskAgentManager: removed worktree for archived task ${taskId}`);
			} catch (err) {
				log.warn(
					`TaskAgentManager: failed to remove worktree for archived task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
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
					this.injectSubSessionMessage(subSessionId, message, true),
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
				artifactRepo: this.config.artifactRepo,
			});

			// mergeRuntimeMcpServers expects McpServerConfig but the MCP SDK's `Server`
			// object is structurally compatible at runtime — the AgentSession only reads
			// the `server` property for the live Server instance. The cast is safe because
			// createTaskAgentMcpServer returns { server, cleanup } which satisfies the
			// runtime shape used inside AgentSession.mergeRuntimeMcpServers().
			//
			// Merge registry-sourced MCP servers from AppMcpLifecycleManager alongside the
			// in-process task-agent server. The task-agent server always wins on collision
			// since it provides the core orchestration tools required for task management.
			//
			// Note: task agent sessions are short-lived (one per task), so there is no
			// mcp.registry.changed subscription here. Registry changes during a running task
			// are not hot-reloaded; they take effect when the next task agent is spawned.
			//
			// Resolves the session's space > room > session scope chain against
			// mcp_enablement so per-space overrides from the space settings UI
			// are honored.
			const registryMcpServers =
				this.config.appMcpManager?.getEnabledMcpConfigsForSession({
					id: sessionId,
					context: { spaceId },
				}) ?? {};
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

			// Attach `space-agent-tools` alongside `task-agent` so the task agent
			// can coordinate directly with the rest of the Space (e.g., via
			// `send_message_to_agent`) in the same way the Space chat session
			// can. Safe because tool handlers gate on autonomy + writer checks.
			const spaceAgentMcpServer = createSpaceAgentMcpServer({
				spaceId,
				runtime: this.config.spaceRuntimeService.getSharedRuntime(),
				workflowManager: this.config.spaceWorkflowManager,
				spaceManager: this.config.spaceManager,
				taskRepo: this.config.taskRepo,
				nodeExecutionRepo: this.config.nodeExecutionRepo,
				workflowRunRepo: this.config.workflowRunRepo,
				taskManager,
				spaceAgentManager: this.config.spaceAgentManager,
				taskAgentManager: this,
				gateDataRepo: this.config.gateDataRepo,
				daemonHub: this.config.daemonHub,
				onGateChanged: (runId, gateId) => {
					void this.config.spaceRuntimeService.notifyGateDataChanged(runId, gateId).catch(() => {});
				},
				pendingMessageQueue: this.config.pendingMessageRepo,
				getSpaceAutonomyLevel: async (sid) => {
					const s = await this.config.spaceManager.getSpace(sid);
					return s?.autonomyLevel ?? 1;
				},
				myAgentName: 'task-agent',
			});
			taskMcpServers['space-agent-tools'] = spaceAgentMcpServer as unknown as McpServerConfig;

			// Use merge semantics so any servers already present (e.g. injected by a
			// concurrent subsystem before this path runs) are preserved. In practice the
			// session is freshly created and the map is empty, but merge is safer than
			// the deprecated replace-all setRuntimeMcpServers.
			agentSession.mergeRuntimeMcpServers(taskMcpServers);

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

			// --- Block until the SDK has emitted its `init` message and the
			// resulting sdkSessionId is persisted. Without this await, a daemon
			// restart between `startStreamingQuery()` and the first inbound SDK
			// message would leave the DB row with `sdkSessionId = null` — on
			// rehydrate the SDK has no transcript to resume, so the agent's
			// conversation history is silently lost. This is the primary root
			// cause of the "task-agent session lost after daemon restart" bug.
			//
			// Best-effort with timeout: worst case we fall through and accept
			// the pre-fix behaviour, but in practice the SDK init message
			// arrives within ~1–2 seconds.
			try {
				await agentSession.awaitSdkSessionCaptured(15_000);
			} catch (err) {
				log.warn(
					`TaskAgentManager: sdkSessionId capture timed out for task-agent session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
				);
			}

			// --- Eagerly spawn sub-sessions for all workflow node agents.
			// Each gets `startStreamingQuery` + `awaitSdkSessionCaptured` so the
			// SDK transcript is persisted before any kickoff work happens.
			// Deliberately runs BEFORE the task-agent kickoff message so that
			// a daemon restart at any later point can always resume every
			// session with a valid sdkSessionId.
			if (workflow && workflowRun) {
				try {
					await this.eagerlySpawnWorkflowNodeAgents({
						task,
						space,
						workflow,
						workflowRun,
						workspacePath,
					});
				} catch (err) {
					log.warn(
						`TaskAgentManager: eager sub-session spawn failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}

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
			const startedAt = execution.startedAt ?? Date.now();
			this.config.nodeExecutionRepo.update(execution.id, {
				status: 'in_progress',
				agentSessionId: execution.agentSessionId,
				startedAt,
				completedAt: null,
			});
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
			validateTaskAllowsSpawn(task);
			assertExecutionValidAgainstWorkflow(execution, workflow);

			const node = workflow.nodes.find((candidate) => candidate.id === execution.workflowNodeId)!;
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

			const slotOverrides = this.buildSlotOverrides(slot, {
				node,
				workflow,
				workflowRun,
			});

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
				throw new PermanentSpawnError(`Agent not found: ${slot.agentId}`);
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
				// agentName + nodeId enable two critical behaviours inside createSubSession:
				//   1. Session reuse — if this agent already ran (agentSessionId set on an
				//      older NodeExecution), the existing session is reused rather than spawning
				//      a redundant second session. Each named agent lives in one session per
				//      task lifetime; subsequent activations inject a new message into it.
				//   2. Pending message flush — after the session is created/reused, any
				//      messages queued via PendingAgentMessageRepository (e.g. from a Task
				//      Agent send_message call that raced ahead of this spawn) are drained
				//      into the session. Without agentName this flush is skipped entirely.
				agentName: execution.agentName,
				nodeId: execution.workflowNodeId,
			});
			spawnedSessionId = actualSessionId;

			const spawned = this.getSubSession(actualSessionId);
			if (!spawned) {
				throw new Error(`Spawned node session ${actualSessionId} is not registered in memory`);
			}

			const startedAt = Date.now();
			const updatedExecution = this.config.nodeExecutionRepo.update(execution.id, {
				status: 'in_progress',
				agentSessionId: actualSessionId,
				startedAt,
				completedAt: null,
			});
			if (
				!updatedExecution ||
				updatedExecution.status !== 'in_progress' ||
				updatedExecution.agentSessionId !== actualSessionId ||
				!updatedExecution.startedAt
			) {
				log.error('[Spawn] Execution state mismatch after spawn', {
					executionId: execution.id,
					expectedStatus: 'in_progress',
					actualStatus: updatedExecution?.status ?? null,
					expectedSessionId: actualSessionId,
					actualSessionId: updatedExecution?.agentSessionId ?? null,
				});
				this.config.nodeExecutionRepo.update(execution.id, {
					status: 'blocked',
					result: 'Execution state corruption after spawn',
					completedAt: Date.now(),
				});
				throw new Error(`Execution state corruption after spawn for ${execution.id}`);
			}

			// Defensive guarantee: verify the node-agent MCP server is present in the
			// sub-session's effective config. If a registry collision, race, or refactor
			// regression ever drops it, self-heal by re-attaching before the first turn
			// kicks off — and emit a loud warning so the regression surfaces in logs.
			//
			// This is a belt-and-braces check to prevent silent recurrence of the
			// "No such tool available" failure mode where the Coder→Reviewer handoff
			// died because mcp__node-agent__send_message was unregistered.
			await this.ensureNodeAgentAttached(spawned, {
				taskId,
				subSessionId: actualSessionId,
				agentName: execution.agentName,
				spaceId: space.id,
				workflowRunId: workflowRun.id,
				workspacePath,
				workflowNodeId: execution.workflowNodeId,
				phase: 'spawn',
			});

			this.registerCompletionCallback(actualSessionId, async () => {
				await this.handleSubSessionComplete(taskId, execution.workflowNodeId, actualSessionId);
			});

			if (shouldKickoff) {
				// Snapshot gate data for this workflow run so the builder can render the
				// current PR URL (and any other derived runtime fields) in the user
				// message. Safe to call even on fresh runs — returns [] when empty.
				const gateDataSnapshot = this.config.gateDataRepo
					.listByRun(workflowRun.id)
					.map((record) => ({ gateId: record.gateId, data: record.data }));

				const initialMessage = buildCustomAgentTaskMessage({
					customAgent: customAgent!,
					task,
					workflowRun,
					workflow,
					space,
					sessionId: actualSessionId,
					workspacePath,
					slotOverrides,
					nodeId: execution.workflowNodeId,
					agentSlotName: execution.agentName,
					gateData: gateDataSnapshot,
				});
				const runtimeContract = this.buildNodeExecutionRuntimeContract(workflow, execution, space);
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
	 * Eagerly pre-spawn one sub-session per distinct agent slot referenced by
	 * the workflow graph, _before_ the task-agent kickoff message is injected.
	 *
	 * Why:
	 * - The task-agent session already exists with its SDK init captured
	 *   (see `awaitSdkSessionCaptured` in `spawnTaskAgent`).
	 * - Without eager spawn, node-agent sub-sessions are only created when
	 *   the workflow activates a node. Any daemon restart between the
	 *   task-agent kickoff and that activation leaves the node-agent SDK
	 *   transcripts non-existent, so the workflow effectively starts from
	 *   scratch on rehydrate.
	 * - By spawning all referenced agents now and awaiting their SDK init
	 *   capture, every sub-session's `sdkSessionId` is persisted up front.
	 *   A restart at any later point can safely resume every session with
	 *   full history.
	 *
	 * The sub-sessions are started but _not_ kicked off — no user message
	 * is injected. When the workflow activates the corresponding node later,
	 * `spawnWorkflowNodeAgentForExecution` calls `createSubSession` which
	 * discovers the pre-spawned session via `eagerSubSessionIds` and reuses
	 * it (re-attaching the node-agent MCP server with fresh node context
	 * and firing the kickoff message).
	 *
	 * Best-effort per-agent: one slot failure must not break the whole
	 * pre-spawn pass.
	 */
	private async eagerlySpawnWorkflowNodeAgents(ctx: {
		task: SpaceTask;
		space: Space;
		workflow: SpaceWorkflow;
		workflowRun: SpaceWorkflowRun;
		workspacePath: string;
	}): Promise<void> {
		const { task, space, workflow, workflowRun, workspacePath } = ctx;
		const taskId = task.id;
		const spaceId = space.id;

		// Build a map of unique (agentName → {slot, nodeId}) picking the first
		// occurrence in workflow.nodes iteration order. This matches the reuse
		// contract: one session per agent name per task lifetime.
		const eagerTargets = new Map<
			string,
			{ slot: ReturnType<typeof resolveNodeAgents>[number]; nodeId: string }
		>();
		for (const node of workflow.nodes) {
			for (const slot of resolveNodeAgents(node)) {
				if (!slot.agentId) continue;
				if (eagerTargets.has(slot.name)) continue;
				eagerTargets.set(slot.name, { slot, nodeId: node.id });
			}
		}

		if (eagerTargets.size === 0) return;

		const nameIndex = this.eagerSubSessionIds.get(taskId) ?? new Map<string, string>();

		for (const [agentName, { slot, nodeId }] of eagerTargets) {
			try {
				// Stable per-agent session ID so the DB row survives daemon restarts
				// without needing a NodeExecution link.
				const baseSessionId = `space:${spaceId}:task:${taskId}:agent:${this.sanitizeAgentNameForId(agentName)}`;
				const sessionId = this.resolveSessionId(baseSessionId);

				const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
				const slotOverrides = this.buildSlotOverrides(slot, {
					node,
					workflow,
					workflowRun,
				});

				let init = resolveAgentInit({
					task,
					space,
					agentManager: this.config.spaceAgentManager,
					sessionId,
					workspacePath,
					workflowRun,
					workflow,
					slotOverrides,
					agentId: slot.agentId!,
				});

				// Attach the same MCP server surface that spawnWorkflowNodeAgentForExecution
				// attaches, so the session is indistinguishable from a normally-spawned one
				// the moment the workflow activates its node.
				const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
					taskId,
					sessionId,
					agentName,
					spaceId,
					workflowRun.id,
					workspacePath,
					nodeId
				);
				init = {
					...init,
					mcpServers: {
						...init.mcpServers,
						'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
					},
				};

				// Create the session via fromInit (bypass createSubSession's reuse path
				// because we are the first caller and there's nothing to reuse yet).
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

				// Merge registry-sourced MCP servers alongside the per-session ones.
				// Resolve via the session-aware resolver so scope='space' / scope='session'
				// overrides in `mcp_enablement` are honoured.
				const registryMcpServers =
					this.config.appMcpManager?.getEnabledMcpConfigsForSession({
						id: sessionId,
						context: { spaceId },
					}) ?? {};
				const mergedMcpServers = {
					...registryMcpServers,
					...init.mcpServers,
				};
				if (Object.keys(mergedMcpServers).length > 0) {
					subSession.mergeRuntimeMcpServers(mergedMcpServers);
				}

				// Register in the same in-memory maps as normal sub-sessions so the rest
				// of the manager can find them transparently.
				if (!this.subSessions.has(taskId)) {
					this.subSessions.set(taskId, new Map());
				}
				this.subSessions.get(taskId)!.set(sessionId, subSession);
				this.agentSessionIndex.set(sessionId, subSession);
				this.config.sessionManager.registerSession(subSession);

				// Record in the eager index so createSubSession's reuse path picks this up
				// on the real node activation.
				nameIndex.set(agentName, sessionId);

				// Start the streaming query so the SDK subprocess launches and emits its
				// init message. No kickoff user message — the session sits idle until the
				// workflow activation triggers the real spawn call.
				await subSession.startStreamingQuery();
				try {
					await subSession.awaitSdkSessionCaptured(15_000);
				} catch (err) {
					log.warn(
						`TaskAgentManager.eagerlySpawn: sdkSessionId capture timed out for eager sub-session ${sessionId} (agent=${agentName}): ${err instanceof Error ? err.message : String(err)}`
					);
				}

				log.info(
					`TaskAgentManager.eagerlySpawn: pre-spawned sub-session ${sessionId} for agent "${agentName}" (task ${taskId}, node ${nodeId})`
				);
			} catch (err) {
				log.warn(
					`TaskAgentManager.eagerlySpawn: failed to pre-spawn sub-session for agent "${agentName}" (task ${taskId}): ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}

		if (nameIndex.size > 0) {
			this.eagerSubSessionIds.set(taskId, nameIndex);
		}
	}

	/**
	 * Sanitize an agent slot name so it is safe to use as a component of a
	 * session ID: lowercase, alphanumerics + single hyphens, max 40 chars.
	 */
	private sanitizeAgentNameForId(name: string): string {
		return (
			name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-+|-+$/g, '')
				.slice(0, 40) || 'agent'
		);
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
		//
		// Eager-spawn fast path: when `eagerlySpawnWorkflowNodeAgents()` has
		// pre-created a session for this agent name at task-start time, no
		// NodeExecution row with `agentSessionId` exists yet. Resolve the
		// eager session directly from the in-memory index so the reuse logic
		// below picks it up instead of creating a second session.
		if (memberInfo?.agentName) {
			const parentTask = this.config.taskRepo.getTask(taskId);
			if (parentTask?.workflowRunId) {
				const eagerSessionId = this.eagerSubSessionIds.get(taskId)?.get(memberInfo.agentName);
				let prevExec = this.config.nodeExecutionRepo
					.listByWorkflowRun(parentTask.workflowRunId)
					.filter((e) => e.agentName === memberInfo.agentName && e.agentSessionId)
					// listByWorkflowRun returns rows ORDER BY created_at ASC, so .at(-1) is the most recent.
					.at(-1);
				if (!prevExec && eagerSessionId) {
					// Synthesize a pseudo-execution record pointing at the eager session
					// so the downstream reuse logic applies without duplicating it.
					prevExec = {
						id: '',
						workflowRunId: parentTask.workflowRunId,
						workflowNodeId: memberInfo.nodeId ?? '',
						agentName: memberInfo.agentName,
						agentId: memberInfo.agentId ?? null,
						agentSessionId: eagerSessionId,
						status: 'pending',
						result: null,
						data: null,
						createdAt: 0,
						startedAt: null,
						completedAt: null,
						updatedAt: 0,
					};
				}
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

						// Point the new NodeExecution at the existing session ID and mark it active.
						if (memberInfo.nodeId) {
							const nodeExecs = this.config.nodeExecutionRepo.listByNode(
								parentTask.workflowRunId,
								memberInfo.nodeId
							);
							const match =
								nodeExecs.find((e) => e.agentName === memberInfo.agentName && !e.agentSessionId) ??
								nodeExecs.find(
									(e) =>
										e.agentName === memberInfo.agentName && e.agentSessionId === existingSessionId
								);
							if (match) {
								this.config.nodeExecutionRepo.update(match.id, {
									status: 'in_progress',
									agentSessionId: existingSessionId,
									startedAt: match.startedAt ?? Date.now(),
									completedAt: null,
								});
							}
						}

						// P1-4: Rebuild the node-agent MCP server with the new node context.
						//
						// When a session is reused across workflow node activations (e.g. a Coder
						// that processes multiple review cycles), its previous `node-agent` closure
						// captures the OLD workflowNodeId, workspaceRunId, and channel resolver.
						// `send_message` uses workflowNodeId to resolve the "from" node — if stale,
						// the topology check fails or routes incorrectly ("message never arrived").
						//
						// Re-merging with a fresh node-agent and restarting the query ensures the
						// session's tool surface reflects the new node activation context.
						//
						// Re-inject node-agent and enforce the required-server invariant on
						// the reused session. Node agents intentionally do not receive
						// space-agent-tools; task creation is mirrored onto node-agent instead.
						if (memberInfo.nodeId) {
							const reuseWorkspacePath = this.taskWorktreePaths.get(taskId) ?? init.workspacePath;
							const reuseCtx = {
								taskId,
								subSessionId: existingSessionId,
								agentName: memberInfo.agentName,
								spaceId: parentTask.spaceId,
								workflowRunId: parentTask.workflowRunId,
								workspacePath: reuseWorkspacePath,
								workflowNodeId: memberInfo.nodeId,
							};
							// Unconditionally rebuild node-agent (fresh node context).
							await this.reinjectNodeAgentMcpServer(existing, reuseCtx);
							await this.ensureRequiredMcpServersAttached(existing, {
								...reuseCtx,
								phase: 'spawn',
							});
						}

						// Register a fresh completion callback for this execution turn.
						// Clear any stale callback registered by a previous execution (e.g. from
						// rehydrateSubSession, which registers with the old nodeId). Without this,
						// two callbacks would fire on the next idle: one for the old execution and
						// one for the new — causing duplicate completion handling.
						if (memberInfo.nodeId) {
							this.completionCallbacks.delete(existingSessionId);
							this.registerCompletionCallback(existingSessionId, async () => {
								await this.handleSubSessionComplete(taskId, memberInfo.nodeId!, existingSessionId);
							});
						}

						// P1-5: Register the self-heal callback so QueryRunner.start() can
						// recover the session if MCP servers go missing at any point in its
						// lifetime (not just at spawn). The callback fires inside the
						// workflow sub-session's first-turn setup window — the latest point
						// before the agent tries to call send_message.
						existing.onMissingWorkflowMcpServers = async (
							cbSessionId: string,
							missing: string[]
						) => {
							await this.mcpSelfHeal(cbSessionId, missing);
						};

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
		// Session-aware resolver — scope='space' / scope='session' overrides apply.
		const subSessionSpaceId = this.config.taskRepo.getTask(taskId)?.spaceId;
		const subSessionRegistryMcpServers =
			this.config.appMcpManager?.getEnabledMcpConfigsForSession({
				id: sessionId,
				context: subSessionSpaceId ? { spaceId: subSessionSpaceId } : {},
			}) ?? {};
		const mergedSubSessionMcpServers = {
			...subSessionRegistryMcpServers,
			...init.mcpServers,
		};
		if (Object.keys(mergedSubSessionMcpServers).length > 0) {
			// Use merge semantics: the session is freshly created here so the map is
			// empty in practice, but mergeRuntimeMcpServers is safer than the deprecated
			// replace-all setRuntimeMcpServers because it won't clobber servers injected
			// by a concurrent subsystem before this path runs.
			subSession.mergeRuntimeMcpServers(mergedSubSessionMcpServers);
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

		// Write active execution state on the matching NodeExecution record so that
		// AgentMessageRouter, sibling cleanup, timeout tracking, and live-query SQL
		// can resolve the session. Requires nodeId (workflowNodeId) and agentName.
		if (memberInfo?.nodeId && memberInfo.agentName) {
			const parentTask = this.config.taskRepo.getTask(taskId);
			if (parentTask?.workflowRunId) {
				const nodeExecs = this.config.nodeExecutionRepo.listByNode(
					parentTask.workflowRunId,
					memberInfo.nodeId
				);
				const match = nodeExecs.find((e) => e.agentName === memberInfo.agentName);
				if (match && !match.agentSessionId) {
					this.config.nodeExecutionRepo.update(match.id, {
						status: 'in_progress',
						agentSessionId: sessionId,
						startedAt: match.startedAt ?? Date.now(),
						completedAt: null,
					});
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

		// P1-5: Register the self-heal callback (see reuse path above for rationale).
		// mcpSelfHeal does its own context lookup so no pre-computation needed here.
		subSession.onMissingWorkflowMcpServers = async (cbSessionId: string, missing: string[]) => {
			await this.mcpSelfHeal(cbSessionId, missing);
		};

		// Start streaming query for the sub-session.
		//
		// We intentionally do NOT await sdkSessionId capture on this path.
		// The belt-and-braces "block until init" guarantee lives in
		// `eagerlySpawnWorkflowNodeAgents`, which runs at the earliest point
		// we have enough context to pre-create node-agent sessions. Blocking
		// here regresses the kickoff path: when `spawnWorkflowNodeAgentForExecution`
		// is called directly from `processRunTick` (no eager spawn yet), the
		// caller immediately wants to inject the kickoff user message. A 15s
		// wait ahead of that injection delays kickoff and — if the SDK init
		// message is slow (dev-proxy) or never arrives — converts to a hard
		// failure in the caller's `saveUserMessage` via the foreign-key path.
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
			const isSyntheticMessage = row.sourceAgentName !== 'human';
			try {
				await this.injectSubSessionMessage(sessionId, prefixed, isSyntheticMessage);
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
	 * Best-effort attempt to resume a node-agent session and drain its pending
	 * message queue immediately after a message has been queued for it.
	 *
	 * Called by send_message (task-agent-tools) right after `pendingMessageRepo.enqueue()`
	 * so that if the target already has a known session (e.g. it ran before and is now
	 * idle/completed), the queued message is delivered without waiting for the next
	 * activation trigger.
	 *
	 * Flow:
	 *  1. Look for the most recent NodeExecution for this agent that has an `agentSessionId`.
	 *  2. If found, look up the session in memory (fast path) or lazily rehydrate it from DB.
	 *  3. If the session is live, call `flushPendingMessagesForTarget` to drain the queue.
	 *
	 * Idempotent and non-fatal — if the session cannot be found or restored the queue
	 * is left intact for the next activation (e.g. when `createSubSession` spawns/reuses
	 * the session and calls `flushPendingMessagesForTarget`).
	 */
	async tryResumeNodeAgentSession(workflowRunId: string, agentName: string): Promise<void> {
		const repo = this.config.pendingMessageRepo;
		if (!repo) return;

		const executions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
		const exec = executions.filter((e) => e.agentName === agentName && e.agentSessionId).at(-1);
		if (!exec?.agentSessionId) return; // No known session for this agent — wait for spawn.

		const sessionId = exec.agentSessionId;

		if (this.agentSessionIndex.has(sessionId)) {
			// Fast path: session is already live in memory — flush pending messages directly.
			await this.flushPendingMessagesForTarget(workflowRunId, agentName, sessionId);
		} else {
			// Slow path: session is not in memory (e.g. after daemon restart).
			// rehydrateSubSession restores it AND calls flushPendingMessagesForTarget internally.
			await this.rehydrateSubSession(sessionId);
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
	async injectSubSessionMessage(
		subSessionId: string,
		message: string,
		isSyntheticMessage = true
	): Promise<void> {
		const indexed = this.agentSessionIndex.get(subSessionId);
		if (indexed) {
			await this.injectMessageIntoSession(
				indexed,
				message,
				'immediate',
				undefined,
				isSyntheticMessage
			);
			return;
		}

		// Find the sub-session by ID across all task maps
		for (const [, nodeMap] of this.subSessions) {
			const session = nodeMap.get(subSessionId);
			if (session) {
				await this.injectMessageIntoSession(
					session,
					message,
					'immediate',
					undefined,
					isSyntheticMessage
				);
				return;
			}
		}

		// Not in memory — attempt lazy rehydration from DB
		const rehydrated = await this.rehydrateSubSession(subSessionId);
		if (rehydrated) {
			await this.injectMessageIntoSession(
				rehydrated,
				message,
				'immediate',
				undefined,
				isSyntheticMessage
			);
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

	/**
	 * Return every agent slot name declared in the static workflow definition
	 * for this task, regardless of whether a `node_execution` row exists or a
	 * session has been spawned. The workflow definition is the canonical source
	 * for "is this a known peer?" — node_executions are lazily created when a
	 * node is first activated, so they cannot stand in for it.
	 *
	 * Used by `send_message` to widen the queueable / reachable target set so
	 * declared-but-not-yet-spawned peers can receive lazy activation rather
	 * than failing with `notFoundAgentNames`.
	 *
	 * Returns `[]` if the task has no workflow run, or the workflow / run lookup
	 * fails (e.g. on a standalone task).
	 */
	getWorkflowDeclaredAgentNamesForTask(taskId: string): string[] {
		const task = this.config.taskRepo.getTask(taskId);
		if (!task?.workflowRunId) return [];
		const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
		if (!run?.workflowId) return [];
		const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
		if (!workflow) return [];
		const names = new Set<string>();
		for (const node of workflow.nodes) {
			let slots: ReturnType<typeof resolveNodeAgents>;
			try {
				slots = resolveNodeAgents(node);
			} catch {
				// Defensive: a malformed node should not poison the lookup of valid siblings.
				continue;
			}
			for (const slot of slots) {
				names.add(slot.name);
			}
		}
		return [...names];
	}

	/**
	 * Lazily ensure a node_execution row exists for the workflow node that owns
	 * `agentName` so that the SpaceRuntime tick loop will spawn its session.
	 *
	 * Used by the Task Agent `send_message` queue path when the target is a
	 * workflow-declared peer that has never been activated. Without this hop
	 * the queue would fill but no spawn would ever fire — the `pendingMessageRepo`
	 * is drained only when the target session activates, which itself requires a
	 * node_execution row to exist.
	 *
	 * Idempotent: `ChannelRouter.activateNode` is a no-op when active executions
	 * already exist for the node, and `createOrIgnore` makes the underlying row
	 * write safe under concurrent activation requests.
	 *
	 * Resolution:
	 *  1. Look up the task → workflowRun → workflow.
	 *  2. Find the workflow node whose `resolveNodeAgents()` includes `agentName`.
	 *  3. Build a ChannelRouter (mirrors `buildNodeAgentMcpServerForSession`) and
	 *     call `activateNode(runId, nodeId)`.
	 *
	 * Returns `false` when the agent is not declared in the workflow, or when
	 * any required dependency is missing (best-effort — never throws).
	 */
	async activateTargetSessionsForMessage(
		taskId: string,
		workflowRunId: string,
		agentName: string,
		options?: { reopenReason?: string; reopenBy?: string }
	): Promise<Array<{ agentName: string; sessionId: string }>> {
		await this.tryResumeNodeAgentSession(workflowRunId, agentName);
		const existing = this.config.nodeExecutionRepo
			.listByWorkflowRun(workflowRunId)
			.filter((execution) => execution.agentName === agentName && execution.agentSessionId)
			.at(-1);
		if (existing?.agentSessionId) {
			if (this.isSessionAlive(existing.agentSessionId)) {
				return [{ agentName, sessionId: existing.agentSessionId }];
			}
			this.config.nodeExecutionRepo.update(existing.id, {
				agentSessionId: null,
				status: 'pending',
			});
		}

		await this.ensureWorkflowNodeActivationForAgent(taskId, agentName, options);

		const task = this.config.taskRepo.getTask(taskId);
		const run = this.config.workflowRunRepo.getRun(workflowRunId);
		const workflow = run?.workflowId
			? this.config.spaceWorkflowManager.getWorkflow(run.workflowId)
			: null;
		const space = task ? await this.config.spaceManager.getSpace(task.spaceId) : null;
		if (!task || !run || !workflow || !space) return [];

		const execution = this.config.nodeExecutionRepo
			.listByWorkflowRun(workflowRunId)
			.find((candidate) => candidate.agentName === agentName);
		if (!execution) return [];

		const spawnPromise = this.spawnWorkflowNodeAgentForExecution(
			task,
			space,
			workflow,
			run,
			execution
		);
		const timeoutMs = 30_000;
		const timeoutPromise = new Promise<null>((resolve) => {
			setTimeout(() => resolve(null), timeoutMs);
		});
		const sessionId = await Promise.race([spawnPromise, timeoutPromise]);
		if (!sessionId) {
			log.warn(
				`TaskAgentManager.activateTargetSessionsForMessage: timed out after ${timeoutMs}ms activating agent "${agentName}" for run ${workflowRunId}`
			);
			return [];
		}
		return [{ agentName, sessionId }];
	}

	async ensureWorkflowNodeActivationForAgent(
		taskId: string,
		agentName: string,
		options?: { reopenReason?: string; reopenBy?: string }
	): Promise<boolean> {
		try {
			const task = this.config.taskRepo.getTask(taskId);
			if (!task?.workflowRunId) return false;
			const run = this.config.workflowRunRepo.getRun(task.workflowRunId);
			if (!run?.workflowId) return false;
			const workflow = this.config.spaceWorkflowManager.getWorkflow(run.workflowId);
			if (!workflow) return false;
			const spaceManager = this.config.spaceManager;
			const space = await spaceManager.getSpace(task.spaceId);
			if (!space) return false;

			// Find the node whose declared agent slots include `agentName`.
			let targetNodeId: string | null = null;
			for (const node of workflow.nodes) {
				let slots: ReturnType<typeof resolveNodeAgents>;
				try {
					slots = resolveNodeAgents(node);
				} catch {
					continue;
				}
				if (slots.some((slot) => slot.name === agentName)) {
					targetNodeId = node.id;
					break;
				}
			}
			if (!targetNodeId) return false;

			const channelRouter = new ChannelRouter({
				taskRepo: this.config.taskRepo,
				workflowRunRepo: this.config.workflowRunRepo,
				workflowManager: this.config.spaceWorkflowManager,
				agentManager: this.config.spaceAgentManager,
				nodeExecutionRepo: this.config.nodeExecutionRepo,
				gateDataRepo: this.config.gateDataRepo,
				channelCycleRepo: this.config.channelCycleRepo,
				db: this.config.db.getDatabase(),
				// Mirror the canonical resolution used by spawn/rehydrate paths:
				// prefer the cached worktree path (with DB-sync fallback inside
				// `getTaskWorktreePath`), and fall back to the space root if no
				// worktree exists yet for this task.
				workspacePath: this.getTaskWorktreePath(taskId) ?? space.workspacePath,
				getSpaceAutonomyLevel: async (spaceId) => {
					const s = await spaceManager.getSpace(spaceId);
					return s?.autonomyLevel ?? 1;
				},
				isSessionAlive: (sid) => this.isSessionAlive(sid),
				cancelSessionById: (sid) => this.cancelBySessionId(sid),
				notificationSink: this.config.spaceRuntimeService.getSharedRuntime().getNotificationSink(),
				onGatePendingApproval: (runId, gateId) =>
					this.config.spaceRuntimeService.handleGatePendingApproval(runId, gateId),
			});

			await channelRouter.activateNode(run.id, targetNodeId, {
				reopenReason: options?.reopenReason ?? `lazy activation of agent "${agentName}"`,
				reopenBy: options?.reopenBy ?? 'task-agent',
			});
			return true;
		} catch (err) {
			log.warn(
				`TaskAgentManager.ensureWorkflowNodeActivationForAgent: ` +
					`failed for taskId=${taskId} agentName=${agentName}: ` +
					(err instanceof Error ? err.message : String(err))
			);
			return false;
		}
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
	 *
	 * Source of truth is the `space_worktrees` table (populated at worktree-creation
	 * time and kept there for the full task lifetime). The in-memory map is a cache
	 * populated on spawn/rehydrate; on cache miss we fall back to a sync DB read so
	 * callers after a daemon restart or ad-hoc RPC access still get the right path
	 * without needing a prior in-memory warm-up.
	 */
	getTaskWorktreePath(taskId: string): string | undefined {
		const cached = this.taskWorktreePaths.get(taskId);
		if (cached) return cached;
		if (!this.config.worktreeManager) return undefined;
		const task = this.config.taskRepo.getTask(taskId);
		if (!task) return undefined;
		const stored = this.config.worktreeManager.getTaskWorktreePathSync(task.spaceId, task.id);
		if (stored) {
			// Warm the cache so subsequent reads hit the fast path.
			this.taskWorktreePaths.set(taskId, stored);
			return stored;
		}
		return undefined;
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

	/**
	 * Look up an AgentSession by its session ID across every in-memory map this
	 * manager owns. Used by reapers (e.g. SpaceRuntime force-completion) that
	 * have only the session ID and need to inspect/mutate the session before
	 * reaping it (e.g. clear an orphaned AskUserQuestion card).
	 *
	 * Lookup order (mirrors `isSessionAlive`):
	 *  1. `agentSessionIndex` (fast reverse index for sub-sessions)
	 *  2. `taskAgentSessions` map (Task Agents)
	 *  3. `SessionManager.getSession()` (general session cache)
	 *
	 * Step 3 may **lazy-hydrate** an AgentSession from the database if it's
	 * not currently in any in-memory map — this is intentional, because:
	 *
	 *  - The hydrated `AgentSession` constructor calls
	 *    `ProcessingStateManager.restoreFromDatabase()`, which preserves
	 *    `waiting_for_input` state across daemon restarts (see
	 *    `processing-state-manager.ts:62-65`). So `getProcessingState()`
	 *    on a hydrated session returns the *persisted* status, not `idle`.
	 *  - The Step 1.5 "spare waiting_for_input" guard relies on this
	 *    lazy hydration: after a daemon restart, before any explicit
	 *    rehydrate path runs, this lookup is what the runtime uses to
	 *    detect that a session is still waiting on the user.
	 *
	 * Caveat: hydration *does* have side effects (event subscriptions,
	 * orphaned-message recovery, cache insertion). In practice this is
	 * fine because callers reach this method only after `isSessionAlive`
	 * has already triggered the same lookup, so hydration happens at most
	 * once per session per tick.
	 *
	 * Returns undefined when the session is not in memory and either does
	 * not exist in the DB or fails to load.
	 */
	getAgentSessionById(sessionId: string): AgentSession | undefined {
		const indexed = this.agentSessionIndex.get(sessionId);
		if (indexed) return indexed;

		for (const taskAgent of this.taskAgentSessions.values()) {
			if (taskAgent.session.id === sessionId) return taskAgent;
		}

		// SessionManager.getSession may hydrate a fresh AgentSession from DB;
		// that's intentional — see method JSDoc for why. Normalize null → undefined
		// so the return contract stays uniform.
		return this.config.sessionManager.getSession(sessionId) ?? undefined;
	}

	/**
	 * Prepare an existing node-agent sub-session for workflow resume/reopen.
	 *
	 * The caller has already verified the NodeExecution row is still bound to a
	 * live session. Re-run the same runtime MCP attachment path used by self-heal
	 * so a resumed workflow has node-agent available even if
	 * the in-memory session was restored from DB without workflow MCP servers.
	 */
	async prepareSubSessionForWorkflowResume(sessionId: string): Promise<boolean> {
		if (!this.isSessionAlive(sessionId)) return false;
		const session = this.getAgentSessionById(sessionId);
		if (!session) return false;
		await this.mcpSelfHeal(sessionId, ['node-agent']);
		return true;
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
		// Task #85 invariant: only UI archive/delete RPCs may touch the DB row,
		// worktree, or SDK .jsonl files. Workflow-driven cancellation only stops
		// the in-memory SDK subprocess so the DB row + sdk_messages remain
		// readable from the UI afterwards.
		void this.stopSessionPreserveDb(agentSessionId, session).catch((err) => {
			log.warn(
				`TaskAgentManager.cancelBySessionId: failed to stop session ${agentSessionId}:`,
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
	 * Queries `space_tasks` for tasks with status `in_progress`, `review`,
	 * `blocked`, or `approved` that have a non-null `taskAgentSessionId`. For
	 * each such task that has a `space_task_agent` session type in the DB,
	 * restores the Task Agent session via `AgentSession.restore()`, re-attaches
	 * the MCP server and system prompt, restarts the streaming query, and
	 * injects a re-orientation message so the agent resumes from where it left
	 * off. See `SpaceTaskRepository.listActiveWithTaskAgentSession` for the
	 * full justification of which statuses are included.
	 *
	 * After each Task Agent is restored, `rehydrateTaskAgent` also eagerly
	 * rehydrates every workflow sub-session attached to its workflow run via
	 * `rehydrateSubSessionsForRun` — see that method for the full rationale.
	 * Without that step, sub-sessions whose `node-agent` MCP server is
	 * in-process-only would silently sit without it after a restart, breaking
	 * peer messaging the moment a UI overlay or peer message reached them
	 * (task #126 failure mode).
	 *
	 * This method is called from `SpaceRuntime.rehydrateExecutors()` after
	 * WorkflowExecutors are loaded, so executors are ready when Task Agents run.
	 */
	async rehydrate(): Promise<void> {
		const activeTasks = this.config.taskRepo.listActiveWithTaskAgentSession();

		let attempted = 0;
		let failed = 0;
		let selfHealed = 0;

		for (const task of activeTasks) {
			const sessionId = task.taskAgentSessionId;
			if (!sessionId) continue;

			// Skip if already in the map (e.g. double rehydrate call)
			if (this.taskAgentSessions.has(task.id)) continue;

			const dbSession = this.config.db.getSession(sessionId);
			if (!dbSession || dbSession.type !== 'space_task_agent') {
				// Dangling FK: task still references a session that no longer exists
				// in the DB (or was replaced by another type). Clear the reference so
				// the UI's `spaceTaskActivity.byTask` LiveQuery stops inner-joining on
				// a ghost row (which hides the task agent and canvas) and so the task
				// becomes eligible to spawn a fresh Task Agent on its next run.
				log.warn(
					`TaskAgentManager.rehydrate: task ${task.id} references missing session ${sessionId} — clearing dangling task_agent_session_id`
				);
				try {
					this.config.taskRepo.updateTask(task.id, { taskAgentSessionId: null });
					selfHealed++;
				} catch (err) {
					log.warn(
						`TaskAgentManager.rehydrate: failed to clear dangling task_agent_session_id for task ${task.id}:`,
						err
					);
				}
				continue;
			}

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
			`TaskAgentManager.rehydrate: attempted=${attempted} succeeded=${succeeded} failed=${failed} selfHealed=${selfHealed}`
		);
	}

	/**
	 * Stop all active Task Agent sessions and their sub-sessions for daemon shutdown.
	 *
	 * **Preserves DB state** so that `rehydrate()` can restore every task on the next
	 * daemon start. Specifically:
	 * - Does NOT delete the session DB row (would orphan `space_tasks.task_agent_session_id`
	 *   and break the `spaceTaskActivity.byTask` LiveQuery that feeds the Task Agent /
	 *   reviewer dropdown and canvas).
	 * - Does NOT mark worktrees completed (the task is still in progress; marking it
	 *   completed starts the 7-day TTL reaper clock).
	 *
	 * Steps per task:
	 * 1. Interrupt and cleanup the in-memory AgentSession (stops SDK query & subprocesses).
	 *    `stopSessionPreserveDb` also unsubscribes session.updated listeners and
	 *    drops completion callbacks for each session ID.
	 * 2. Close db-query MCP server file handles.
	 * 3. Clear in-memory maps so a subsequent rehydrate starts from a clean slate.
	 */
	async cleanupAll(): Promise<void> {
		if (this.taskArchiveListenerUnsub) {
			this.taskArchiveListenerUnsub();
			this.taskArchiveListenerUnsub = null;
		}
		const taskIds = Array.from(this.taskAgentSessions.keys());
		await Promise.allSettled(taskIds.map((taskId) => this.shutdownTask(taskId)));
		log.info(`TaskAgentManager: cleanupAll complete (${taskIds.length} tasks shut down)`);
	}

	/**
	 * Stop all in-memory resources for a task without touching DB state.
	 * Used by shutdown only — for task completion / cancellation use `cleanup()`.
	 */
	private async shutdownTask(taskId: string): Promise<void> {
		// 1. Stop sub-sessions (interrupt + cleanup, no DB delete).
		// stopSessionPreserveDb unsubscribes listeners and drops completion
		// callbacks for each session ID as part of its teardown.
		const nodeMap = this.subSessions.get(taskId);
		if (nodeMap) {
			for (const [subSessionId, session] of nodeMap) {
				await this.stopSessionPreserveDb(subSessionId, session);
				this.agentSessionIndex.delete(subSessionId);
			}
			this.subSessions.delete(taskId);
		}

		// 2. Stop Task Agent session
		const taskAgentSession = this.taskAgentSessions.get(taskId);
		if (taskAgentSession) {
			await this.stopSessionPreserveDb(taskAgentSession.session.id, taskAgentSession);
			this.taskAgentSessions.delete(taskId);
		}

		// 3. Drop the in-memory worktree path (DB record is preserved)
		this.taskWorktreePaths.delete(taskId);

		// Drop the eager sub-session index (DB NodeExecution rows are preserved).
		this.eagerSubSessionIds.delete(taskId);

		// 4. Close db-query server to release SQLite handles held by the session
		const dbQueryServer = this.taskDbQueryServers.get(taskId);
		if (dbQueryServer) {
			try {
				dbQueryServer.close();
			} catch (err) {
				log.warn(`TaskAgentManager: failed to close db-query server for task ${taskId}:`, err);
			}
			this.taskDbQueryServers.delete(taskId);
		}

		log.info(`TaskAgentManager: shutdown complete for task ${taskId} (DB state preserved)`);
	}

	/**
	 * Stop all in-memory resources for a task **without deleting any persisted state**.
	 *
	 * Task #85 invariant: the only code paths allowed to remove a session's
	 * worktree, SDK `.jsonl` files, or DB row are the two UI RPC handlers
	 * (`session.archive`/`task.archive` and `session.delete`/`room.delete`).
	 * Every other lifecycle event — task done, task cancelled, workflow end,
	 * daemon shutdown, spawn rollback — must preserve persisted state and
	 * only interrupt the in-memory SDK subprocess so the user keeps their
	 * conversation history, worktree checkout, and session metadata.
	 *
	 * This method:
	 *   - Interrupts and cleans up every in-memory AgentSession for the task.
	 *   - Drops completion callbacks and session listeners.
	 *   - Clears in-memory maps (`subSessions`, `taskAgentSessions`,
	 *     `taskWorktreePaths`, `taskDbQueryServers`, `agentSessionIndex`).
	 *   - Closes any db-query MCP server file handles.
	 *
	 * It does NOT delete any DB row, remove any worktree, or archive any
	 * SDK files. Marking the worktree `completed` also belongs to archive
	 * (which moves the worktree entirely) — so neither
	 * `removeTaskWorktree` nor `markTaskWorktreeCompleted` is called here.
	 *
	 * @param taskId - The task to clean up.
	 * @param reason - Retained for logging only; behavior is identical for
	 *                'done' and 'cancelled'.
	 */
	async cleanup(taskId: string, reason: 'done' | 'cancelled' = 'done'): Promise<void> {
		const sessionIdsToClean = new Set<string>();

		// 1. Stop sub-sessions (interrupt + cleanup, preserve DB).
		const nodeMap = this.subSessions.get(taskId);
		if (nodeMap) {
			for (const [subSessionId, session] of nodeMap) {
				sessionIdsToClean.add(subSessionId);
				await this.stopSessionPreserveDb(subSessionId, session);
			}
			this.subSessions.delete(taskId);
			for (const sid of sessionIdsToClean) {
				this.agentSessionIndex.delete(sid);
			}
		}

		// 2. Stop Task Agent session (interrupt + cleanup, preserve DB).
		const taskAgentSession = this.taskAgentSessions.get(taskId);
		if (taskAgentSession) {
			const agentSessionId = taskAgentSession.session.id;
			sessionIdsToClean.add(agentSessionId);
			await this.stopSessionPreserveDb(agentSessionId, taskAgentSession);
			this.taskAgentSessions.delete(taskId);
		}

		// 3. stopSessionPreserveDb already removed per-session listeners and
		// completion callbacks, but run the cleanup defensively in case any
		// stragglers slipped in through a different registration path.
		for (const sessionId of sessionIdsToClean) {
			this.completionCallbacks.delete(sessionId);
			const unsub = this.sessionListeners.get(sessionId);
			if (unsub) {
				unsub();
				this.sessionListeners.delete(sessionId);
			}
		}

		// 4. Drop the in-memory worktree path. The on-disk worktree is
		// preserved — archive is the only path that removes it.
		this.taskWorktreePaths.delete(taskId);

		// 5. Drop the eager sub-session index.
		this.eagerSubSessionIds.delete(taskId);

		// 6. Close db-query server connection for this task.
		const dbQueryServer = this.taskDbQueryServers.get(taskId);
		if (dbQueryServer) {
			try {
				dbQueryServer.close();
			} catch (err) {
				log.warn(`TaskAgentManager: failed to close db-query server for task ${taskId}:`, err);
			}
			this.taskDbQueryServers.delete(taskId);
		}

		log.info(
			`TaskAgentManager: cleaned up in-memory state for task ${taskId} (reason: ${reason}, DB + worktree preserved)`
		);
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
	 * finishes naturally — completion is signaled by `task.reportedStatus`.
	 * Normal completion is runtime-owned and does not notify the Task Agent.
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
			`[NODE_FAILED] Node "${failedNodeId}" sub-session (${subSessionId}) reported an error: ${error}\nEscalation reason: ${RUNTIME_ESCALATION_REASONS.NODE_FAILURE}\nWorkflow progression is runtime-driven; use this as context for human coordination only.`,
			'defer'
		);
	}

	/**
	 * Build a runtime contract for a specific node execution from the current
	 * workflow graph, including gate requirements derived from outbound channels.
	 *
	 * The `space` argument is used to determine whether `approve_task` is
	 * currently unlocked by the space's autonomy level. When unlocked, the
	 * prompt tells the agent it can self-close; otherwise the prompt tells the
	 * agent that `submit_for_approval` is the only way to finalize. This keeps
	 * the system prompt aligned with what the MCP handler actually enforces at
	 * call time.
	 */
	private buildNodeExecutionRuntimeContract(
		workflow: SpaceWorkflow | null,
		execution: NodeExecution,
		space: Space | null
	): string {
		const isEndNode = !!workflow?.endNodeId && execution.workflowNodeId === workflow.endNodeId;

		// Compute whether approve_task is currently unlocked for this space.
		// The MCP handler re-checks at call time, so this is purely for prompt
		// accuracy — the tool is registered unconditionally on end-node sessions.
		const spaceLevel = space?.autonomyLevel ?? 1;
		const requiredLevel = workflow?.completionAutonomyLevel ?? 5;
		const approveUnlocked = spaceLevel >= requiredLevel;

		// End-node tool contract:
		//   - save_artifact: persist typed data to artifact store (all node agents).
		//   - approve_task : self-close (autonomy-gated, end-node only).
		//   - submit_for_approval: human sign-off (always available, end-node only).
		// Keep these strings in sync with `node-agent-tools.ts` and
		// `task-agent-manager.ts` where the handlers live.
		const endNodeContractLines = (indent: string): string[] => {
			if (!isEndNode) return [];
			const lines: string[] = [];
			if (approveUnlocked) {
				lines.push(
					`${indent}- approve_task({}) — Close this task as done (self-approval). Unlocked for this space (autonomy ${spaceLevel} >= required ${requiredLevel}). Use as your FINAL action when you are satisfied the work is complete.`
				);
			} else {
				lines.push(
					`${indent}- approve_task({}) — NOT AVAILABLE: space autonomy ${spaceLevel} < workflow completionAutonomyLevel ${requiredLevel}. Do NOT call this tool; use submit_for_approval instead.`
				);
			}
			lines.push(
				`${indent}- submit_for_approval({ reason? }) — Request human sign-off. Always available to end-node agents. Use when autonomy blocks self-close OR the outcome is risky enough to escalate.`
			);
			return lines;
		};

		const fallback = [
			'## Runtime Execution Contract',
			`Role: "${execution.agentName}"`,
			'Tools available:',
			'  - send_message({ target, message, data? }) — communicate with peers; data is automatically written to the gate when the channel is gated',
			'  - save_artifact({ type, key?, append?, summary?, data? }) — persist typed data to the artifact store at any time. Use type="progress" for rolling status, type="result" for final outcomes.',
			...endNodeContractLines('  '),
			'  - list_artifacts({ nodeId?, type? }) — list artifacts for the current workflow run',
			'  - restore_node_agent({ reason? }) — self-heal fallback: if a previous mcp__node-agent__* call returned "No such tool available", call this once and then retry the original tool',
			'Only contact the task-agent via send_message if you are blocked or need human input.',
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
			`Agent: "${execution.agentName}"`,
			'Tools available:',
			'  - send_message({ target, message, data? }) — communicate with peers; when a channel is gated, `data` is automatically merged into the gate',
			'  - save_artifact({ type, key?, append?, summary?, data? }) — persist typed data to the artifact store. Use type="progress" for rolling status, type="result" for final outcomes.',
			...endNodeContractLines('  '),
			'  - list_artifacts({ nodeId?, type? }) — list artifacts for the current workflow run',
			'  - list_peers / list_reachable_agents / list_channels / list_gates / read_gate — discovery',
			'  - restore_node_agent({ reason? }) — self-heal fallback: if a previous mcp__node-agent__* call ever returned "No such tool available", call this once and then retry the original tool',
		];

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
					lines.push(
						`  - Gate definition not found in workflow (treat as blocked until fixed). Escalation reason: ${RUNTIME_ESCALATION_REASONS.AMBIGUOUS_GATE}.`
					);
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
			if (approveUnlocked) {
				lines.push(
					'When your work is complete: (1) call save_artifact({ type: "result", append: true, summary: "..." }) to record the outcome, then (2) call approve_task({}) as your FINAL action to close the task. The runtime — not your artifact — decides the terminal status via completion actions.'
				);
			} else {
				lines.push(
					'When your work is complete: (1) call save_artifact({ type: "result", append: true, summary: "..." }) to record the outcome, then (2) call submit_for_approval({ reason: "..." }) as your FINAL action. approve_task is NOT available at this autonomy level; only a human can finalize.'
				);
			}
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

		if (node.name) {
			for (const variant of this.agentNameVariants(node.name)) {
				aliases.add(variant);
			}
		}

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
	 * 7. Eagerly rehydrates every workflow sub-session attached to the workflow
	 *    run via `rehydrateSubSessionsForRun`, so the in-process `node-agent`
	 *    and `space-agent-tools` MCP servers are re-attached BEFORE any UI
	 *    overlay or peer message can reach a sub-session (task #126 fix).
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
			this.config.appMcpServerRepo,
			{ autoReplayPendingMessages: false }
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
				this.injectSubSessionMessage(subSessionId, message, true),
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
			artifactRepo: this.config.artifactRepo,
		});

		// Merge registry-sourced MCP servers alongside the in-process task-agent server,
		// mirroring the same logic in spawnTaskAgent() so rehydrated sessions have the
		// same MCP configuration as freshly spawned ones. Session-aware resolver
		// — scope='space' / scope='session' overrides survive restarts.
		const rehydrateRegistryMcpServers =
			this.config.appMcpManager?.getEnabledMcpConfigsForSession({
				id: sessionId,
				context: { spaceId },
			}) ?? {};
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

		// Re-attach `space-agent-tools` so the rehydrated task agent has the same
		// tool surface as a freshly spawned task agent. This server is not persisted to
		// DB (see session-repository.ts) and is not re-attached by SpaceRuntimeService
		// because rehydrated sessions do not fire the `session.created` event that the
		// service subscribes to. Without this, the task agent cannot call list_peers /
		// send_message / read_gate / etc. after a daemon restart.
		const rehydrateSpaceAgentMcpServer = createSpaceAgentMcpServer({
			spaceId,
			runtime: this.config.spaceRuntimeService.getSharedRuntime(),
			workflowManager: this.config.spaceWorkflowManager,
			spaceManager: this.config.spaceManager,
			taskRepo: this.config.taskRepo,
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			taskManager,
			spaceAgentManager: this.config.spaceAgentManager,
			taskAgentManager: this,
			gateDataRepo: this.config.gateDataRepo,
			daemonHub: this.config.daemonHub,
			onGateChanged: (runId, gateId) => {
				void this.config.spaceRuntimeService.notifyGateDataChanged(runId, gateId).catch(() => {});
			},
			pendingMessageQueue: this.config.pendingMessageRepo,
			getSpaceAutonomyLevel: async (sid) => {
				const s = await this.config.spaceManager.getSpace(sid);
				return s?.autonomyLevel ?? 1;
			},
			myAgentName: 'task-agent',
		});
		rehydrateMcpServers['space-agent-tools'] =
			rehydrateSpaceAgentMcpServer as unknown as McpServerConfig;

		// Use merge semantics: the restored session has no in-memory MCP servers
		// (they are stripped from DB persistence) so this is effectively a full set,
		// but mergeRuntimeMcpServers is safer than the deprecated replace-all API.
		agentSession.mergeRuntimeMcpServers(rehydrateMcpServers);

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
		await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);

		// --- Inject re-orientation message so the agent checks state and continues.
		const reorientMessage = task.workflowRunId
			? 'You are resuming after a daemon restart. Your previous conversation state has been restored. ' +
				'Please review recent [NODE_*] event messages and continue orchestration in event-driven mode.'
			: 'You are resuming after a daemon restart. Your previous conversation state has been restored. ' +
				'Please check the current task status and continue from where you left off.';
		await this.injectMessageIntoSession(agentSession, reorientMessage);

		// --- Eagerly rehydrate every workflow sub-session for this task.
		//
		// Without this, sub-sessions (coder/reviewer/etc.) that the workflow had
		// already spawned before the daemon restart sit out-of-memory until
		// `injectSubSessionMessage` is invoked. That lazy path is fine for the
		// "Task Agent calls a tool that injects a message" flow, but it has two
		// gaps that bite us in the wild (task #126):
		//
		//   1. UI/RPC paths that resolve a sub-session via
		//      `SessionManager.getSessionAsync` short-circuit on
		//      `AgentSession.restore()` and never reach `rehydrateSubSession` —
		//      the bare restored session has neither `node-agent` nor
		//      `space-agent-tools` attached, so `write_gate` / `read_gate` /
		//      `send_message` calls die silently with "No such tool available".
		//   2. A sub-session sitting idle at a gate has no incoming message to
		//      trigger lazy rehydration, so the in-process MCP servers stay
		//      missing for as long as the workflow waits.
		//
		// Eager rehydration here closes both gaps: every sub-session whose
		// NodeExecution still has an `agentSessionId` (i.e. was spawned before
		// the restart) is restored, registered in the in-memory maps + the
		// SessionManager cache, and re-attached with `node-agent` +
		// `space-agent-tools` BEFORE any UI/RPC consumer can ask for it.
		await this.rehydrateSubSessionsForRun(workflowRun?.id ?? null);

		log.info(
			`TaskAgentManager.rehydrate: rehydrated task agent for task ${taskId} (session ${sessionId})`
		);
	}

	/**
	 * Eagerly rehydrate every workflow sub-session attached to a workflow run,
	 * so the in-process `node-agent` and `space-agent-tools` MCP servers are
	 * re-attached to each sub-session before any external consumer
	 * (UI overlay, peer message, gate write) reaches them.
	 *
	 * Iterates `node_executions` for the run, finds rows that already have an
	 * `agentSessionId` assigned (i.e. a sub-session was spawned before the
	 * daemon restart) AND whose execution status indicates the agent is still
	 * active (`'in_progress'` or `'blocked'`), and calls `rehydrateSubSession`
	 * for each that is not yet in the in-memory `agentSessionIndex`.
	 * `rehydrateSubSession` is idempotent w.r.t. the maps (see its comments) —
	 * calling it for an entry that is somehow already in memory would re-restore
	 * from DB, which is wasteful but not harmful; the explicit
	 * `agentSessionIndex` guard avoids that wasted work.
	 *
	 * Status filter rationale (`NodeExecutionStatus` is
	 * `'pending' | 'in_progress' | 'idle' | 'blocked' | 'cancelled'`):
	 * - `'in_progress'` — agent actively working; must come back.
	 * - `'blocked'` — agent sitting at a gate awaiting input; must come back.
	 *   This is the original Task #126 scenario.
	 * - `'pending'` — declared but never spawned, so `agentSessionId` is null
	 *   and the row is already filtered by the `if (!subSessionId)` guard
	 *   above. Listed here for completeness.
	 * - `'idle'` — the agent finished its turn; `handleSubSessionComplete`
	 *   already auto-transitioned the execution and fired the completion
	 *   callback. Restoring would attach MCP servers, register a new
	 *   completion callback, and restart the streaming query for an agent
	 *   that has no remaining work — pure overhead.
	 * - `'cancelled'` — the execution was explicitly stopped; same reasoning
	 *   as `'idle'`.
	 *
	 * Failures are isolated per sub-session and logged at warn level — one
	 * broken sub-session must not block rehydration of its siblings.
	 *
	 * No-op when `workflowRunId` is null (standalone task with no workflow).
	 */
	private async rehydrateSubSessionsForRun(workflowRunId: string | null): Promise<void> {
		if (!workflowRunId) return;

		const executions = this.config.nodeExecutionRepo.listByWorkflowRun(workflowRunId);
		for (const execution of executions) {
			const subSessionId = execution.agentSessionId;
			if (!subSessionId) continue;

			// Only rehydrate active executions. `idle` / `cancelled` agents have
			// already finished their turn (or been explicitly stopped) and will
			// not receive any new messages — restoring them would attach MCP
			// servers, register a new completion callback, and restart the
			// streaming query for nothing.
			if (execution.status !== 'in_progress' && execution.status !== 'blocked') continue;

			// Skip if already in memory (e.g. lazily rehydrated by an earlier
			// inbound message during this same restart, or never torn down).
			if (this.agentSessionIndex.has(subSessionId)) continue;

			try {
				await this.rehydrateSubSession(subSessionId);
			} catch (err) {
				log.warn(
					`TaskAgentManager.rehydrateSubSessionsForRun: failed to rehydrate sub-session ${subSessionId} ` +
						`(run=${workflowRunId}, exec=${execution.id}, agent=${execution.agentName}): ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
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

		// --- Look up the NodeExecution by agentSessionId, falling back to the
		// execution id embedded in deterministic workflow sub-session ids.
		const execution = this.resolveNodeExecutionForSubSession(subSessionId);
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
			this.config.appMcpServerRepo,
			{ autoReplayPendingMessages: false }
		);
		if (!agentSession) {
			log.warn(
				`TaskAgentManager.rehydrateSubSession: AgentSession.restore() returned null for ${subSessionId} — session not in DB`
			);
			return null;
		}

		// --- Determine workspace path
		const workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;

		// --- Resolve the current workflow-slot prompt before restarting the SDK.
		// AgentSession.restore() intentionally keeps persisted DB config as-is; without
		// re-applying the current workflow/agent prompt here, a node agent that already
		// existed before a daemon restart would resume with stale instructions. This
		// shows up most visibly for Reviewer agents after built-in workflow prompt
		// updates: the spawn path uses the new slot prompt, while the rehydrate path
		// used to keep the old persisted prompt until the session was recreated.
		const currentInit = this.resolveCurrentNodeAgentInitForExecution({
			task: parentTask,
			space,
			workflow,
			workflowRun,
			execution,
			sessionId: subSessionId,
			workspacePath,
		});
		if (currentInit?.systemPrompt) {
			agentSession.setRuntimeSystemPrompt(currentInit.systemPrompt);
		}

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
		// Session-aware resolver — scope='space' / scope='session' overrides apply.
		const registryMcpServers =
			this.config.appMcpManager?.getEnabledMcpConfigsForSession({
				id: subSessionId,
				context: { spaceId },
			}) ?? {};
		const mergedMcpServers: Record<string, McpServerConfig> = {
			...registryMcpServers,
			'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
		};

		// Use merge semantics: the restored session has no in-memory MCP servers
		// (stripped from DB) so this is effectively a full set, but mergeRuntimeMcpServers
		// is safer than the deprecated replace-all setRuntimeMcpServers.
		agentSession.mergeRuntimeMcpServers(mergedMcpServers);

		// Defensive guarantee — see ensureNodeAgentAttached docs.
		await this.ensureNodeAgentAttached(agentSession, {
			taskId,
			subSessionId,
			agentName: execution.agentName,
			spaceId,
			workflowRunId,
			workspacePath,
			workflowNodeId: execution.workflowNodeId,
			phase: 'rehydrate',
		});

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

		// P1-5: Register the self-heal callback on the rehydrated session so that
		// if MCP servers go missing during its lifetime, QueryRunner.start() can recover.
		agentSession.onMissingWorkflowMcpServers = async (cbSessionId: string, missing: string[]) => {
			await this.mcpSelfHeal(cbSessionId, missing);
		};

		// Rehydration must publish the AgentSession in every runtime map before any
		// continuation replay can run. Starting the SDK query is intentionally last:
		// a pending Anthropic tool_result retry may arrive while this method is still
		// restoring MCP/runtime state, and the Codex bridge now waits for the live
		// tool_use correlation map instead of treating that transient window as an
		// unrecoverable orphan.
		const pendingToolContinuations =
			this.config.toolContinuationRepo?.listPendingInboxForSession(subSessionId) ?? [];
		if (pendingToolContinuations.length > 0) {
			log.warn(
				`TaskAgentManager.rehydrateSubSession: session ${subSessionId} has ` +
					`${pendingToolContinuations.length} queued tool_result continuation(s); ` +
					`starting query only after runtime provisioning is complete`
			);
		}

		// --- Restart the streaming query (idempotent if already running)
		await agentSession.startStreamingQuery();
		await this.replayPendingMessagesAfterRuntimeProvisioning(agentSession);

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

		return agentSession;
	}

	private buildSlotOverrides(
		slot: WorkflowNodeAgent,
		context?: {
			node?: { id: string; name: string };
			workflow?: { id: string };
			workflowRun?: { id: string };
		}
	): SlotOverrides {
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
		return {
			model: slot.model,
			customPrompt: slotCustomPrompt,
			disabledSkillIds: slot.disabledSkillIds,
			extraMcpServers: slot.extraMcpServers,
			toolGuards: slot.toolGuards,
			resolutionContext: {
				agentId: slot.agentId,
				agentName: slot.name,
				workflowRunId: context?.workflowRun?.id,
				workflowId: context?.workflow?.id,
				nodeId: context?.node?.id,
				nodeName: context?.node?.name,
			},
		};
	}

	private resolveCurrentNodeAgentInitForExecution(args: {
		task: SpaceTask;
		space: Space;
		workflow: SpaceWorkflow | null;
		workflowRun: SpaceWorkflowRun | null;
		execution: NodeExecution;
		sessionId: string;
		workspacePath: string;
	}): AgentSessionInit | null {
		const { task, space, workflow, workflowRun, execution, sessionId, workspacePath } = args;
		const node = workflow?.nodes.find((candidate) => candidate.id === execution.workflowNodeId);
		if (!node) {
			log.warn(
				`TaskAgentManager.rehydrateSubSession: workflow node ${execution.workflowNodeId} ` +
					`not found for session ${sessionId}; keeping persisted system prompt`
			);
			return null;
		}

		const nodeAgents = resolveNodeAgents(node);
		const slot =
			nodeAgents.length === 1
				? nodeAgents[0]
				: nodeAgents.find((agentSlot) => agentSlot.name === execution.agentName);
		if (!slot?.agentId) {
			log.warn(
				`TaskAgentManager.rehydrateSubSession: no agent slot found for agent ${execution.agentName} ` +
					`in node ${execution.workflowNodeId}; keeping persisted system prompt`
			);
			return null;
		}

		return resolveAgentInit({
			task,
			space,
			agentManager: this.config.spaceAgentManager,
			sessionId,
			workspacePath,
			workflowRun,
			workflow,
			slotOverrides: this.buildSlotOverrides(slot, {
				node,
				workflow: workflow ?? undefined,
				workflowRun: workflowRun ?? undefined,
			}),
			agentId: slot.agentId,
		});
	}

	/**
	 * Resolve the workflow execution that owns a sub-session.
	 *
	 * Normal path: NodeExecution.agentSessionId points at the sub-session.
	 * Recovery path: deterministic workflow sub-session ids include the execution
	 * id (`space:<spaceId>:task:<taskId>:exec:<nodeExecutionId>`). If a daemon
	 * restart or spawn race left `agent_session_id` null, use that embedded id to
	 * repair the row and continue rehydration/self-heal without discarding the
	 * existing session transcript or queued message.
	 */
	private resolveNodeExecutionForSubSession(subSessionId: string): NodeExecution | null {
		const bySessionId = this.config.nodeExecutionRepo.listByAgentSessionId(subSessionId);
		const embeddedExecutionId = this.parseExecutionIdFromSubSessionId(subSessionId);
		const embedded = embeddedExecutionId
			? this.config.nodeExecutionRepo.getById(embeddedExecutionId)
			: null;

		if (embedded && !embedded.agentSessionId) {
			const repaired = this.config.nodeExecutionRepo.updateSessionId(embedded.id, subSessionId);
			if (repaired) {
				log.warn(
					`TaskAgentManager.resolveNodeExecutionForSubSession: repaired missing agent_session_id ` +
						`for execution ${embedded.id} from sub-session id ${subSessionId}`
				);
				return this.pickBestNodeExecution([repaired, ...bySessionId]);
			}
		}

		const candidates =
			embedded?.agentSessionId === subSessionId ? [embedded, ...bySessionId] : bySessionId;
		return this.pickBestNodeExecution(candidates);
	}

	private parseExecutionIdFromSubSessionId(subSessionId: string): string | null {
		const marker = ':exec:';
		const markerIndex = subSessionId.indexOf(marker);
		if (markerIndex === -1) return null;
		const rest = subSessionId.slice(markerIndex + marker.length);
		const executionId = rest.split(':')[0];
		return executionId || null;
	}

	private pickBestNodeExecution(candidates: NodeExecution[]): NodeExecution | null {
		if (candidates.length === 0) return null;
		const statusRank = (execution: NodeExecution): number => {
			switch (execution.status) {
				case 'in_progress':
					return 0;
				case 'blocked':
					return 1;
				case 'pending':
					return 2;
				default:
					return 3;
			}
		};
		return [...candidates].sort((a, b) => {
			const rankDiff = statusRank(a) - statusRank(b);
			if (rankDiff !== 0) return rankDiff;
			const updatedDiff = b.updatedAt - a.updatedAt;
			if (updatedDiff !== 0) return updatedDiff;
			return b.createdAt - a.createdAt;
		})[0]!;
	}

	private async replayPendingMessagesAfterRuntimeProvisioning(
		session: AgentSession
	): Promise<void> {
		const replay = (
			session as AgentSession & {
				replayPendingMessagesForImmediateMode?: () => Promise<void>;
			}
		).replayPendingMessagesForImmediateMode;
		if (typeof replay === 'function') {
			await replay.call(session);
		}
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
	 * Interrupt and clean up a session's in-memory state, **preserving its DB row**
	 * and all persisted artifacts (worktree + SDK `.jsonl` files).
	 *
	 * Task #85: this is the only primitive non-UI code paths may use to stop
	 * a task agent / sub-session. Task completion, cancellation, workflow end,
	 * spawn rollback, daemon shutdown, and Neo recovery all route through here
	 * so that `rehydrate()` (or a subsequent UI visit) can restore the session.
	 * Worktree/DB/jsonl removal happens only via
	 * `SessionManager.archiveSessionResources` or
	 * `SessionManager.deleteSessionResources`.
	 */
	private async stopSessionPreserveDb(sessionId: string, session: AgentSession): Promise<void> {
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
	}

	// Task #85: `stopAndDeleteSession` has been removed. Non-UI code paths must
	// use `stopSessionPreserveDb` (or `SessionManager.interruptInMemorySession`),
	// which preserves the DB row + `sdk_messages` + worktree + SDK `.jsonl`
	// files. Only the `session.archive`/`task.archive` and
	// `session.delete`/`room.delete` RPC handlers may touch those artifacts,
	// via `SessionManager.archiveSessionResources` /
	// `SessionManager.deleteSessionResources`.

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
	 * The MCP servers that every workflow sub-session MUST have attached before its
	 * first turn runs. See `ensureNodeAgentAttached` / `ensureRequiredMcpServersAttached`
	 * for the invariant enforcement logic.
	 *
	 * - `node-agent`: peer communication, artifact writes, and node-safe task
	 *   actions (including create_standalone_task).
	 *   Without this the Coder→Reviewer handoff dies silently with "No such tool
	 *   available" (PR #1535 failure mode).
	 */
	private static readonly REQUIRED_WORKFLOW_SUBSESSION_MCP_SERVERS = ['node-agent'] as const;

	/**
	 * Verify that a workflow node sub-session has its required MCP server
	 * (`node-agent`) attached to its in-memory config, and self-heal by
	 * re-attaching it when missing.
	 *
	 * This is a defensive guard against silent recurrence of the peer-communication
	 * failure mode:
	 *   - PR #1535: Coder sub-session ran without `node-agent`, so
	 *     `mcp__node-agent__send_message` returned "No such tool available" and the
	 *     Coder→Reviewer handoff died silently.
	 *
	 * Called from both spawn and rehydrate paths to guarantee the invariant:
	 *   "every workflow-node sub-session has `node-agent` attached BEFORE first turn".
	 *
	 * If any required server is missing (which should never happen given the merge
	 * logic in createSubSession + rehydrateSubSession), this method:
	 *   1. Logs a loud error tagged with the spawn/rehydrate phase for diagnosis.
	 *   2. Re-builds and re-attaches the missing server (preserving any registry-sourced
	 *      MCP servers that may already be present in the config).
	 *   3. Re-verifies attachment; if any required server is still missing, throws —
	 *      better to fail spawn visibly than to start an unrecoverable session.
	 *
	 * Kept under the name `ensureNodeAgentAttached` for source-compatibility with
	 * existing callers and tests; `ensureRequiredMcpServersAttached` is the
	 * preferred alias for new code.
	 */
	async ensureNodeAgentAttached(
		session: AgentSession,
		ctx: {
			taskId: string;
			subSessionId: string;
			agentName: string;
			spaceId: string;
			workflowRunId: string;
			workspacePath: string;
			workflowNodeId: string;
			phase: 'spawn' | 'rehydrate';
		}
	): Promise<void> {
		// `session.config` may be absent on restored ghost sessions before the first
		// query setup, so read defensively — treat as empty servers map.
		const currentMcpServers =
			(session.session.config?.mcpServers as Record<string, McpServerConfig> | undefined) ?? {};

		const required = TaskAgentManager.REQUIRED_WORKFLOW_SUBSESSION_MCP_SERVERS;
		const missing = required.filter((name) => !currentMcpServers[name]);

		if (missing.length === 0) {
			// Invariant holds — log at debug level for traceability.
			log.debug(
				`TaskAgentManager.ensureNodeAgentAttached: all required MCP servers present on session ${ctx.subSessionId} (phase=${ctx.phase}): [${required.join(', ')}]`
			);
			return;
		}

		log.error(
			`TaskAgentManager.ensureNodeAgentAttached: required MCP servers MISSING on workflow sub-session ${ctx.subSessionId} ` +
				`(task=${ctx.taskId}, agent=${ctx.agentName}, phase=${ctx.phase}). ` +
				`Missing: [${missing.join(', ')}]. ` +
				`Visible servers: [${Object.keys(currentMcpServers).sort().join(', ')}]. ` +
				`Self-healing by re-injecting before first turn — but this indicates a regression in the spawn/rehydrate merge logic.`
		);

		// Re-attach the missing required server while preserving other runtime servers.
		for (const name of missing) {
			if (name === 'node-agent') {
				await this.reinjectNodeAgentMcpServer(session, ctx);
			}
		}

		const verifyMcpServers =
			(session.session.config?.mcpServers as Record<string, McpServerConfig> | undefined) ?? {};
		const stillMissing = required.filter((name) => !verifyMcpServers[name]);
		if (stillMissing.length > 0) {
			throw new Error(
				`TaskAgentManager.ensureNodeAgentAttached: failed to re-attach required MCP servers [${stillMissing.join(', ')}] to session ${ctx.subSessionId} after self-heal attempt`
			);
		}
		log.info(
			`TaskAgentManager.ensureNodeAgentAttached: successfully re-attached MCP servers [${missing.join(', ')}] to session ${ctx.subSessionId} (phase=${ctx.phase})`
		);
	}

	/**
	 * P1-5: Final backstop — self-heals a workflow sub-session's MCP servers on demand.
	 *
	 * Called by the `onMissingWorkflowMcpServers` callback that `QueryRunner.start()`
	 * invokes when it detects a missing `node-agent` at the moment of first-turn
	 * setup. This is the last line of defence for any session that slipped through
	 * the spawn/rehydrate path without the required server attached:
	 *
	 *   - Old sessions that never had the callback registered (before this fix)
	 *   - Sessions created by older daemon versions with incomplete MCP injection
	 *   - Sessions that lost their servers due to a clobbering `setRuntimeMcpServers`
	 *     call from an unknown subsystem
	 *   - Reused sessions where the reuse-path MCP rebuild was also missed
	 *
	 * Recovery steps:
	 *   1. Look up the NodeExecution by agentSessionId (same as rehydrateSubSession).
	 *   2. Build the full context (taskId, spaceId, workflowRunId, workspacePath).
	 *   3. Call `ensureRequiredMcpServersAttached` which re-injects node-agent and
	 *      verifies it.
	 *
	 * @param sessionId   The sub-session ID (matches NodeExecution.agentSessionId).
	 * @param missing     The list of server names that were detected as missing.
	 */
	async mcpSelfHeal(sessionId: string, missing: string[]): Promise<void> {
		log.warn(
			`TaskAgentManager.mcpSelfHeal: triggered for session ${sessionId}, missing [${missing.join(', ')}]`
		);

		// Step 1: Look up the NodeExecution (same resolver as rehydrateSubSession).
		const execution = this.resolveNodeExecutionForSubSession(sessionId);
		if (!execution) {
			log.error(
				`TaskAgentManager.mcpSelfHeal: no NodeExecution found for agentSessionId=${sessionId} — cannot self-heal`
			);
			return;
		}

		// Step 2: Build context.
		const tasks = this.config.taskRepo.listByWorkflowRun(execution.workflowRunId);
		const parentTask = tasks.find((t) => t.taskAgentSessionId != null) ?? tasks[0] ?? null;
		if (!parentTask) {
			log.error(
				`TaskAgentManager.mcpSelfHeal: no parent task found for workflowRunId=${execution.workflowRunId} — cannot self-heal`
			);
			return;
		}
		const space = await this.config.spaceManager.getSpace(parentTask.spaceId);
		if (!space) {
			log.error(
				`TaskAgentManager.mcpSelfHeal: space ${parentTask.spaceId} not found for task ${parentTask.id} — cannot self-heal`
			);
			return;
		}

		// Step 3: Get the live AgentSession from memory.
		const agentSession = this.agentSessionIndex.get(sessionId);
		if (!agentSession) {
			log.error(
				`TaskAgentManager.mcpSelfHeal: AgentSession ${sessionId} not in memory — cannot self-heal`
			);
			return;
		}

		// Step 4: Call ensureRequiredMcpServersAttached which re-injects and verifies.
		// Uses phase='rehydrate' since we're recovering an existing session.
		await this.ensureRequiredMcpServersAttached(agentSession, {
			taskId: parentTask.id,
			subSessionId: sessionId,
			agentName: execution.agentName,
			spaceId: parentTask.spaceId,
			workflowRunId: execution.workflowRunId,
			workspacePath: this.taskWorktreePaths.get(parentTask.id) ?? space.workspacePath,
			workflowNodeId: execution.workflowNodeId,
			phase: 'rehydrate',
		});
	}

	/**
	 * Preferred alias for `ensureNodeAgentAttached`. See that method for behaviour.
	 *
	 * The original name remains for backwards compatibility with existing callers,
	 * but is misleading now that the check covers both `node-agent` and
	 * `space-agent-tools`. New code should prefer this alias.
	 */
	async ensureRequiredMcpServersAttached(
		session: AgentSession,
		ctx: {
			taskId: string;
			subSessionId: string;
			agentName: string;
			spaceId: string;
			workflowRunId: string;
			workspacePath: string;
			workflowNodeId: string;
			phase: 'spawn' | 'rehydrate';
		}
	): Promise<void> {
		return this.ensureNodeAgentAttached(session, ctx);
	}

	/**
	 * Build (or re-build) the per-session node-agent MCP server and merge it into
	 * the session's runtime MCP map, preserving any other MCP servers already present.
	 *
	 * Used by the defensive self-heal path in ensureNodeAgentAttached and as a
	 * restore primitive callable when a sub-session needs node-agent re-attached
	 * (e.g., after a refactor regression or registry collision drops it).
	 *
	 * After merging the new server, if a query is currently running the method calls
	 * `restartQuery()` so the SDK picks up the fresh tool registry. Without the restart
	 * the running turn keeps the old (pre-merge) tool surface and the self-heal has no
	 * visible effect until the next turn boundary.
	 *
	 * `restartQuery()` is safe to call even when no query is running — it is a no-op
	 * in that case — so calling it from `ensureNodeAgentAttached` (before `startStreamingQuery`)
	 * is harmless.
	 */
	async reinjectNodeAgentMcpServer(
		session: AgentSession,
		ctx: {
			taskId: string;
			subSessionId: string;
			agentName: string;
			spaceId: string;
			workflowRunId: string;
			workspacePath: string;
			workflowNodeId: string;
		}
	): Promise<void> {
		const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
			ctx.taskId,
			ctx.subSessionId,
			ctx.agentName,
			ctx.spaceId,
			ctx.workflowRunId,
			ctx.workspacePath,
			ctx.workflowNodeId
		);

		// Use merge semantics so other runtime servers (space-agent-tools, db-query, etc.)
		// are preserved. The deprecated setRuntimeMcpServers would clobber them.
		session.mergeRuntimeMcpServers({
			'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
		});

		// Restart the running query so the SDK mounts the fresh node-agent server.
		// If no query is running this is a no-op (restartQuery returns early when
		// messageQueue.isRunning() is false).
		await session.restartQuery();
	}

	/**
	 * Build (or re-build) the per-session `space-agent-tools` MCP server and merge
	 * it into the session's runtime MCP map, preserving any other MCP servers
	 * already present.
	 *
	 * Symmetric to `reinjectNodeAgentMcpServer`. Used by the defensive self-heal
	 * path in `ensureNodeAgentAttached` / `ensureRequiredMcpServersAttached` when
	 * a workflow sub-session is missing `space-agent-tools` (e.g. because a
	 * `createSubSession` reuse path reused a session whose in-memory MCP map had
	 * been trimmed, or a rehydrate path raced with `attachSpaceToolsToMemberSession`).
	 *
	 * Without `space-agent-tools` a workflow node cannot call `write_gate`,
	 * `read_gate`, `approve_gate`, or `list_tasks`, and the workflow stalls at its
	 * first gate boundary (Task #99 failure mode).
	 *
	 * The re-attached server wires `onRestoreNodeAgent` into a closure that calls
	 * back into this manager's `reinjectNodeAgentMcpServer` — mirroring the
	 * rehydrate-time wiring in `rehydrateSubSession` — so the combined self-heal
	 * remains complete even across subsequent node-agent losses.
	 *
	 * Calls `restartQuery()` after merge so the SDK mounts the fresh tool surface.
	 */
	async reinjectSpaceAgentToolsMcpServer(
		session: AgentSession,
		ctx: {
			taskId: string;
			subSessionId: string;
			agentName: string;
			spaceId: string;
			workflowRunId: string;
			workspacePath: string;
			workflowNodeId: string;
		}
	): Promise<void> {
		const spaceAgentToolsServer = this.buildSpaceAgentToolsMcpServerForSubSession(ctx);

		session.mergeRuntimeMcpServers({
			'space-agent-tools': spaceAgentToolsServer as unknown as McpServerConfig,
		});

		await session.restartQuery();
	}

	/**
	 * Build the `space-agent-tools` MCP server for a specific workflow sub-session.
	 *
	 * Centralises the `createSpaceAgentMcpServer({ … })` construction that was
	 * previously inlined in four spawn/rehydrate paths
	 * (`spawnWorkflowNodeAgentForExecution`, `eagerlySpawnWorkflowNodeAgents`,
	 * `rehydrateSubSession`, and the reuse branch of `createSubSession`). Keeping
	 * the builder in one place means a future change to the server wiring (e.g.
	 * new config field, new callback) is applied uniformly, preventing drift
	 * between spawn and self-heal paths.
	 *
	 * The returned server includes an `onRestoreNodeAgent` callback that
	 * re-injects `node-agent` on the live sub-session, so the Space UI's
	 * "restore node-agent" affordance keeps working even when this server was
	 * attached via the self-heal path.
	 */
	private buildSpaceAgentToolsMcpServerForSubSession(ctx: {
		taskId: string;
		subSessionId: string;
		agentName: string;
		spaceId: string;
		workflowRunId: string;
		workspacePath: string;
		workflowNodeId: string;
	}) {
		const subSessionTaskManager = new SpaceTaskManager(
			this.config.db.getDatabase(),
			ctx.spaceId,
			this.config.reactiveDb
		);
		return createSpaceAgentMcpServer({
			spaceId: ctx.spaceId,
			runtime: this.config.spaceRuntimeService.getSharedRuntime(),
			workflowManager: this.config.spaceWorkflowManager,
			spaceManager: this.config.spaceManager,
			taskRepo: this.config.taskRepo,
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			taskManager: subSessionTaskManager,
			spaceAgentManager: this.config.spaceAgentManager,
			taskAgentManager: this,
			gateDataRepo: this.config.gateDataRepo,
			daemonHub: this.config.daemonHub,
			onGateChanged: (runId, gateId) => {
				void this.config.spaceRuntimeService.notifyGateDataChanged(runId, gateId).catch(() => {});
			},
			pendingMessageQueue: this.config.pendingMessageRepo,
			getSpaceAutonomyLevel: async (sid) => {
				const s = await this.config.spaceManager.getSpace(sid);
				return s?.autonomyLevel ?? 1;
			},
			myAgentName: ctx.agentName,
			// Wire restore_node_agent so it is callable even when node-agent is
			// missing. The closure captures the rebuild-time values of taskId,
			// subSessionId, agentName, etc. which are stable for this session.
			onRestoreNodeAgent: async (_args) => {
				const liveSession = this.getSubSession(ctx.subSessionId);
				if (!liveSession) {
					log.warn(
						`space-agent-tools.restore_node_agent: no live session found for sub-session ${ctx.subSessionId}`
					);
					return;
				}
				await this.reinjectNodeAgentMcpServer(liveSession, {
					taskId: ctx.taskId,
					subSessionId: ctx.subSessionId,
					agentName: ctx.agentName,
					spaceId: ctx.spaceId,
					workflowRunId: ctx.workflowRunId,
					workspacePath: ctx.workspacePath,
					workflowNodeId: ctx.workflowNodeId,
				});
			},
		});
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
	 * save_artifact) that are scoped to its group, channel topology, and node task.
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
			cancelSessionById: (sid) => this.cancelBySessionId(sid),
			// Forward the runtime's current sink so a peer-agent `send_message`
			// that auto-reopens a terminal run still emits `workflow_run_reopened`
			// into the Space Agent session.
			notificationSink: this.config.spaceRuntimeService.getSharedRuntime().getNotificationSink(),
			onGatePendingApproval: (runId, gateId) =>
				this.config.spaceRuntimeService.handleGatePendingApproval(runId, gateId),
		});
		const agentMessageRouter = new AgentMessageRouter({
			nodeExecutionRepo: this.config.nodeExecutionRepo,
			workflowRunId,
			workflowChannels: channels,
			messageInjector: (targetSessionId, message) =>
				this.injectSubSessionMessage(targetSessionId, message, true),
			activateTargetSession: (targetAgentName) =>
				this.activateTargetSessionsForMessage(taskId, workflowRunId, targetAgentName, {
					reopenReason: `node-agent send_message to activate "${targetAgentName}"`,
					reopenBy: `agent:${agentName}`,
				}),
			channelRouter: nodeAgentChannelRouter,
			nodeGroups,
			taskAgentRouter: async (message) => {
				const ensuredTask = await this.ensureTaskAgentSession(taskId);
				await this.injectTaskAgentMessage(taskId, message);
				return { sessionId: ensuredTask.taskAgentSessionId ?? '' };
			},
			// Wire up the pending-message queue so node agents can queue messages for
			// peers that haven't spawned yet (declared but inactive). The queue is
			// drained by flushPendingMessagesForTarget() when the target session activates.
			pendingMessageRepo: this.config.pendingMessageRepo,
			spaceId,
			taskId,
			// Auto-resume + lazy-activation callback fired when a message is queued
			// for an inactive peer:
			//
			//   1. `tryResumeNodeAgentSession` — fast path that rehydrates a known
			//      idle/completed session so the queue is drained immediately.
			//   2. `ensureWorkflowNodeActivationForAgent` — explicit activation kick
			//      for workflow-declared peers that have no live session. Mirrors the
			//      Task Agent send-path fix in #139: relying on `channelRouter`'s
			//      activation-on-deliverMessage step is not enough because that step
			//      only fires when the target node has zero active executions; a
			//      workflow node stranded in `pending` state would otherwise queue
			//      forever. `activateNode` is idempotent so this is safe regardless
			//      of the existing row's status.
			onMessageQueued: (targetAgentName) => {
				void this.tryResumeNodeAgentSession(workflowRunId, targetAgentName).catch((err) => {
					log.warn(
						`AgentMessageRouter.onMessageQueued: tryResumeNodeAgentSession failed for "${targetAgentName}": ${err instanceof Error ? err.message : String(err)}`
					);
				});
				const declaredAgentNames = this.getWorkflowDeclaredAgentNamesForTask(taskId);
				if (declaredAgentNames.includes(targetAgentName)) {
					log.info(
						`agent-message-router.onMessageQueued: lazy-activated peer ${targetAgentName} for task ${taskId}`
					);
					void this.ensureWorkflowNodeActivationForAgent(taskId, targetAgentName, {
						reopenReason: `node-agent send_message to lazily activate "${targetAgentName}"`,
						reopenBy: `agent:${agentName}`,
					}).catch((err) => {
						log.warn(
							`AgentMessageRouter.onMessageQueued: ensureWorkflowNodeActivationForAgent failed for "${targetAgentName}": ${err instanceof Error ? err.message : String(err)}`
						);
					});
				}
			},
		});

		const agentNameAliases = execution
			? this.buildAgentNameAliasesForExecution(workflow, execution)
			: this.agentNameVariants(agentName);

		// End-node tool contract:
		//   `save_artifact`      — persist typed data to artifact store (available to all node agents).
		//   `approve_task`       — closes the task as done (self-approval). Gated
		//                          by `space.autonomyLevel >= workflow.completionAutonomyLevel`.
		//                          Only available to end-node agents.
		//   `submit_for_approval` — request human review of completion.
		//                           Only available to end-node agents.
		const isEndNode = !!workflow?.endNodeId && workflowNodeId === workflow.endNodeId;
		// Bound SpaceTaskManager shared by the `submit_for_approval` and
		// `mark_complete` tool handlers — both rely on the centralised transition
		// validator so any illegal source status fails before fields get written.
		const boundTaskManager = new SpaceTaskManager(
			this.config.db.getDatabase(),
			spaceId,
			this.config.reactiveDb
		);
		const endNodeHandlers = isEndNode
			? createEndNodeHandlers({
					taskId,
					spaceId,
					workflow,
					workflowNodeId,
					agentName,
					taskRepo: this.config.taskRepo,
					taskManager: boundTaskManager,
					spaceManager: this.config.spaceManager,
					daemonHub: this.config.daemonHub,
				})
			: undefined;
		const onApproveTask = endNodeHandlers?.onApproveTask;
		const onSubmitForApproval = endNodeHandlers?.onSubmitForApproval;

		// `mark_complete` (PR 2/5) is mirrored onto every spawned node-agent so
		// post-approval sub-sessions can close the task via `approved → done`.
		// The handler self-validates status (rejects non-approved) — a spawned
		// agent that happens not to be running a post-approval step simply sees
		// the tool reject with a clear error.
		const onMarkComplete = createMarkCompleteHandler({
			taskId,
			spaceId,
			taskRepo: this.config.taskRepo,
			taskManager: boundTaskManager,
			daemonHub: this.config.daemonHub,
		});

		// Self-heal callback for the agent-callable `restore_node_agent` tool.
		// Looks up the live AgentSession by the enclosing-scope subSessionId, then
		// calls reinjectNodeAgentMcpServer to (re)attach node-agent and restart the query
		// so the SDK mounts the fresh tool registry for the next turn. Belt-and-braces:
		// the tool call itself is proof the server is already attached, but re-injecting
		// protects against partial/torn registry state and emits a structured log entry
		// for diagnosis. All identity vars (taskId, subSessionId, etc.) are `const` in
		// the enclosing scope, so the closure captures them safely without aliasing.
		const onRestoreNodeAgent = async (args: { reason?: string }): Promise<void> => {
			const liveSession = this.getSubSession(subSessionId);
			if (!liveSession) {
				log.warn(
					`TaskAgentManager.onRestoreNodeAgent: no live AgentSession found for sub-session ${subSessionId} ` +
						`(task=${taskId}, agent=${agentName}). Reason: ${args.reason ?? '<unspecified>'}`
				);
				return;
			}
			try {
				await this.reinjectNodeAgentMcpServer(liveSession, {
					taskId,
					subSessionId,
					agentName,
					spaceId,
					workflowRunId,
					workspacePath,
					workflowNodeId,
				});
				log.info(
					`TaskAgentManager.onRestoreNodeAgent: re-attached node-agent for sub-session ${subSessionId} ` +
						`(task=${taskId}, agent=${agentName}, reason=${args.reason ?? '<unspecified>'})`
				);
			} catch (err) {
				log.error(
					`TaskAgentManager.onRestoreNodeAgent: failed to re-attach node-agent for sub-session ${subSessionId}: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		};

		const onCreateStandaloneTask = async (args: {
			title: string;
			description: string;
			priority?: 'low' | 'normal' | 'high' | 'urgent';
			custom_agent_id?: string;
			workflow_id?: string;
			depends_on?: string[];
			draft?: boolean;
		}) => {
			try {
				const task = await boundTaskManager.createTask({
					title: args.title,
					description: args.description,
					priority: args.priority,
					preferredWorkflowId: args.workflow_id ?? null,
					dependsOn: args.depends_on,
					status: args.draft ? 'draft' : undefined,
				});
				return jsonResult({ success: true, task });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		};

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
			// gateId is overridden per-gate by the handler ({ ...scriptContext, gateId }).
			// workflowStartIso is sourced from the run's createdAt so gate scripts can
			// filter activity by "since workflow start" (e.g. review-posted-gate).
			scriptContext: {
				workspacePath,
				runId: workflowRunId,
				gateId: '',
				workflowStartIso: run ? new Date(run.createdAt).toISOString() : undefined,
			},
			onApproveTask,
			onSubmitForApproval,
			onMarkComplete,
			onCreateStandaloneTask,
			artifactRepo: this.config.artifactRepo,
			getSpaceAutonomyLevel: async (sid) => {
				const s = await spaceManager.getSpace(sid);
				return s?.autonomyLevel ?? 1;
			},
			onRestoreNodeAgent,
		});
	}

	// -------------------------------------------------------------------------
	// Public — post-approval routing delegates (PR 2/5)
	// -------------------------------------------------------------------------

	/**
	 * Inject a user-turn message into the Task Agent session for a task.
	 *
	 * Thin wrapper around `injectTaskAgentMessage` that matches the
	 * `TaskAgentInjector` shape consumed by `PostApprovalRouter`: returns
	 * `{ injected, sessionId }` instead of throwing when no Task Agent session
	 * exists for the task. Callers treat `injected: false` as a best-effort miss
	 * (log + continue) rather than a hard error.
	 */
	async injectIntoTaskAgent(
		taskId: string,
		message: string
	): Promise<{ injected: boolean; sessionId?: string }> {
		const existing = this.taskAgentSessions.get(taskId);
		const persisted = existing ? null : this.config.taskRepo.getTask(taskId);
		if (!existing && !persisted?.taskAgentSessionId) {
			return { injected: false };
		}
		try {
			await this.injectTaskAgentMessage(taskId, message);
		} catch (err) {
			log.warn(
				`TaskAgentManager.injectIntoTaskAgent: failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
			);
			return { injected: false };
		}
		const session = this.taskAgentSessions.get(taskId);
		return { injected: true, sessionId: session?.session.id };
	}

	/**
	 * Spawn a fresh sub-session for a post-approval node-agent handoff (PR 2/5).
	 *
	 * Called by `PostApprovalRouter` when the workflow declares a
	 * `postApproval.targetAgent` that is NOT `'task-agent'`. The flow:
	 *
	 *   1. Look up the agent slot in the workflow by name (matches against both
	 *      slot.name and agent display name).
	 *   2. Build an `AgentSessionInit` using the same resolver the regular node
	 *      activation path uses (so tool registry + system prompt line up).
	 *   3. Attach the same MCP server surface as a normal node-agent spawn —
	 *      `node-agent` (with `mark_complete` mirrored).
	 *   4. Kick off the session with the interpolated post-approval instructions
	 *      as the first user turn.
	 *
	 * Returns `{ sessionId }`. The caller (router) stamps this onto
	 * `space_tasks.post_approval_session_id` so the UI banner can render a
	 * link + human operators have a jump-off point for manual abort.
	 *
	 * Failures throw; the router logs and surfaces `mode: 'skipped'` upstream.
	 */
	async spawnPostApprovalSubSession(args: {
		task: SpaceTask;
		workflow: SpaceWorkflow;
		targetAgent: string;
		kickoffMessage: string;
	}): Promise<{ sessionId: string }> {
		const { task, workflow, targetAgent, kickoffMessage } = args;
		const taskId = task.id;
		const spaceId = task.spaceId;

		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space) {
			throw new Error(`spawnPostApprovalSubSession: space ${spaceId} not found for task ${taskId}`);
		}

		// Locate the declared agent slot across all nodes. `targetAgent` is validated
		// at workflow-save time to match a WorkflowNodeAgent.name; we also accept the
		// underlying agent's display name / id as a fallback for extra robustness.
		let matchedSlot: ReturnType<typeof resolveNodeAgents>[number] | null = null;
		let matchedNodeId: string | null = null;
		for (const node of workflow.nodes) {
			for (const slot of resolveNodeAgents(node)) {
				if (slot.name === targetAgent || slot.agentId === targetAgent) {
					matchedSlot = slot;
					matchedNodeId = node.id;
					break;
				}
			}
			if (matchedSlot) break;
		}
		if (!matchedSlot?.agentId || !matchedNodeId) {
			throw new Error(
				`spawnPostApprovalSubSession: no agent slot "${targetAgent}" declared in workflow ${workflow.id}`
			);
		}

		const workflowRunId = task.workflowRunId;
		const workflowRun = workflowRunId ? this.config.workflowRunRepo.getRun(workflowRunId) : null;

		const workspacePath = this.taskWorktreePaths.get(taskId) ?? space.workspacePath;

		const matchedNode = workflow.nodes.find((node) => node.id === matchedNodeId);
		const slotOverrides = this.buildSlotOverrides(matchedSlot, {
			node: matchedNode,
			workflow,
			workflowRun: workflowRun ?? undefined,
		});

		const baseSessionId = `space:${spaceId}:task:${taskId}:post-approval:${this.sanitizeAgentNameForId(matchedSlot.name)}`;
		const sessionId = this.resolveSessionId(baseSessionId);

		let init = resolveAgentInit({
			task,
			space,
			agentManager: this.config.spaceAgentManager,
			sessionId,
			workspacePath,
			workflowRun: workflowRun ?? undefined,
			workflow,
			slotOverrides,
			agentId: matchedSlot.agentId,
		});

		const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
			taskId,
			sessionId,
			matchedSlot.name,
			spaceId,
			workflowRunId ?? '',
			workspacePath,
			matchedNodeId
		);
		init = {
			...init,
			mcpServers: {
				...init.mcpServers,
				'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
			},
		};

		const actualSessionId = await this.createSubSession(taskId, sessionId, init, {
			agentId: matchedSlot.agentId,
			agentName: matchedSlot.name,
			nodeId: matchedNodeId,
		});

		const spawned = this.getSubSession(actualSessionId);
		if (!spawned) {
			throw new Error(
				`spawnPostApprovalSubSession: spawned session ${actualSessionId} not registered in memory`
			);
		}

		await this.ensureNodeAgentAttached(spawned, {
			taskId,
			subSessionId: actualSessionId,
			agentName: matchedSlot.name,
			spaceId,
			workflowRunId: workflowRunId ?? '',
			workspacePath,
			workflowNodeId: matchedNodeId,
			phase: 'spawn',
		});

		await this.injectMessageIntoSession(spawned, kickoffMessage);

		log.info(
			`TaskAgentManager.spawnPostApprovalSubSession: spawned session ${actualSessionId} for agent "${matchedSlot.name}" (task ${taskId}, node ${matchedNodeId})`
		);
		return { sessionId: actualSessionId };
	}
}
