/**
 * SpaceRuntimeService Unit Tests
 *
 * Covers:
 * - createOrGetRuntime(): throws if space not found
 * - createOrGetRuntime(): starts runtime and returns SpaceRuntime instance
 * - createOrGetRuntime(): returns the same runtime on repeated calls
 * - stopRuntime(): is a no-op (doesn't throw)
 * - start() / stop() lifecycle: idempotent, starts/stops underlying runtime
 * - setTaskAgentManager(): wires TaskAgentManager into the underlying SpaceRuntime
 */

import { describe, test, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceRuntimeServiceConfig } from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import type { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type {
	NotificationSink,
	SpaceNotificationEvent,
} from '../../../../src/lib/space/runtime/notification-sink.ts';
import type { SessionManager } from '../../../../src/lib/session-manager.ts';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { DaemonHub } from '../../../../src/lib/daemon-hub.ts';
import type { McpServerConfig, Session, Space } from '@neokai/shared';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository as SpaceWorkflowRunRepo } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository as SpaceTaskRepo } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager as AgentMgr } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager as WorkflowMgr } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager as SpaceMgr } from '../../../../src/lib/space/managers/space-manager.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.now();

const mockSpace: Space = {
	id: 'space-1',
	slug: 'test-space',
	workspacePath: '/tmp/test-workspace',
	name: 'Test Space',
	description: '',
	backgroundContext: '',
	instructions: '',
	sessionIds: [],
	status: 'active',
	createdAt: NOW,
	updatedAt: NOW,
};

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
	return {
		getSpace: mock(async () => space),
		listSpaces: mock(async () => []),
	} as unknown as SpaceManager;
}

function buildConfig(
	spaceManager: SpaceManager,
	tickIntervalMs = 60_000
): SpaceRuntimeServiceConfig {
	return {
		db: {} as BunDatabase,
		spaceManager,
		spaceAgentManager: {} as SpaceAgentManager,
		spaceWorkflowManager: {} as SpaceWorkflowManager,
		workflowRunRepo: {} as SpaceWorkflowRunRepository,
		taskRepo: {} as SpaceTaskRepository,
		tickIntervalMs,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SpaceRuntimeService', () => {
	let spaceManager: SpaceManager;
	let service: SpaceRuntimeService;

	beforeEach(() => {
		spaceManager = createMockSpaceManager(mockSpace);
		service = new SpaceRuntimeService(buildConfig(spaceManager));
	});

	// ─── createOrGetRuntime ──────────────────────────────────────────────────

	describe('createOrGetRuntime()', () => {
		test('throws if space not found', async () => {
			const noSpaceManager = createMockSpaceManager(null);
			const svc = new SpaceRuntimeService(buildConfig(noSpaceManager));

			await expect(svc.createOrGetRuntime('missing-space')).rejects.toThrow(
				'Space not found: missing-space'
			);
		});

		test('starts runtime and returns a SpaceRuntime instance', async () => {
			const runtime = await service.createOrGetRuntime('space-1');

			// Should return a runtime object (SpaceRuntime has start/stop methods)
			expect(runtime).toBeDefined();
			expect(typeof runtime.start).toBe('function');
			expect(typeof runtime.stop).toBe('function');
			expect(typeof runtime.executeTick).toBe('function');
		});

		test('auto-starts the service when not yet started', async () => {
			// Service not explicitly started — createOrGetRuntime should auto-start it
			expect((service as unknown as { started: boolean }).started).toBe(false);
			await service.createOrGetRuntime('space-1');
			expect((service as unknown as { started: boolean }).started).toBe(true);
		});

		test('returns the same runtime object on repeated calls', async () => {
			const runtime1 = await service.createOrGetRuntime('space-1');
			const runtime2 = await service.createOrGetRuntime('space-1');

			// Shared runtime — same instance
			expect(runtime1).toBe(runtime2);
		});

		test('returns same runtime for different space IDs (shared runtime)', async () => {
			const space2Manager = {
				getSpace: mock(async (id: string) =>
					id === 'space-2' ? { ...mockSpace, id: 'space-2' } : mockSpace
				),
			} as unknown as SpaceManager;
			const svc = new SpaceRuntimeService(buildConfig(space2Manager));

			const runtime1 = await svc.createOrGetRuntime('space-1');
			const runtime2 = await svc.createOrGetRuntime('space-2');

			// One shared runtime handles all spaces
			expect(runtime1).toBe(runtime2);
		});
	});

	// ─── stopRuntime ─────────────────────────────────────────────────────────

	describe('stopRuntime()', () => {
		test('is a no-op — does not throw', () => {
			expect(() => service.stopRuntime('space-1')).not.toThrow();
			expect(() => service.stopRuntime('nonexistent')).not.toThrow();
		});

		test('does not stop the service (shared runtime remains running)', async () => {
			service.start();
			service.stopRuntime('space-1');
			// Service should still be started
			expect((service as unknown as { started: boolean }).started).toBe(true);
		});
	});

	// ─── setNotificationSink ─────────────────────────────────────────────────

	describe('setNotificationSink()', () => {
		test('method exists and is callable', () => {
			// Verify the delegation method is present on SpaceRuntimeService
			expect(typeof service.setNotificationSink).toBe('function');
		});
	});

	// ─── setTaskAgentManager ─────────────────────────────────────────────────

	describe('setTaskAgentManager()', () => {
		test('method exists and is callable', () => {
			expect(typeof service.setTaskAgentManager).toBe('function');
		});

		test('accepts a TaskAgentManager without throwing', () => {
			const mockManager = {} as TaskAgentManager;
			expect(() => service.setTaskAgentManager(mockManager)).not.toThrow();
		});

		test('delegates to the underlying SpaceRuntime', () => {
			const mockManager = {} as TaskAgentManager;
			// Access the private runtime to verify propagation
			const runtime = (
				service as unknown as { runtime: { config: { taskAgentManager?: TaskAgentManager } } }
			).runtime;
			expect(runtime.config.taskAgentManager).toBeUndefined();
			service.setTaskAgentManager(mockManager);
			expect(runtime.config.taskAgentManager).toBe(mockManager);
		});

		test('config.taskAgentManager is passed to SpaceRuntime when provided at construction', () => {
			const mockManager = {} as TaskAgentManager;
			const config: SpaceRuntimeServiceConfig = {
				...buildConfig(spaceManager),
				taskAgentManager: mockManager,
			};
			const svc = new SpaceRuntimeService(config);
			const runtime = (
				svc as unknown as { runtime: { config: { taskAgentManager?: TaskAgentManager } } }
			).runtime;
			expect(runtime.config.taskAgentManager).toBe(mockManager);
		});
	});

	// ─── start / stop lifecycle ───────────────────────────────────────────────

	describe('start() / stop()', () => {
		test('start() sets started to true', () => {
			expect((service as unknown as { started: boolean }).started).toBe(false);
			service.start();
			expect((service as unknown as { started: boolean }).started).toBe(true);
		});

		test('start() is idempotent — calling twice is safe', () => {
			service.start();
			service.start(); // should not throw or double-start
			expect((service as unknown as { started: boolean }).started).toBe(true);
		});

		test('stop() sets started to false', async () => {
			service.start();
			await service.stop();
			expect((service as unknown as { started: boolean }).started).toBe(false);
		});

		test('stop() is idempotent — calling twice is safe', async () => {
			service.start();
			await service.stop();
			await service.stop(); // should not throw
			expect((service as unknown as { started: boolean }).started).toBe(false);
		});

		test('stop() on a never-started service is safe', async () => {
			await expect(service.stop()).resolves.toBeUndefined();
		});

		test('can restart after stop', async () => {
			service.start();
			await service.stop();
			service.start();
			expect((service as unknown as { started: boolean }).started).toBe(true);

			// createOrGetRuntime should still work after restart
			const runtime = await service.createOrGetRuntime('space-1');
			expect(runtime).toBeDefined();
		});
	});

	// ─── setupSpaceAgentSession ──────────────────────────────────────────────

	describe('setupSpaceAgentSession()', () => {
		function makeSession() {
			return {
				setRuntimeMcpServers: mock(() => {}),
				setRuntimeSystemPrompt: mock(() => {}),
			} as unknown as AgentSession;
		}

		function makeSessionManager(session: AgentSession | null = makeSession()): SessionManager {
			return {
				getSessionAsync: mock(async () => session),
				createSession: mock(async () => 'space:chat:space-1'),
				// Startup backfill calls listSessions() for the non-space-chat
				// member-session sweep. Default to empty — tests that care
				// override this mock.
				listSessions: mock(() => [] as Session[]),
			} as unknown as SessionManager;
		}

		function makeWorkflowManager(): SpaceWorkflowManager {
			return {
				listWorkflows: mock(() => []),
			} as unknown as SpaceWorkflowManager;
		}

		function makeAgentManager(): SpaceAgentManager {
			return {
				listBySpaceId: mock(() => []),
			} as unknown as SpaceAgentManager;
		}

		function buildConfigWithSession(
			sessionManager: SessionManager,
			spaceManager: SpaceManager = createMockSpaceManager()
		): SpaceRuntimeServiceConfig {
			return {
				db: {} as BunDatabase,
				spaceManager,
				spaceAgentManager: makeAgentManager(),
				spaceWorkflowManager: makeWorkflowManager(),
				workflowRunRepo: {} as SpaceWorkflowRunRepository,
				taskRepo: {} as SpaceTaskRepository,
				tickIntervalMs: 60_000,
				sessionManager,
			};
		}

		test('attaches MCP server and system prompt to the space:chat session', async () => {
			const session = makeSession();
			const sessionManager = makeSessionManager(session);
			const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager));

			await svc.setupSpaceAgentSession(mockSpace);

			expect(sessionManager.getSessionAsync).toHaveBeenCalledWith(`space:chat:${mockSpace.id}`);
			expect(session.setRuntimeMcpServers).toHaveBeenCalledTimes(1);
			const [mcpArg] = (session.setRuntimeMcpServers as Mock<typeof session.setRuntimeMcpServers>)
				.mock.calls[0];
			expect(mcpArg).toHaveProperty('space-agent-tools');

			expect(session.setRuntimeSystemPrompt).toHaveBeenCalledTimes(1);
			const [promptArg] = (
				session.setRuntimeSystemPrompt as Mock<typeof session.setRuntimeSystemPrompt>
			).mock.calls[0];
			expect(typeof promptArg).toBe('string');
			expect(promptArg.length).toBeGreaterThan(0);
		});

		test('no-op when session does not exist in DB', async () => {
			const sessionManager = makeSessionManager(null); // session not found
			const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager));

			// Should not throw
			await expect(svc.setupSpaceAgentSession(mockSpace)).resolves.toBeUndefined();
		});

		test('no-op when sessionManager is not configured', async () => {
			// buildConfig (no sessionManager)
			const svc = new SpaceRuntimeService(buildConfig(createMockSpaceManager()));

			// Should not throw and silently skip
			await expect(svc.setupSpaceAgentSession(mockSpace)).resolves.toBeUndefined();
		});

		test('flushes pending Space Agent messages for active runs after provisioning', async () => {
			const session = makeSession();
			const sessionManager = makeSessionManager(session);

			// Mock workflowRunRepo with one active run
			const activeRun = { id: 'run-flush-wiring', status: 'in_progress', spaceId: mockSpace.id };
			const workflowRunRepo = {
				getActiveRuns: mock(() => [activeRun]),
			} as unknown as SpaceWorkflowRunRepository;

			const flushCalls: Array<{ spaceId: string; runId: string }> = [];
			const mockTaskAgentManager = {
				flushPendingMessagesForSpaceAgent: mock(async (spaceId: string, runId: string) => {
					flushCalls.push({ spaceId, runId });
				}),
			} as unknown as TaskAgentManager;

			const config: SpaceRuntimeServiceConfig = {
				...buildConfigWithSession(sessionManager),
				workflowRunRepo,
			};
			const svc = new SpaceRuntimeService(config);
			svc.setTaskAgentManager(mockTaskAgentManager);

			await svc.setupSpaceAgentSession(mockSpace);
			// Allow any void-dispatched promises to resolve
			await new Promise<void>((resolve) => setTimeout(resolve, 0));

			expect(flushCalls).toHaveLength(1);
			expect(flushCalls[0]).toEqual({ spaceId: mockSpace.id, runId: activeRun.id });
		});

		test('start() provisions existing spaces', async () => {
			const session = makeSession();
			const sessionManager = makeSessionManager(session);
			const spaceMgr: SpaceManager = {
				getSpace: mock(async () => mockSpace),
				listSpaces: mock(async () => [mockSpace]),
			} as unknown as SpaceManager;
			const svc = new SpaceRuntimeService(buildConfigWithSession(sessionManager, spaceMgr));

			svc.start();
			// Allow async provisioning microtasks to run
			await new Promise<void>((resolve) => setTimeout(resolve, 0));

			expect(spaceMgr.listSpaces).toHaveBeenCalled();
			// getSessionAsync was called for the existing space
			expect(sessionManager.getSessionAsync).toHaveBeenCalledWith(`space:chat:${mockSpace.id}`);

			await svc.stop();
		});

		test('start() subscribes to space.created events when daemonHub provided', async () => {
			const session = makeSession();
			const sessionManager = makeSessionManager(session);
			const daemonHub: DaemonHub = {
				on: mock(() => () => {}),
				emit: mock(async () => {}),
			} as unknown as DaemonHub;
			const config: SpaceRuntimeServiceConfig = {
				...buildConfigWithSession(sessionManager),
				daemonHub,
			};
			const svc = new SpaceRuntimeService(config);

			svc.start();

			// DaemonHub.on should have been called with 'space.created'
			const onCalls = (daemonHub.on as Mock<typeof daemonHub.on>).mock.calls;
			const spaceCreatedCall = onCalls.find(([event]) => event === 'space.created');
			expect(spaceCreatedCall).toBeDefined();

			await svc.stop();
		});

		test('stop() unsubscribes from space.created events', async () => {
			const unsubFn = mock(() => {});
			const session = makeSession();
			const sessionManager = makeSessionManager(session);
			const daemonHub: DaemonHub = {
				on: mock(() => unsubFn as unknown as () => void),
				emit: mock(async () => {}),
			} as unknown as DaemonHub;
			const config: SpaceRuntimeServiceConfig = {
				...buildConfigWithSession(sessionManager),
				daemonHub,
			};
			const svc = new SpaceRuntimeService(config);

			svc.start();
			await svc.stop();

			// Three subscriptions are registered: space.created, session.created,
			// and session.deleted (which releases per-session db-query servers).
			expect(unsubFn).toHaveBeenCalledTimes(3);
		});
	});

	// ─── attachSpaceToolsToMemberSession ─────────────────────────────────────
	//
	// These tests cover the wider scope introduced for Task #31 Part B:
	// every session whose `context.spaceId` is set (other than space_chat,
	// which has its own full-prompt setup, and space_task_agent, which is
	// managed by TaskAgentManager) should get `space-agent-tools` merged
	// into its runtime MCP map — without touching its system prompt.

	describe('attachSpaceToolsToMemberSession()', () => {
		function makeMemberAgentSession() {
			return {
				mergeRuntimeMcpServers: mock((_: Record<string, McpServerConfig>) => {}),
				setRuntimeMcpServers: mock(() => {}),
				setRuntimeSystemPrompt: mock(() => {}),
			} as unknown as AgentSession;
		}

		function makeSessionManager(agent: AgentSession | null): SessionManager {
			return {
				getSessionAsync: mock(async () => agent),
				listSessions: mock(() => [] as Session[]),
			} as unknown as SessionManager;
		}

		function buildMemberConfig(opts: {
			sessionManager: SessionManager;
			listSessionsResult?: Session[];
			dbPath?: string;
		}): SpaceRuntimeServiceConfig {
			if (opts.listSessionsResult) {
				(opts.sessionManager as unknown as { listSessions: Mock<() => Session[]> }).listSessions =
					mock(() => opts.listSessionsResult as Session[]);
			}
			return {
				db: {} as BunDatabase,
				dbPath: opts.dbPath,
				spaceManager: createMockSpaceManager(mockSpace),
				spaceAgentManager: {
					listBySpaceId: mock(() => []),
				} as unknown as SpaceAgentManager,
				spaceWorkflowManager: {
					listWorkflows: mock(() => []),
				} as unknown as SpaceWorkflowManager,
				workflowRunRepo: {} as SpaceWorkflowRunRepository,
				taskRepo: {} as SpaceTaskRepository,
				tickIntervalMs: 60_000,
				sessionManager: opts.sessionManager,
			};
		}

		function makeMemberSession(overrides: Partial<Session> = {}): Session {
			return {
				id: 'worker-session-1',
				title: 'Worker',
				workspacePath: '/tmp/ws',
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: 'active',
				config: { tools: {} },
				metadata: {},
				type: 'worker',
				context: { spaceId: mockSpace.id },
				...overrides,
			} as unknown as Session;
		}

		test('attaches space-agent-tools to a worker session with context.spaceId', async () => {
			const agent = makeMemberAgentSession();
			const sessionManager = makeSessionManager(agent);
			const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

			await svc.attachSpaceToolsToMemberSession(makeMemberSession());

			const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
			expect(mergeMock).toHaveBeenCalledTimes(1);
			const [additional] = mergeMock.mock.calls[0];
			expect(additional).toHaveProperty('space-agent-tools');
			// No db-query attached when dbPath is not configured.
			expect(additional).not.toHaveProperty('db-query');
			// System prompt must NOT be touched on member sessions.
			expect(agent.setRuntimeSystemPrompt).not.toHaveBeenCalled();
		});

		test('also attaches db-query when dbPath is configured', async () => {
			const agent = makeMemberAgentSession();
			const sessionManager = makeSessionManager(agent);

			// db-query opens a real read-only connection, so the file must exist.
			const dir = join(
				process.cwd(),
				'tmp',
				'test-space-tools',
				`db-${Date.now()}-${Math.random().toString(36).slice(2)}`
			);
			mkdirSync(dir, { recursive: true });
			const dbPath = join(dir, 'test.db');
			const tmpDb = new BunDatabase(dbPath);
			tmpDb.close();

			try {
				const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager, dbPath }));

				await svc.attachSpaceToolsToMemberSession(makeMemberSession());

				const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
				expect(mergeMock).toHaveBeenCalledTimes(1);
				const [additional] = mergeMock.mock.calls[0];
				expect(additional).toHaveProperty('space-agent-tools');
				expect(additional).toHaveProperty('db-query');

				await svc.stop();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test('skips sessions without context.spaceId', async () => {
			const agent = makeMemberAgentSession();
			const sessionManager = makeSessionManager(agent);
			const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

			await svc.attachSpaceToolsToMemberSession(
				makeMemberSession({ context: { roomId: 'room-1' } })
			);

			expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();
		});

		test('skips space_chat sessions (handled by setupSpaceAgentSession)', async () => {
			const agent = makeMemberAgentSession();
			const sessionManager = makeSessionManager(agent);
			const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

			await svc.attachSpaceToolsToMemberSession(
				makeMemberSession({ type: 'space_chat', id: `space:chat:${mockSpace.id}` })
			);

			expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();
		});

		test('skips space_task_agent sessions (handled by TaskAgentManager)', async () => {
			const agent = makeMemberAgentSession();
			const sessionManager = makeSessionManager(agent);
			const svc = new SpaceRuntimeService(buildMemberConfig({ sessionManager }));

			await svc.attachSpaceToolsToMemberSession(makeMemberSession({ type: 'space_task_agent' }));

			expect(agent.mergeRuntimeMcpServers).not.toHaveBeenCalled();
		});

		test('start() attaches tools to existing member sessions listed by sessionManager', async () => {
			const agent = makeMemberAgentSession();
			const sessionManager = makeSessionManager(agent);
			const listed: Session[] = [
				makeMemberSession({ id: 'member-1' }),
				makeMemberSession({ id: 'member-2' }),
				// A session without spaceId — should be skipped.
				makeMemberSession({ id: 'no-space', context: {} }),
			];
			const svc = new SpaceRuntimeService(
				buildMemberConfig({ sessionManager, listSessionsResult: listed })
			);

			svc.start();
			// Allow the provisioning microtasks to resolve.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));

			const mergeMock = agent.mergeRuntimeMcpServers as Mock<typeof agent.mergeRuntimeMcpServers>;
			// Exactly 2 attaches (one per member-N session). The no-space session
			// is filtered out before getSessionAsync is consulted.
			expect(mergeMock).toHaveBeenCalledTimes(2);

			await svc.stop();
		});
	});
});

// ─── setNotificationSink() integration tests ─────────────────────────────────
//
// Requires a real DB to trigger actual events via executeTick().

class MockSink implements NotificationSink {
	readonly events: SpaceNotificationEvent[] = [];
	notify(event: SpaceNotificationEvent): Promise<void> {
		this.events.push(event);
		return Promise.resolve();
	}
}

function makeTestDb(): BunDatabase {
	// Use in-memory SQLite — faster than file-based DB and avoids filesystem
	// I/O contention that caused beforeEach hook timeouts in CI.
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return db;
}

// ─── activateWorkflowNode — notification sink forwarding ─────────────────────
//
// Regression guard: SpaceRuntimeService.activateWorkflowNode must forward the
// runtime's current NotificationSink into the scoped ChannelRouter so that
// ChannelRouter.activateNode()'s `workflow_run_reopened` events propagate to
// the Space Agent session. Without the sink wiring, reopens of terminal runs
// would be silently dropped.

describe('activateWorkflowNode() — notification forwarding', () => {
	test('forwards workflow_run_reopened to the current NotificationSink when reopening a done run', async () => {
		const db = makeTestDb();
		try {
			const SPACE_ID = 'space-act-sink-1';
			const AGENT_ID = 'agent-act-sink-1';
			const NODE_A = 'node-act-a';
			const NODE_B = 'node-act-b';

			// Seed space + agents
			db.prepare(
				`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
				 allowed_models, session_ids, slug, status, created_at, updated_at)
				 VALUES (?, '/tmp/ws', 'Test', '', '', '', '[]', '[]', ?, 'active', ?, ?)`
			).run(SPACE_ID, SPACE_ID, Date.now(), Date.now());
			db.prepare(
				`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
				 VALUES (?, ?, 'A', '', null, '[]', '', ?, ?)`
			).run(AGENT_ID, SPACE_ID, Date.now(), Date.now());

			// Build real repos/managers on this DB
			const taskRepo = new SpaceTaskRepo(db);
			const workflowRunRepo = new SpaceWorkflowRunRepo(db);
			const { GateDataRepository } = await import(
				'../../../../src/storage/repositories/gate-data-repository.ts'
			);
			const { ChannelCycleRepository } = await import(
				'../../../../src/storage/repositories/channel-cycle-repository.ts'
			);
			const gateDataRepo = new GateDataRepository(db);
			const channelCycleRepo = new ChannelCycleRepository(db);
			const agentRepo = new SpaceAgentRepository(db);
			const agentManager = new AgentMgr(agentRepo);
			const workflowRepo = new SpaceWorkflowRepository(db);
			const workflowManager = new WorkflowMgr(workflowRepo);
			const spaceManager = new SpaceMgr(db);

			// Minimal two-node workflow
			const workflow = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: `WF ${Date.now()}`,
				description: '',
				nodes: [
					{ id: NODE_A, name: 'A', agentId: AGENT_ID },
					{ id: NODE_B, name: 'B', agentId: AGENT_ID },
				],
				transitions: [],
				startNodeId: NODE_A,
				endNodeId: NODE_B,
				rules: [],
				tags: [],
				channels: [],
				gates: [],
				completionAutonomyLevel: 3,
			});

			// Create a run + canonical task, then mark the run as `done`.
			const run = workflowRunRepo.createRun({
				spaceId: SPACE_ID,
				workflowId: workflow.id,
				title: 'Reopen me',
			});
			taskRepo.createTask({
				spaceId: SPACE_ID,
				title: 'Reopen me',
				description: '',
				status: 'open',
				workflowRunId: run.id,
			});
			workflowRunRepo.updateStatusUnchecked(run.id, 'done');

			// Build the service with all deps the activateWorkflowNode path needs.
			const service = new SpaceRuntimeService({
				db,
				spaceManager: spaceManager as unknown as SpaceManager,
				spaceAgentManager: agentManager as unknown as SpaceAgentManager,
				spaceWorkflowManager: workflowManager as unknown as SpaceWorkflowManager,
				workflowRunRepo,
				taskRepo,
				tickIntervalMs: 60_000,
				gateDataRepo,
				channelCycleRepo,
			});

			// Install a recording sink AFTER construction — mirrors the real wiring
			// order (service is built before the Space Agent session exists).
			const sink = new MockSink();
			service.setNotificationSink(sink);

			// Activating a node on a `done` run must reopen it and notify.
			await service.activateWorkflowNode(run.id, NODE_B);

			const reopens = sink.events.filter((e) => e.kind === 'workflow_run_reopened');
			expect(reopens).toHaveLength(1);
			expect(reopens[0].kind).toBe('workflow_run_reopened');
			if (reopens[0].kind === 'workflow_run_reopened') {
				expect(reopens[0].runId).toBe(run.id);
				expect(reopens[0].spaceId).toBe(SPACE_ID);
				expect(reopens[0].fromStatus).toBe('done');
			}
		} finally {
			try {
				db.close();
			} catch {
				/* ignore */
			}
		}
	});
});
