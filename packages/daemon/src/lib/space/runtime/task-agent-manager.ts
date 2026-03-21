/**
 * TaskAgentManager
 *
 * Central integration point that manages the lifecycle of Task Agent sessions
 * and their sub-sessions (step agents). Each SpaceTask gets exactly one Task
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

import { generateUUID } from '@neokai/shared';
import type {
	Space,
	SpaceTask,
	SpaceWorkflow,
	SpaceWorkflowRun,
	MessageHub,
	McpServerConfig,
} from '@neokai/shared';
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
import type { SubSessionFactory, SubSessionState } from '../tools/task-agent-tools';
import { createTaskAgentMcpServer } from '../tools/task-agent-tools';
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

			// --- Create AgentSessionInit
			const init = createTaskAgentInit({
				task,
				space,
				workflow,
				workflowRun,
				sessionId,
				workspacePath: space.workspacePath,
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
			const runtime = await this.config.spaceRuntimeService.createOrGetRuntime(spaceId);
			const subSessionFactory = this.createSubSessionFactory(taskId);

			const mcpServer = createTaskAgentMcpServer({
				taskId,
				space,
				workflowRunId: workflowRun?.id ?? '',
				workspacePath: space.workspacePath,
				runtime,
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
			});

			// setRuntimeMcpServers expects McpServerConfig but the MCP SDK's `Server`
			// object is structurally compatible at runtime — the AgentSession only reads
			// the `server` property for the live Server instance. The cast is safe because
			// createTaskAgentMcpServer returns { server, cleanup } which satisfies the
			// runtime shape used inside AgentSession.setRuntimeMcpServers().
			agentSession.setRuntimeMcpServers({
				'task-agent': mcpServer as unknown as McpServerConfig,
			});

			// --- Persist taskAgentSessionId on the SpaceTask
			this.config.taskRepo.updateTask(taskId, { taskAgentSessionId: sessionId });

			// --- Store in map before streaming start to allow getTaskAgent() calls
			this.taskAgentSessions.set(taskId, agentSession);

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
	 * Stop and clean up all sessions for a task.
	 *
	 * Stops the Task Agent session and all sub-sessions, removes DB records
	 * via SessionManager.deleteSession(), and clears in-memory maps.
	 */
	async cleanup(taskId: string): Promise<void> {
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

		log.info(`TaskAgentManager: cleaned up all sessions for task ${taskId}`);
	}

	// -------------------------------------------------------------------------
	// Private — SubSessionFactory
	// -------------------------------------------------------------------------

	/**
	 * Create a `SubSessionFactory` implementation bound to a specific taskId.
	 * Passed to `createTaskAgentMcpServer()` for the given Task Agent session.
	 */
	private createSubSessionFactory(taskId: string): SubSessionFactory {
		return {
			create: async (init: AgentSessionInit): Promise<string> => {
				return this.createSubSession(taskId, init.sessionId, init);
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

		const unsubscribe = this.config.daemonHub.on(
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

		this.sessionListeners.set(subSessionId, unsubscribe);
	}

	/**
	 * Called by the MCP onSubSessionComplete callback (registered in spawn_step_agent).
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
					.filter((t) => t.workflowStepId === stepId && t.taskAgentSessionId === subSessionId)
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
		// This sends a next_turn message so the Task Agent can call advance_workflow.
		const taskAgentSession = this.taskAgentSessions.get(taskId);
		if (taskAgentSession) {
			try {
				await this.injectMessageIntoSession(
					taskAgentSession,
					`[STEP_COMPLETE] Step "${stepId}" has completed. Call check_step_status to verify, then call advance_workflow to proceed.`,
					'next_turn'
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
	// Private — message injection
	// -------------------------------------------------------------------------

	/**
	 * Inject a plain-text message into an AgentSession.
	 * Uses the same pattern as RoomRuntimeService.injectMessage().
	 */
	private async injectMessageIntoSession(
		session: AgentSession,
		message: string,
		deliveryMode: 'current_turn' | 'next_turn' = 'current_turn'
	): Promise<void> {
		const sessionId = session.session.id;
		const state = session.getProcessingState();
		// 'processing'/'queued' = actively running; 'waiting_for_input' = human gate open.
		// All three states mean the session cannot safely receive a next_turn message
		// right now — defer it for replay after the current interaction completes.
		const isBusy =
			state.status === 'processing' ||
			state.status === 'queued' ||
			state.status === 'waiting_for_input';

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

		// next_turn + busy → save for replay after current turn completes
		if (deliveryMode === 'next_turn' && isBusy) {
			this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'saved');
			return;
		}

		await session.ensureQueryStarted();
		this.config.db.saveUserMessage(sessionId, sdkUserMessage, 'queued');
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
}
