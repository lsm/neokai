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
import { generateUUID } from '@neokai/shared';
import type {
	Space,
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	MessageHub,
	McpServerConfig,
} from '@neokai/shared';
import type { AppMcpLifecycleManager } from '../../mcp/app-mcp-lifecycle-manager';
import type { UUID } from 'crypto';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import type { AgentSessionInit } from '../../../lib/agent/agent-session';
import { AgentSession } from '../../../lib/agent/agent-session';
import type { Database } from '../../../storage/database';
import type { DaemonHub } from '../../daemon-hub';
import type { SessionManager } from '../../session-manager';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceRuntimeService } from './space-runtime-service';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceWorktreeManager } from '../managers/space-worktree-manager';
import type {
	SubSessionFactory,
	SubSessionMemberInfo,
	SubSessionState,
} from '../tools/task-agent-tools';
import { createTaskAgentMcpServer } from '../tools/task-agent-tools';
import { createNodeAgentMcpServer } from '../tools/node-agent-tools';
import { ChannelResolver } from './channel-resolver';
import { ChannelRouter } from './channel-router';
import { CompletionDetector } from './completion-detector';
import { createTaskAgentInit, buildTaskAgentInitialMessage } from '../agents/task-agent';
import { Logger } from '../../logger';
import { SpaceTaskManager } from '../managers/space-task-manager';

const log = new Logger('task-agent-manager');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TaskAgentManagerConfig {
	/** Custom Database wrapper — used to persist sessions */
	db: Database;
	/** SessionManager — used to delete sessions during cleanup */
	sessionManager: SessionManager;
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
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Map of stepId → all registered completion callbacks for that session */
type CompletionCallbackMap = Map<string, Array<() => Promise<void>>>;

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
	 * Tracks taskIds currently being spawned — prevents concurrent
	 * spawnTaskAgent() calls from creating duplicate Task Agent sessions.
	 */
	private spawningTasks = new Set<string>();

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

	constructor(private readonly config: TaskAgentManagerConfig) {}

	// -------------------------------------------------------------------------
	// Public — Task Agent lifecycle
	// -------------------------------------------------------------------------

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
		workflowRun: SpaceWorkflowRun | null
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

					// Persist worktree path in workflow run config for M6 artifacts RPC.
					if (workflowRun) {
						const updatedConfig = {
							...workflowRun.config,
							worktreePath: result.path,
						};
						this.config.workflowRunRepo.updateRun(workflowRun.id, { config: updatedConfig });
					}
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
				this.config.defaultModel
			);

			// --- Build the SpaceTaskManager for this space (needed by tool handlers)
			const taskManager = new SpaceTaskManager(this.config.db.getDatabase(), spaceId);

			// --- Build and attach MCP server with live runtime dependencies
			const subSessionFactory = this.createSubSessionFactory(taskId);

			const workflowRunId = workflowRun?.id ?? '';

			// Build shared channel routing and completion detection instances.
			// Both use the same underlying repositories as the task agent tools.
			const channelRouter = new ChannelRouter({
				taskRepo: this.config.taskRepo,
				workflowRunRepo: this.config.workflowRunRepo,
				workflowManager: this.config.spaceWorkflowManager,
				agentManager: this.config.spaceAgentManager,
			});
			const completionDetector = new CompletionDetector(this.config.taskRepo);

			const mcpServer = createTaskAgentMcpServer({
				taskId,
				space,
				workflowRunId,
				workspacePath,
				workflowManager: this.config.spaceWorkflowManager,
				taskRepo: this.config.taskRepo,
				workflowRunRepo: this.config.workflowRunRepo,
				agentManager: this.config.spaceAgentManager,
				taskManager,
				sessionFactory: subSessionFactory,
				messageInjector: (subSessionId, message) =>
					this.injectSubSessionMessage(subSessionId, message),
				onSubSessionComplete: (stepId, subSessionId) =>
					this.handleSubSessionComplete(taskId, stepId, subSessionId),
				daemonHub: this.config.daemonHub,
				channelRouter,
				completionDetector,
				buildNodeAgentMcpServer: (subSessionId, role, stepTaskId) =>
					this.buildNodeAgentMcpServerForSession(
						taskId,
						subSessionId,
						role,
						spaceId,
						workflowRunId,
						stepTaskId,
						taskManager
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
			agentSession.setRuntimeMcpServers({
				...registryMcpServers,
				'task-agent': mcpServer as unknown as McpServerConfig,
			});

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

			// --- Inject initial task context message
			const availableAgents = this.config.spaceAgentManager.listBySpaceId(spaceId);
			const initialMessage = buildTaskAgentInitialMessage({
				task,
				space,
				workflow: workflow ?? undefined,
				workflowRun: workflowRun ?? undefined,
				availableAgents,
			});
			await this.injectMessageIntoSession(agentSession, initialMessage);

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
		init: AgentSessionInit
	): Promise<string> {
		const subSession = AgentSession.fromInit(
			init,
			this.config.db,
			this.config.messageHub,
			this.config.daemonHub,
			this.config.getApiKey,
			this.config.defaultModel
		);

		// Determine step ID from session convention or task context.
		// The subSessions map uses the actual session ID as both the map key and session ID.
		// We store by session ID directly (not step ID) in the flat map for getProcessingState.
		if (!this.subSessions.has(taskId)) {
			this.subSessions.set(taskId, new Map());
		}
		this.subSessions.get(taskId)!.set(sessionId, subSession);

		// Register in SessionManager cache to prevent duplicate AgentSession creation.
		this.config.sessionManager.registerSession(subSession);

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
		const session = this.taskAgentSessions.get(taskId);
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

	/** Returns true if the Task Agent session for the given task is in a live state. */
	isTaskAgentAlive(taskId: string): boolean {
		const session = this.taskAgentSessions.get(taskId);
		if (!session) return false;
		const state = session.getProcessingState();
		// 'idle' means alive but not currently processing (will process next message)
		// 'queued', 'processing' mean actively running
		// 'waiting_for_input' means alive, waiting for human
		// 'interrupted' means alive but interrupted — still recoverable
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

	// -------------------------------------------------------------------------
	// Public — rehydration
	// -------------------------------------------------------------------------

	/**
	 * Rehydrate Task Agent sessions after a daemon restart.
	 *
	 * Queries `space_tasks` for tasks with status `in_progress` or `needs_attention`
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

			// Only rehydrate tasks whose session is a space_task_agent session.
			// Step sub-sessions (UUID) are stored on step tasks — skip those.
			const dbSession = this.config.db.getSession(sessionId);
			if (!dbSession || dbSession.type !== 'space_task_agent') continue;

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
	async cleanup(taskId: string, reason: 'completed' | 'cancelled' = 'completed'): Promise<void> {
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
					effectiveInit
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
			(_event) => {
				if (fired) return; // Already handled by completion path
				fired = true;
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
	 * Updates the step task status to 'completed' and notifies the Task Agent.
	 */
	private async handleSubSessionComplete(
		taskId: string,
		stepId: string,
		subSessionId: string
	): Promise<void> {
		log.info(
			`TaskAgentManager: sub-session complete — task ${taskId}, step ${stepId}, session ${subSessionId}`
		);

		// Find the step task in the DB and mark it completed.
		// Short-circuit when there is no workflow run to avoid a spurious
		// listByWorkflowRun('') that would match tasks with a null run ID.
		const workflowRunId = this.getWorkflowRunId(taskId);
		const stepTasks = workflowRunId
			? this.config.taskRepo
					.listByWorkflowRun(workflowRunId)
					.filter((t) => t.workflowNodeId === stepId && t.taskAgentSessionId === subSessionId)
			: [];

		if (stepTasks.length > 0) {
			const stepTask = stepTasks[stepTasks.length - 1];
			try {
				const spaceId = this.getSpaceIdForTask(taskId);
				if (spaceId) {
					const taskManager = new SpaceTaskManager(this.config.db.getDatabase(), spaceId);
					await taskManager.setTaskStatus(stepTask.id, 'completed');
				}
			} catch (err) {
				log.warn(`TaskAgentManager: failed to mark step task ${stepTask.id} as completed:`, err);
			}
		}

		// Notify the Task Agent that a sub-session has completed.
		// Include the agent's result summary so the Task Agent has immediate context.
		// This sends a defer message so the Task Agent can act on the completed step.
		const taskAgentSession = this.taskAgentSessions.get(taskId);
		if (taskAgentSession) {
			try {
				// Fetch the completed step task's result summary from the DB for context.
				const completedStepTask = stepTasks.length > 0 ? stepTasks[stepTasks.length - 1] : null;
				const resultSummary = completedStepTask?.result
					? `\nAgent result summary: ${completedStepTask.result}`
					: '';
				await this.injectMessageIntoSession(
					taskAgentSession,
					`[STEP_COMPLETE] Step "${stepId}" sub-session (${subSessionId}) has completed.${resultSummary}\nCall check_node_status to verify completion status.`,
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

	// -------------------------------------------------------------------------
	// Private — rehydration helpers
	// -------------------------------------------------------------------------

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
			this.config.getApiKey
		);
		if (!agentSession) {
			log.warn(
				`TaskAgentManager.rehydrate: session ${sessionId} not found in DB for task ${taskId}, skipping`
			);
			return;
		}

		// --- Restore worktree path from workflow run config (persisted at spawn time).
		// Only restores the path when the worktree directory still exists on disk —
		// if the directory was deleted between restarts (manual cleanup, disk failure),
		// fall back to space.workspacePath to avoid directing sub-sessions at a
		// non-existent location.
		const rehydrateWorkspacePath = (() => {
			const storedPath =
				workflowRun?.config && typeof workflowRun.config.worktreePath === 'string'
					? workflowRun.config.worktreePath
					: null;
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
		const taskManager = new SpaceTaskManager(this.config.db.getDatabase(), spaceId);

		// --- Build and attach MCP server (runtime-only, not persisted)
		const subSessionFactory = this.createSubSessionFactory(taskId);

		const rehydrateWorkflowRunId = workflowRun?.id ?? '';

		// Build shared channel routing and completion detection instances for rehydration.
		const rehydrateChannelRouter = new ChannelRouter({
			taskRepo: this.config.taskRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			workflowManager: this.config.spaceWorkflowManager,
			agentManager: this.config.spaceAgentManager,
		});
		const rehydrateCompletionDetector = new CompletionDetector(this.config.taskRepo);

		const mcpServer = createTaskAgentMcpServer({
			taskId,
			space,
			workflowRunId: rehydrateWorkflowRunId,
			workspacePath: rehydrateWorkspacePath,
			workflowManager: this.config.spaceWorkflowManager,
			taskRepo: this.config.taskRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			agentManager: this.config.spaceAgentManager,
			taskManager,
			sessionFactory: subSessionFactory,
			messageInjector: (subSessionId, message) =>
				this.injectSubSessionMessage(subSessionId, message),
			onSubSessionComplete: (stepId, subSessionId) =>
				this.handleSubSessionComplete(taskId, stepId, subSessionId),
			daemonHub: this.config.daemonHub,
			channelRouter: rehydrateChannelRouter,
			completionDetector: rehydrateCompletionDetector,
			buildNodeAgentMcpServer: (subSessionId, role, stepTaskId) =>
				this.buildNodeAgentMcpServerForSession(
					taskId,
					subSessionId,
					role,
					spaceId,
					rehydrateWorkflowRunId,
					stepTaskId,
					taskManager
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
		agentSession.setRuntimeMcpServers({
			...rehydrateRegistryMcpServers,
			'task-agent': mcpServer as unknown as McpServerConfig,
		});

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
				'Please use `check_node_status` to determine the current state of your workflow and continue from where you left off.'
			: 'You are resuming after a daemon restart. Your previous conversation state has been restored. ' +
				'Please check the current task status and continue from where you left off.';
		await this.injectMessageIntoSession(agentSession, reorientMessage);

		// --- Rebuild subSessions map from step tasks in the same workflow run
		// Sub-sessions are not fully rehydrated (no streaming restart) — the Task Agent
		// will re-spawn them as needed after receiving the re-orientation message.
		// Step-agent MCP tools are runtime-only (not persisted), so we must re-attach
		// them here the same way createSubSessionFactory.create() does it.
		if (task.workflowRunId) {
			const workflowRunId = task.workflowRunId;

			const stepTasks = this.config.taskRepo.listByWorkflowRun(workflowRunId);
			for (const stepTask of stepTasks) {
				const subSessionId = stepTask.taskAgentSessionId;
				if (!subSessionId || stepTask.id === taskId) continue;

				// Only restore sessions with UUID-style IDs (sub-sessions, not Task Agent sessions)
				const subDbSession = this.config.db.getSession(subSessionId);
				if (!subDbSession || subDbSession.type === 'space_task_agent') continue;

				const subSession = AgentSession.restore(
					subSessionId,
					this.config.db,
					this.config.messageHub,
					this.config.daemonHub,
					this.config.getApiKey
				);
				if (!subSession) continue;

				// Re-attach node-agent MCP tools (runtime-only, not persisted to DB).
				// Use agentName from the step task as the member role; fall back to 'agent'.
				const memberRole = stepTask.agentName ?? 'agent';

				const nodeAgentMcpServer = this.buildNodeAgentMcpServerForSession(
					taskId,
					subSessionId,
					memberRole,
					spaceId,
					workflowRunId,
					stepTask.id,
					taskManager
				);
				subSession.setRuntimeMcpServers({
					'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
				});

				if (!this.subSessions.has(taskId)) {
					this.subSessions.set(taskId, new Map());
				}
				this.subSessions.get(taskId)!.set(subSessionId, subSession);
			}
		}

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
		deliveryMode: 'immediate' | 'defer' = 'immediate'
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
			this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'deferred');
			return;
		}

		await session.ensureQueryStarted();
		this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued');
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

	/** Returns the space ID for a task by reading it from the task repository. */
	private getSpaceIdForTask(taskId: string): string | null {
		return this.config.taskRepo.getTask(taskId)?.spaceId ?? null;
	}

	/**
	 * Look up the spaceId for a sub-session by searching for the parent taskId.
	 * Used when emitting events from the error handler where only subSessionId is available.
	 */
	private getSpaceIdForSubSession(subSessionId: string): string | null {
		for (const [taskId, stepMap] of this.subSessions) {
			if (stepMap.has(subSessionId)) {
				return this.getSpaceIdForTask(taskId);
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
		stepTaskId: string,
		taskManager: SpaceTaskManager
	) {
		const workflowNodeId = this.config.taskRepo.getTask(taskId)?.workflowNodeId ?? '';
		// Build the ChannelResolver from the workflow run's stored config at spawn time.
		// Channels are written once at step-start by SpaceRuntime.storeResolvedChannels(),
		// so reading them here gives the correct topology for this sub-session's lifetime.
		const run = this.config.workflowRunRepo.getRun(workflowRunId);
		const channelResolver = ChannelResolver.fromRunConfig(
			run?.config as Record<string, unknown> | undefined
		);

		return createNodeAgentMcpServer({
			mySessionId: subSessionId,
			myRole: role,
			taskId,
			stepTaskId,
			spaceId,
			channelResolver,
			workflowRunId,
			spaceTaskRepo: this.config.taskRepo,
			workflowNodeId,
			messageInjector: (targetSessionId, message) =>
				this.injectSubSessionMessage(targetSessionId, message),
			taskManager,
			daemonHub: this.config.daemonHub,
		});
	}
}
