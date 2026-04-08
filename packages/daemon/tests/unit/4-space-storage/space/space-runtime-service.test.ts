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
import { rmSync, mkdirSync } from 'node:fs';
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
import type { Space } from '@neokai/shared';
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

			expect(unsubFn).toHaveBeenCalledTimes(1);
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

function makeTestDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-srs-notif',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}
