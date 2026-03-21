/**
 * Global Spaces Agent — Provisioning logic.
 *
 * Creates and wires up the `spaces:global` session on daemon startup.
 * Follows the same pattern as RoomRuntimeService.setupRoomAgentSession():
 *   1. Check if session already exists (daemon restart)
 *   2. If not, create it
 *   3. Attach MCP tools and system prompt
 */

import type { McpServerConfig } from '@neokai/shared';
import type { Database as BunDatabase } from 'bun:sqlite';
import type { SessionManager } from '../session-manager';
import type { SpaceManager } from './managers/space-manager';
import type { SpaceAgentManager } from './managers/space-agent-manager';
import type { SpaceWorkflowManager } from './managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type { SpaceRuntimeService } from './runtime/space-runtime-service';
import type { DaemonHub } from '../daemon-hub';
import { Logger } from '../logger';
import { buildGlobalSpacesAgentPrompt } from './agents/global-spaces-agent';
import { createGlobalSpacesMcpServer, type GlobalSpacesState } from './tools/global-spaces-tools';
import { SessionNotificationSink } from './runtime/session-notification-sink';
import type { SessionFactory } from '../room/runtime/task-group-manager';

const GLOBAL_SESSION_ID = 'spaces:global';
const log = new Logger('global-spaces-agent');

/**
 * Unsubscribe handles for the task event subscriptions registered by the most recent
 * `provisionGlobalSpacesAgent` call. Stored at module level so a second call (e.g. on
 * daemon restart / error recovery) can clean up the previous listeners before re-subscribing,
 * preventing duplicate notifications.
 *
 * Note: these subscriptions are intentionally daemon-lifetime; they are never unsubscribed
 * during normal operation. The module-level store only exists to guard against double-init.
 */
let _taskEventUnsubs: Array<() => void> = [];

export interface ProvisionGlobalSpacesAgentDeps {
	sessionManager: SessionManager;
	spaceManager: SpaceManager;
	spaceAgentManager: SpaceAgentManager;
	spaceWorkflowManager: SpaceWorkflowManager;
	spaceRuntimeService: SpaceRuntimeService;
	/**
	 * SessionFactory used to inject messages into the global agent session.
	 * Must support `injectMessage(sessionId, message, opts)` for the `spaces:global` session.
	 * Typically built as an adapter over `SessionManager.injectMessage()`.
	 */
	sessionFactory: SessionFactory;
	taskRepo: SpaceTaskRepository;
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Database instance passed through to GlobalSpacesToolsConfig for SpaceTaskManager creation. */
	db: BunDatabase;
	/** Shared mutable state for the active space context. Created externally so RPC handlers can use the same reference. */
	state: GlobalSpacesState;
	/**
	 * DaemonHub for subscribing to task completion/failure events emitted by Task Agents.
	 * When provided, the global Space Agent session receives notification messages when tasks
	 * complete or fail via `space.task.completed` / `space.task.failed` events.
	 *
	 * The subscription routes all space task events to the single `spaces:global` session,
	 * which is intentional: the global agent manages tasks across all spaces. The notification
	 * message includes the spaceId and taskId so the agent can act on specific tasks.
	 */
	daemonHub?: DaemonHub;
}

/**
 * Provision the Global Spaces Agent session.
 *
 * On first run: creates the `spaces:global` session, attaches MCP tools and system prompt.
 * On restart: gets the existing session from cache/DB, re-attaches MCP tools and system prompt
 * (MCP servers are runtime-only and need re-creation on daemon restart).
 */
export async function provisionGlobalSpacesAgent(
	deps: ProvisionGlobalSpacesAgentDeps
): Promise<void> {
	const {
		sessionManager,
		spaceManager,
		spaceAgentManager,
		spaceWorkflowManager,
		spaceRuntimeService,
		sessionFactory,
		taskRepo,
		workflowRunRepo,
		db,
		state,
		daemonHub,
	} = deps;

	// Get the shared runtime (no specific space context needed for the global agent)
	const runtime = spaceRuntimeService.getSharedRuntime();

	// Check if session already exists (daemon restart)
	let existingSession = await sessionManager.getSessionAsync(GLOBAL_SESSION_ID);

	if (!existingSession) {
		// First run — create the session
		try {
			await sessionManager.createSession({
				sessionId: GLOBAL_SESSION_ID,
				sessionType: 'spaces_global',
				title: 'Spaces Agent',
				createdBy: 'neo',
			});
			log.info('Created global spaces agent session');
		} catch (error) {
			log.error('Failed to create global spaces agent session:', error);
			throw error;
		}
		existingSession = await sessionManager.getSessionAsync(GLOBAL_SESSION_ID);
	}

	if (!existingSession) {
		throw new Error(`Failed to get AgentSession for ${GLOBAL_SESSION_ID} after creation`);
	}

	// Wire the NotificationSink: session now exists so the sink can be created and injected.
	// SpaceRuntimeService is constructed before this point and exposes a setter exactly for this
	// pattern (circular dependency: service exists before session does).
	const notificationSink = new SessionNotificationSink({
		sessionFactory,
		sessionId: GLOBAL_SESSION_ID,
	});
	spaceRuntimeService.setNotificationSink(notificationSink);
	log.info('Notification sink wired into SpaceRuntimeService');

	// Create MCP server and attach to session
	const mcpServer = createGlobalSpacesMcpServer(
		{
			spaceManager,
			spaceAgentManager,
			runtime,
			workflowManager: spaceWorkflowManager,
			taskRepo,
			workflowRunRepo,
			db,
		},
		state
	);

	existingSession.setRuntimeMcpServers({
		'global-spaces-tools': mcpServer as unknown as McpServerConfig,
	});
	existingSession.setRuntimeSystemPrompt(buildGlobalSpacesAgentPrompt());

	// Subscribe to task completion/failure events from Task Agents.
	// When a task completes or fails, inject a notification message into the Space Agent session
	// so it can take appropriate action (start next task, alert the user, etc.).
	//
	// All space task events are routed to the single spaces:global session — the global agent
	// manages tasks across all spaces. Each message includes spaceId and taskId so the agent
	// can reference tasks in follow-up tool calls (e.g. get_task_detail).
	//
	// Guard against double-init: clean up any previous subscriptions before re-subscribing.
	if (daemonHub) {
		_taskEventUnsubs.forEach((unsub) => unsub());
		_taskEventUnsubs = [];

		const unsubCompleted = daemonHub.on('space.task.completed', (event) => {
			const summaryPart = event.summary ? ` Summary: ${event.summary}` : '';
			const message =
				`Task '${event.taskTitle}' (taskId: ${event.taskId}, spaceId: ${event.spaceId}) ` +
				`has completed.${summaryPart}`;
			void sessionFactory
				.injectMessage(GLOBAL_SESSION_ID, message, { deliveryMode: 'next_turn' })
				.catch((err) => {
					log.warn(
						`Failed to inject task.completed notification into ${GLOBAL_SESSION_ID}: ${err instanceof Error ? err.message : String(err)}`
					);
				});
		});

		const unsubFailed = daemonHub.on('space.task.failed', (event) => {
			const statusLabel = event.status === 'cancelled' ? 'cancelled' : 'failed';
			const summaryPart = event.summary ? ` Summary: ${event.summary}` : '';
			const message =
				`Task '${event.taskTitle}' (taskId: ${event.taskId}, spaceId: ${event.spaceId}) ` +
				`has ${statusLabel}.${summaryPart}`;
			void sessionFactory
				.injectMessage(GLOBAL_SESSION_ID, message, { deliveryMode: 'next_turn' })
				.catch((err) => {
					log.warn(
						`Failed to inject task.failed notification into ${GLOBAL_SESSION_ID}: ${err instanceof Error ? err.message : String(err)}`
					);
				});
		});

		_taskEventUnsubs = [unsubCompleted, unsubFailed];
		log.info('Subscribed to space.task.completed and space.task.failed events');
	}

	log.info('Global spaces agent session provisioned');
}
