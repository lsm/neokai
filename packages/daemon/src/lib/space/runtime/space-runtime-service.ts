/**
 * SpaceRuntimeService
 *
 * Manages SpaceRuntime lifecycle and provides per-space access to the
 * underlying workflow execution engine.
 *
 * Design: One shared SpaceRuntime handles all spaces in a single tick loop.
 * SpaceRuntimeService provides lifecycle management (start/stop) and a
 * per-space API surface for RPC handlers and DaemonAppContext.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { McpServerConfig, Session, Space, SpaceTask } from '@neokai/shared';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { NotificationSink } from './notification-sink';
import type { TaskAgentManager } from './task-agent-manager';
import type { SessionManager } from '../../session-manager';
import type { DaemonHub } from '../../daemon-hub';
import { SpaceRuntime } from './space-runtime';
import type { SelectWorkflowWithLlm } from './llm-workflow-selector';
import { selectWorkflowWithLlmDefault } from './llm-workflow-selector';
import { ChannelRouter } from './channel-router';
import { SpaceTaskManager } from '../managers/space-task-manager';
import { createSpaceAgentMcpServer } from '../tools/space-agent-tools';
import { buildSpaceChatSystemPrompt } from '../agents/space-chat-agent';
import { Logger } from '../../logger';
import { createDbQueryMcpServer, type DbQueryMcpServer } from '../../db-query/tools';

const log = new Logger('space-runtime-service');

export interface SpaceRuntimeServiceConfig {
	db: BunDatabase;
	/** Absolute path to the SQLite database file. When provided, a db-query MCP server
	 * with space scope is attached to each space chat session. */
	dbPath?: string;
	spaceManager: SpaceManager;
	spaceAgentManager: SpaceAgentManager;
	spaceWorkflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
	/** Node execution repository for workflow-internal execution state */
	nodeExecutionRepo?: NodeExecutionRepository;
	reactiveDb?: ReactiveDatabase;
	/**
	 * Optional Task Agent Manager to wire into the underlying SpaceRuntime.
	 *
	 * When provided, the tick loop delegates task workflow execution to Task Agent
	 * sessions instead of calling advance() directly. If not provided at construction
	 * time (e.g. due to circular dependency resolution), use setTaskAgentManager()
	 * after both objects have been created.
	 */
	taskAgentManager?: TaskAgentManager;
	tickIntervalMs?: number;
	/**
	 * Optional gate data repository for onGateDataChanged support.
	 * When provided, notifyGateDataChanged() can be called to trigger lazy node
	 * activation after gate data is written externally (e.g. human approval via RPC).
	 */
	gateDataRepo?: GateDataRepository;
	channelCycleRepo?: ChannelCycleRepository;
	/**
	 * Optional SessionManager for provisioning space:chat:${spaceId} sessions.
	 * When provided, setupSpaceAgentSession() attaches MCP tools and system prompts
	 * to space chat sessions on startup and on space.created events.
	 */
	sessionManager?: SessionManager;
	/**
	 * Optional DaemonHub for subscribing to space.created events.
	 * When provided together with sessionManager, new spaces get their chat sessions
	 * provisioned automatically.
	 */
	daemonHub?: DaemonHub;
	/**
	 * Optional artifact repository for resolving completion action context.
	 * Passed through to SpaceRuntime so completion actions with `artifactType`
	 * can resolve artifact data for script env injection.
	 */
	artifactRepo?: WorkflowRunArtifactRepository;
	/**
	 * Optional LLM-backed workflow selector override. Passed through to
	 * SpaceRuntime verbatim. Defaults to `selectWorkflowWithLlmDefault` which
	 * calls the Claude Agent SDK. Tests should supply a deterministic stub.
	 */
	selectWorkflowWithLlm?: SelectWorkflowWithLlm;
}

export class SpaceRuntimeService {
	private readonly runtime: SpaceRuntime;
	private started = false;
	/** Unsubscribe handles for DaemonHub event subscriptions (daemon-lifetime). */
	private readonly unsubscribers: Array<() => void> = [];
	/** Reference to TaskAgentManager, stored when injected via setTaskAgentManager(). */
	private taskAgentManager: TaskAgentManager | null = null;
	/** Resolved nodeExecutionRepo — created from db if not provided in config. */
	private readonly nodeExecutionRepo: NodeExecutionRepository;
	/** Stores db-query server instances per space for cleanup on stop. */
	private readonly spaceDbQueryServers = new Map<string, DbQueryMcpServer>();
	/**
	 * Stores db-query server instances attached to member sessions of a space
	 * (non-space-chat sessions with `context.spaceId`). Keyed by `sessionId`.
	 * Each entry holds the server instance so it can be closed when the daemon
	 * stops, mirroring `spaceDbQueryServers` for the space-chat session.
	 */
	private readonly memberSessionDbQueryServers = new Map<string, DbQueryMcpServer>();

	constructor(private readonly config: SpaceRuntimeServiceConfig) {
		// Ensure nodeExecutionRepo is available — create from db if not provided.
		this.nodeExecutionRepo =
			this.config.nodeExecutionRepo ?? new NodeExecutionRepository(this.config.db);
		this.runtime = new SpaceRuntime({
			...config,
			nodeExecutionRepo: this.nodeExecutionRepo,
			selectWorkflowWithLlm: config.selectWorkflowWithLlm ?? selectWorkflowWithLlmDefault,
			onTaskUpdated: async ({ spaceId, task }) => {
				if (!this.config.daemonHub) return;
				await this.config.daemonHub.emit('space.task.updated', {
					sessionId: 'global',
					spaceId,
					taskId: task.id,
					task,
				});
			},
			onWorkflowRunCreated: async ({ spaceId, run }) => {
				if (!this.config.daemonHub) return;
				await this.config.daemonHub.emit('space.workflowRun.created', {
					sessionId: 'global',
					spaceId,
					runId: run.id,
					run,
				});
			},
			onWorkflowRunUpdated: async ({ spaceId, run }) => {
				if (!this.config.daemonHub) return;
				await this.config.daemonHub.emit('space.workflowRun.updated', {
					sessionId: 'global',
					spaceId,
					runId: run.id,
					run,
				});
			},
		});
	}

	/**
	 * Wire a TaskAgentManager into the underlying SpaceRuntime after construction.
	 *
	 * Resolves the circular dependency: SpaceRuntimeService must exist before
	 * TaskAgentManager (which takes it as a constructor argument), so the manager
	 * is injected back here once both are created.
	 *
	 * Mirrors the setNotificationSink() pattern.
	 */
	setTaskAgentManager(manager: TaskAgentManager): void {
		this.taskAgentManager = manager;
		this.runtime.setTaskAgentManager(manager);
	}

	/**
	 * Stop all active work for a space: terminates running agent sessions and
	 * cancels all in-progress/open tasks and active workflow runs.
	 *
	 * Called by the `space.stop` RPC handler before archiving the space.
	 * Does NOT archive the space itself — the caller is responsible for that.
	 */
	async stopActiveWork(spaceId: string): Promise<void> {
		const { taskRepo, workflowRunRepo } = this.config;

		// 1. Cancel all active tasks (in_progress or open) and their agent sessions.
		const activeTasks = taskRepo
			.listBySpace(spaceId)
			.filter((t) => t.status === 'in_progress' || t.status === 'open');

		await Promise.allSettled(
			activeTasks.map(async (task) => {
				// Stop the agent session first, then mark the task as cancelled in the DB.
				if (this.taskAgentManager) {
					await this.taskAgentManager.cleanup(task.id, 'cancelled').catch((err: unknown) => {
						log.warn(`stopActiveWork: failed to cleanup agent session for task ${task.id}:`, err);
					});
				}
				taskRepo.updateTask(task.id, { status: 'cancelled' });
			})
		);

		// 2. Cancel all active workflow runs (pending, in_progress, blocked).
		const activeRuns = workflowRunRepo
			.listBySpace(spaceId)
			.filter(
				(r) => r.status === 'pending' || r.status === 'in_progress' || r.status === 'blocked'
			);

		for (const run of activeRuns) {
			try {
				workflowRunRepo.transitionStatus(run.id, 'cancelled');
			} catch (err) {
				log.warn(`stopActiveWork: failed to cancel workflow run ${run.id}:`, err);
			}
		}

		log.info(
			`stopActiveWork: cancelled ${activeTasks.length} tasks and ${activeRuns.length} workflow runs for space ${spaceId}`
		);
	}

	/** Start the underlying SpaceRuntime tick loop. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.runtime.start();
		this.subscribeToSpaceEvents();
		this.provisionExistingSpaces();
		log.info('SpaceRuntimeService started');
	}

	/** Stop the underlying SpaceRuntime tick loop and await in-flight ticks. */
	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		await this.runtime.stop();
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers.length = 0;

		// Close all db-query server connections to release read-only SQLite handles.
		for (const [spaceId, server] of this.spaceDbQueryServers) {
			try {
				server.close();
			} catch (error) {
				log.warn(`Failed to close db-query server for space ${spaceId}:`, error);
			}
		}
		this.spaceDbQueryServers.clear();

		// Close all member-session db-query servers as well.
		for (const [sessionId, server] of this.memberSessionDbQueryServers) {
			try {
				server.close();
			} catch (error) {
				log.warn(`Failed to close db-query server for member session ${sessionId}:`, error);
			}
		}
		this.memberSessionDbQueryServers.clear();

		log.info('SpaceRuntimeService stopped');
	}

	/**
	 * Subscribe to space.created and session.created events so newly created
	 * spaces get their chat sessions provisioned with MCP tools + system
	 * prompt, and every new session with a `context.spaceId` gets
	 * `space-agent-tools` (and `db-query`) attached so it can coordinate with
	 * the rest of the Space.
	 *
	 * Called once during start(). No-op when sessionManager or daemonHub are absent.
	 */
	private subscribeToSpaceEvents(): void {
		const { sessionManager, daemonHub } = this.config;
		if (!sessionManager || !daemonHub) return;

		const unsubCreated = daemonHub.on(
			'space.created',
			(event) => {
				void this.setupSpaceAgentSession(event.space).catch((err) => {
					log.error(`Failed to provision space chat session for space ${event.spaceId}:`, err);
				});
			},
			{ sessionId: 'global' }
		);
		this.unsubscribers.push(unsubCreated);

		// When any new session is created with `context.spaceId`, attach the
		// shared Space coordination tools. The space-chat session itself is
		// handled by `setupSpaceAgentSession` (it also sets the system prompt);
		// the space_task_agent sessions are handled by `TaskAgentManager`
		// (which merges `space-agent-tools` into its MCP set). This subscription
		// covers the remaining cases: worker/coder/general/room_chat sessions
		// that live inside a Space and need to send/receive messages via
		// `send_message_to_agent`, inspect tasks, etc.
		const unsubSessionCreated = daemonHub.on(
			'session.created',
			(event) => {
				void this.attachSpaceToolsToMemberSession(event.session).catch((err) => {
					log.error(
						`Failed to attach space tools to session ${event.sessionId} (space ${event.session.context?.spaceId ?? '?'}):`,
						err
					);
				});
			},
			{ sessionId: 'global' }
		);
		this.unsubscribers.push(unsubSessionCreated);

		// When a session is deleted, release any per-session db-query server we
		// spun up for it so read-only SQLite handles don't accumulate on a
		// long-lived daemon serving many short-lived worker sessions.
		const unsubSessionDeleted = daemonHub.on(
			'session.deleted',
			(event) => {
				this.releaseMemberSessionDbQuery(event.sessionId);
			},
			{ sessionId: 'global' }
		);
		this.unsubscribers.push(unsubSessionDeleted);
	}

	/**
	 * Close and evict the db-query server instance (if any) we attached to the
	 * given member session. Safe to call for sessions that never had one.
	 */
	private releaseMemberSessionDbQuery(sessionId: string): void {
		const server = this.memberSessionDbQueryServers.get(sessionId);
		if (!server) return;
		try {
			server.close();
		} catch (err) {
			log.warn(`Failed to close db-query server for member session ${sessionId}:`, err);
		}
		this.memberSessionDbQueryServers.delete(sessionId);
	}

	/**
	 * Provision space:chat:${spaceId} sessions for all existing spaces, and
	 * attach `space-agent-tools` to every other existing session whose
	 * `context.spaceId` is set.
	 *
	 * Called during start() to re-attach MCP tools and system prompts to existing
	 * space chat sessions after a daemon restart. The sessions already exist in DB;
	 * only the runtime configuration (MCP server, system prompt) needs re-attaching.
	 *
	 * No-op when sessionManager is absent.
	 */
	private provisionExistingSpaces(): void {
		const { sessionManager } = this.config;
		if (!sessionManager) return;

		void this.config.spaceManager
			.listSpaces()
			.then((spaces) => {
				return Promise.all(
					spaces.map((space) =>
						this.setupSpaceAgentSession(space).catch((err) => {
							log.error(`Failed to provision space chat session for space ${space.id}:`, err);
						})
					)
				);
			})
			.catch((err) => {
				log.error('Failed to list spaces for session provisioning:', err);
			});

		// Attach `space-agent-tools` (and, if configured, `db-query`) to every
		// other session that already lives inside a Space. We do this on startup
		// so a daemon restart doesn't leave pre-existing member sessions without
		// coordination tools.
		//
		// Run sequentially rather than in parallel: each attach performs a space
		// lookup and a session lookup (both hit SQLite), and a daemon restarting
		// with many Space member sessions would otherwise issue a thundering
		// herd of reads. Sequential is fast enough — the work is small per
		// session and happens once at startup — and avoids the burst.
		void (async () => {
			try {
				const all = sessionManager.listSessions({ includeArchived: false });
				for (const session of all) {
					if (!session.context?.spaceId) continue;
					try {
						await this.attachSpaceToolsToMemberSession(session);
					} catch (err) {
						log.error(
							`Failed to attach space tools to existing session ${session.id} (space ${session.context?.spaceId}):`,
							err
						);
					}
				}
			} catch (err) {
				log.error('Failed to iterate existing sessions for space-tool attachment:', err);
			}
		})();
	}

	/**
	 * Attach the shared `space-agent-tools` MCP server (and, when configured,
	 * a space-scoped `db-query` server) to a session that lives inside a Space
	 * but is not the Space-chat session itself.
	 *
	 * This widens the tool surface from "space chat session only" to "every
	 * session in the space", so worker/coder/general/room_chat sessions
	 * spawned inside a Space can coordinate with the rest of the Space
	 * (e.g., `send_message_to_agent`, `list_task_members`). Permission gating
	 * inside each tool handler (autonomyLevel checks, writer checks, etc.)
	 * ensures widening the surface does not bypass access control.
	 *
	 * Explicitly skipped for:
	 *   - `space_chat` sessions — handled by `setupSpaceAgentSession`, which
	 *     also sets the system prompt.
	 *   - `space_task_agent` sessions — handled by `TaskAgentManager`, which
	 *     merges `space-agent-tools` into its own MCP map.
	 *
	 * Uses `mergeRuntimeMcpServers` so any previously-attached MCP servers on
	 * the session (e.g., room tools) are preserved. The session's system
	 * prompt is **not** touched.
	 */
	async attachSpaceToolsToMemberSession(session: Session): Promise<void> {
		const { sessionManager } = this.config;
		if (!sessionManager) return;
		const spaceId = session.context?.spaceId;
		if (!spaceId) return;

		// Skip sessions that other owners already manage.
		if (session.type === 'space_chat') return;
		if (session.type === 'space_task_agent') return;

		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space) {
			log.warn(
				`attachSpaceToolsToMemberSession: space "${spaceId}" not found (session ${session.id})`
			);
			return;
		}

		const agentSession = await sessionManager.getSessionAsync(session.id);
		if (!agentSession) {
			log.warn(`attachSpaceToolsToMemberSession: agent session not found for ${session.id}`);
			return;
		}

		const spaceManagerForApproval = this.config.spaceManager;
		const mcpServer = createSpaceAgentMcpServer({
			spaceId: space.id,
			runtime: this.runtime,
			workflowManager: this.config.spaceWorkflowManager,
			taskRepo: this.config.taskRepo,
			nodeExecutionRepo: this.nodeExecutionRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			taskManager: new SpaceTaskManager(this.config.db, space.id, this.config.reactiveDb),
			spaceAgentManager: this.config.spaceAgentManager,
			taskAgentManager: this.taskAgentManager ?? undefined,
			gateDataRepo: this.config.gateDataRepo,
			daemonHub: this.config.daemonHub,
			onGateChanged: (runId, gateId) => {
				void this.notifyGateDataChanged(runId, gateId).catch(() => {});
			},
			getSpaceAutonomyLevel: async (sid) => {
				const s = await spaceManagerForApproval.getSpace(sid);
				return s?.autonomyLevel ?? 1;
			},
			// Member sessions don't declare themselves as "space-agent"; they are
			// ordinary participants in the Space. Leaving myAgentName undefined
			// means gate writer-authorization paths that rely on matching the
			// writer name fall through to the autonomy path, which is the
			// correct gating behavior for non-space-agent callers.
		});

		const additional: Record<string, McpServerConfig> = {
			'space-agent-tools': mcpServer as unknown as McpServerConfig,
		};

		if (this.config.dbPath) {
			// Close any stale instance for this session (e.g., on re-provision
			// after daemon restart) to avoid leaking read-only SQLite handles.
			this.releaseMemberSessionDbQuery(session.id);
			const dbQueryServer = createDbQueryMcpServer({
				dbPath: this.config.dbPath,
				scopeType: 'space',
				scopeValue: space.id,
			});
			this.memberSessionDbQueryServers.set(session.id, dbQueryServer);
			additional['db-query'] = dbQueryServer as unknown as McpServerConfig;
		}

		// Merge rather than replace — other subsystems (e.g., room tools) may
		// have already attached their own MCP servers on this session.
		agentSession.mergeRuntimeMcpServers(additional);

		log.info(
			`Attached space-agent-tools to member session ${session.id} (space ${space.id}, type ${session.type ?? 'worker'})`
		);
	}

	/**
	 * Attach MCP tools and system prompt to a space's chat session.
	 *
	 * Mirrors RoomRuntimeService.setupRoomAgentSession(). Called:
	 *   - On startup for all existing spaces (re-attaches after daemon restart)
	 *   - On space.created event for newly created spaces
	 *
	 * No-op when sessionManager is absent.
	 */
	async setupSpaceAgentSession(space: Space): Promise<void> {
		const {
			sessionManager,
			db,
			spaceWorkflowManager,
			spaceAgentManager,
			taskRepo,
			workflowRunRepo,
		} = this.config;
		if (!sessionManager) return;

		const spaceChatSessionId = `space:chat:${space.id}`;
		const session = await sessionManager.getSessionAsync(spaceChatSessionId);
		if (!session) {
			log.warn(`Space chat session not found for space ${space.id} (${spaceChatSessionId})`);
			return;
		}

		// Build context for the system prompt.
		const agents = spaceAgentManager.listBySpaceId(space.id);
		const workflows = spaceWorkflowManager.listWorkflows(space.id);

		const spaceManagerForApproval = this.config.spaceManager;
		const mcpServer = createSpaceAgentMcpServer({
			spaceId: space.id,
			runtime: this.runtime,
			workflowManager: spaceWorkflowManager,
			taskRepo,
			nodeExecutionRepo: this.nodeExecutionRepo,
			workflowRunRepo,
			taskManager: new SpaceTaskManager(db, space.id, this.config.reactiveDb),
			spaceAgentManager,
			taskAgentManager: this.taskAgentManager ?? undefined,
			gateDataRepo: this.config.gateDataRepo,
			daemonHub: this.config.daemonHub,
			onGateChanged: (runId, gateId) => {
				void this.notifyGateDataChanged(runId, gateId).catch(() => {});
			},
			activateNode: async (runId, nodeId) => {
				await this.activateWorkflowNode(runId, nodeId);
			},
			getSpaceAutonomyLevel: async (sid) => {
				const s = await spaceManagerForApproval.getSpace(sid);
				return s?.autonomyLevel ?? 1;
			},
			myAgentName: 'space-agent',
		});

		// Create a space-scoped db-query server if dbPath is configured.
		// Close any existing instance for this space to prevent connection leaks on re-setup.
		const existingDbQueryServer = this.spaceDbQueryServers.get(space.id);
		if (existingDbQueryServer) {
			try {
				existingDbQueryServer.close();
			} catch (err) {
				log.warn(`Failed to close stale db-query server for space ${space.id}:`, err);
			}
		}

		const mcpServers: Record<string, McpServerConfig> = {
			'space-agent-tools': mcpServer as unknown as McpServerConfig,
		};
		if (this.config.dbPath) {
			const dbQueryServer = createDbQueryMcpServer({
				dbPath: this.config.dbPath,
				scopeType: 'space',
				scopeValue: space.id,
			});
			this.spaceDbQueryServers.set(space.id, dbQueryServer);
			mcpServers['db-query'] = dbQueryServer as unknown as McpServerConfig;
		}

		session.setRuntimeMcpServers(mcpServers);

		session.setRuntimeSystemPrompt(
			buildSpaceChatSystemPrompt({
				background: space.backgroundContext,
				instructions: space.instructions,
				autonomyLevel: space.autonomyLevel,
				workflows: workflows.map((w) => ({
					id: w.id,
					name: w.name,
					description: w.description,
					tags: w.tags ?? [],
					nodeCount: w.nodes?.length ?? 0,
				})),
				agents: agents.map((a) => ({
					id: a.id,
					name: a.name,

					description: a.description,
				})),
			})
		);

		log.info(`Space chat session provisioned for space ${space.id}`);

		// Flush any Task Agent → Space Agent messages that were queued before
		// this session was provisioned (handles the daemon-restart activation race).
		if (this.taskAgentManager) {
			const activeRuns = this.config.workflowRunRepo.getActiveRuns(space.id);
			for (const run of activeRuns) {
				void this.taskAgentManager
					.flushPendingMessagesForSpaceAgent(space.id, run.id)
					.catch(() => {});
			}
		}
	}

	/**
	 * Returns the SpaceRuntime for the given space, starting it if needed.
	 *
	 * The underlying runtime is shared — one SpaceRuntime handles all spaces.
	 * This method validates that the space exists and ensures the runtime is
	 * running before returning it.
	 *
	 * Throws if the space does not exist.
	 */
	async createOrGetRuntime(spaceId: string): Promise<SpaceRuntime> {
		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space) {
			throw new Error(`Space not found: ${spaceId}`);
		}
		if (!this.started) {
			this.start();
		}
		return this.runtime;
	}

	/**
	 * Returns the shared SpaceRuntime without space validation.
	 * For system-level access (e.g. Global Spaces Agent) where no specific space context exists.
	 */
	getSharedRuntime(): SpaceRuntime {
		if (!this.started) {
			this.start();
		}
		return this.runtime;
	}

	/**
	 * Wire a notification sink into the underlying SpaceRuntime.
	 *
	 * Called after construction once the Space Agent session has been provisioned,
	 * since SpaceRuntimeService is instantiated before the global agent session exists.
	 * Delegates directly to the shared SpaceRuntime instance.
	 */
	setNotificationSink(sink: NotificationSink): void {
		this.runtime.setNotificationSink(sink);
	}

	/**
	 * Release the runtime for a given space.
	 *
	 * Currently a no-op — the shared runtime handles all spaces together.
	 * Reserved for future per-space runtime isolation.
	 */
	stopRuntime(_spaceId: string): void {
		// No-op: shared runtime handles all spaces; use stop() to stop entirely.
	}

	/**
	 * Notify that gate data has changed for a given run/gate pair.
	 *
	 * Creates a temporary ChannelRouter and calls onGateDataChanged() to re-evaluate
	 * all channels referencing the gate and lazily activate any newly-unblocked nodes.
	 *
	 * Used by the approveGate RPC handler and the writeGateData RPC handler to trigger
	 * downstream node activation after gate data is written externally (i.e. without going
	 * through the write_gate MCP tool, which has its own onGateDataChanged wiring).
	 *
	 * No-op when gateDataRepo was not provided at construction time.
	 */
	async notifyGateDataChanged(runId: string, gateId: string): Promise<SpaceTask[]> {
		if (!this.config.gateDataRepo) return [];
		// Resolve workspacePath from run → space for script gate evaluation.
		const run = this.config.workflowRunRepo.getRun(runId);
		let workspacePath: string | undefined;
		if (run) {
			const space = await this.config.spaceManager.getSpace(run.spaceId);
			workspacePath = space?.workspacePath;
		}
		const spaceManager = this.config.spaceManager;
		const taskAgentManager = this.taskAgentManager;
		const router = new ChannelRouter({
			taskRepo: this.config.taskRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			workflowManager: this.config.spaceWorkflowManager,
			agentManager: this.config.spaceAgentManager,
			nodeExecutionRepo: this.nodeExecutionRepo,
			gateDataRepo: this.config.gateDataRepo,
			channelCycleRepo: this.config.channelCycleRepo,
			db: this.config.db,
			workspacePath,
			getSpaceAutonomyLevel: async (spaceId) => {
				const s = await spaceManager.getSpace(spaceId);
				return s?.autonomyLevel ?? 1;
			},
			isSessionAlive: taskAgentManager ? (sid) => taskAgentManager.isSessionAlive(sid) : undefined,
			// Forward the runtime's current sink so a gate-driven reopen still
			// surfaces `workflow_run_reopened` to the Space Agent session.
			notificationSink: this.runtime.getNotificationSink(),
		});
		return router.onGateDataChanged(runId, gateId);
	}

	/**
	 * Lazily activate a workflow node.
	 *
	 * Builds a scoped ChannelRouter (same dependencies as `notifyGateDataChanged`)
	 * and delegates to `ChannelRouter.activateNode()`, which either reuses an
	 * existing node_execution for cyclic re-entry (preserving `agentSessionId` so
	 * history survives) or creates a pending execution for the tick loop to spawn.
	 *
	 * Exposed so the Space Agent's `send_message_to_task` tool can target a
	 * specific node even when that node has no live session yet.
	 */
	async activateWorkflowNode(runId: string, nodeId: string): Promise<SpaceTask[]> {
		if (!this.config.gateDataRepo) {
			throw new Error(
				'activateWorkflowNode requires gateDataRepo to be configured on SpaceRuntimeService.'
			);
		}
		const run = this.config.workflowRunRepo.getRun(runId);
		let workspacePath: string | undefined;
		if (run) {
			const space = await this.config.spaceManager.getSpace(run.spaceId);
			workspacePath = space?.workspacePath;
		}
		const spaceManager = this.config.spaceManager;
		const taskAgentManager = this.taskAgentManager;
		const router = new ChannelRouter({
			taskRepo: this.config.taskRepo,
			workflowRunRepo: this.config.workflowRunRepo,
			workflowManager: this.config.spaceWorkflowManager,
			agentManager: this.config.spaceAgentManager,
			nodeExecutionRepo: this.nodeExecutionRepo,
			gateDataRepo: this.config.gateDataRepo,
			channelCycleRepo: this.config.channelCycleRepo,
			db: this.config.db,
			workspacePath,
			getSpaceAutonomyLevel: async (spaceId) => {
				const s = await spaceManager.getSpace(spaceId);
				return s?.autonomyLevel ?? 1;
			},
			isSessionAlive: taskAgentManager ? (sid) => taskAgentManager.isSessionAlive(sid) : undefined,
		});
		return router.activateNode(runId, nodeId);
	}

	/**
	 * Resume completion action execution for a task paused at a pending action.
	 *
	 * Delegates to SpaceRuntime.resumeCompletionActions(). Called from the
	 * spaceTask.update RPC handler when a human approves a task that was paused
	 * at a completion action checkpoint.
	 *
	 * @param options.approvalReason Optional human-supplied rationale for the
	 *   approval. Persisted on the resulting task record for audit.
	 */
	async resumeCompletionActions(
		spaceId: string,
		taskId: string,
		options?: { approvalReason?: string | null }
	): Promise<SpaceTask | null> {
		return this.runtime.resumeCompletionActions(spaceId, taskId, options);
	}
}
