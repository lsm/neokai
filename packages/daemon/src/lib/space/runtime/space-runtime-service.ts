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
import type { McpServerConfig, Space, SpaceTask } from '@neokai/shared';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository';
import type { GateDataRepository } from '../../../storage/repositories/gate-data-repository';
import type { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository';
import type { ReactiveDatabase } from '../../../storage/reactive-database';
import type { NotificationSink } from './notification-sink';
import type { TaskAgentManager } from './task-agent-manager';
import type { SessionManager } from '../../session-manager';
import type { DaemonHub } from '../../daemon-hub';
import { SpaceRuntime } from './space-runtime';
import { ChannelRouter } from './channel-router';
import { SpaceTaskManager } from '../managers/space-task-manager';
import { createSpaceAgentMcpServer } from '../tools/space-agent-tools';
import { buildSpaceChatSystemPrompt } from '../agents/space-chat-agent';
import { Logger } from '../../logger';

const log = new Logger('space-runtime-service');

export interface SpaceRuntimeServiceConfig {
	db: BunDatabase;
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

	constructor(private readonly config: SpaceRuntimeServiceConfig) {
		// Ensure nodeExecutionRepo is available — create from db if not provided.
		this.nodeExecutionRepo =
			this.config.nodeExecutionRepo ?? new NodeExecutionRepository(this.config.db);
		this.runtime = new SpaceRuntime({ ...config, nodeExecutionRepo: this.nodeExecutionRepo });
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

	/** Start the underlying SpaceRuntime tick loop. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.runtime.start();
		this.subscribeToSpaceEvents();
		this.provisionExistingSpaces();
		log.info('SpaceRuntimeService started');
	}

	/** Stop the underlying SpaceRuntime tick loop. */
	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.runtime.stop();
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers.length = 0;
		log.info('SpaceRuntimeService stopped');
	}

	/**
	 * Subscribe to space.created events so newly created spaces get their chat
	 * sessions provisioned with MCP tools and system prompt.
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
	}

	/**
	 * Provision space:chat:${spaceId} sessions for all existing spaces.
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

		const mcpServer = createSpaceAgentMcpServer({
			spaceId: space.id,
			runtime: this.runtime,
			workflowManager: spaceWorkflowManager,
			taskRepo,
			nodeExecutionRepo: this.nodeExecutionRepo,
			workflowRunRepo,
			taskManager: new SpaceTaskManager(db, space.id, this.config.reactiveDb),
			spaceAgentManager,
			taskAgentManager: this.taskAgentManager,
		});

		session.setRuntimeMcpServers({
			'space-agent-tools': mcpServer as unknown as McpServerConfig,
		});

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
					stepCount: w.nodes?.length ?? 0,
				})),
				agents: agents.map((a) => ({
					id: a.id,
					name: a.name,

					description: a.description,
				})),
			})
		);

		log.info(`Space chat session provisioned for space ${space.id}`);
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
		});
		return router.onGateDataChanged(runId, gateId);
	}
}
