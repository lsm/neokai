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

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { SpaceRuntimeService } from '../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceRuntimeServiceConfig } from '../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import type { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import type { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import type { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import type { TaskAgentManager } from '../../../src/lib/space/runtime/task-agent-manager.ts';
import type {
	NotificationSink,
	SpaceNotificationEvent,
} from '../../../src/lib/space/runtime/notification-sink.ts';
import type { Space } from '@neokai/shared';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository as SpaceWorkflowRunRepo } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository as SpaceTaskRepo } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager as AgentMgr } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager as WorkflowMgr } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager as SpaceMgr } from '../../../src/lib/space/managers/space-manager.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.now();

const mockSpace: Space = {
	id: 'space-1',
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

		test('stop() sets started to false', () => {
			service.start();
			service.stop();
			expect((service as unknown as { started: boolean }).started).toBe(false);
		});

		test('stop() is idempotent — calling twice is safe', () => {
			service.start();
			service.stop();
			service.stop(); // should not throw
			expect((service as unknown as { started: boolean }).started).toBe(false);
		});

		test('stop() on a never-started service is safe', () => {
			expect(() => service.stop()).not.toThrow();
		});

		test('can restart after stop', async () => {
			service.start();
			service.stop();
			service.start();
			expect((service as unknown as { started: boolean }).started).toBe(true);

			// createOrGetRuntime should still work after restart
			const runtime = await service.createOrGetRuntime('space-1');
			expect(runtime).toBeDefined();
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

describe('SpaceRuntimeService.setNotificationSink() — delegation integration', () => {
	let db: BunDatabase;
	let dir: string;
	let svc: SpaceRuntimeService;
	let taskRepo: SpaceTaskRepo;
	let workflowRunRepo: SpaceWorkflowRunRepo;
	let workflowManager: WorkflowMgr;

	const SPACE_ID = 'srs-notif-space';
	const AGENT_ID = 'srs-notif-agent';
	const STEP_A = 'srs-step-a';

	beforeEach(() => {
		({ db, dir } = makeTestDb());

		// Seed space row
		db.prepare(
			`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
       allowed_models, session_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
		).run(SPACE_ID, '/tmp/srs-ws', `Space ${SPACE_ID}`, Date.now(), Date.now());

		// Seed agent row
		db.prepare(
			`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
       config, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
		).run(AGENT_ID, SPACE_ID, 'Coder', 'coder', Date.now(), Date.now());

		workflowRunRepo = new SpaceWorkflowRunRepo(db);
		taskRepo = new SpaceTaskRepo(db);

		const agentManager = new AgentMgr(new SpaceAgentRepository(db));
		workflowManager = new WorkflowMgr(new SpaceWorkflowRepository(db));
		const spaceManager = new SpaceMgr(db);

		svc = new SpaceRuntimeService({
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
		});
	});

	afterEach(() => {
		svc.stop();
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test('setNotificationSink() delegates to SpaceRuntime — sink receives workflow_run_completed', async () => {
		const sink = new MockSink();

		// Wire sink via the service (post-construction wiring)
		svc.setNotificationSink(sink);

		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: 'Single-step',
			description: '',
			steps: [{ id: STEP_A, name: 'Only Step', agentId: AGENT_ID }],
			transitions: [],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		const runtime = await svc.createOrGetRuntime(SPACE_ID);
		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Test Run');
		taskRepo.updateTask(tasks[0].id, { status: 'completed' });

		await runtime.executeTick();

		// The sink was wired through the service — it must have received the event
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0].kind).toBe('workflow_run_completed');
		if (sink.events[0].kind === 'workflow_run_completed') {
			expect(sink.events[0].spaceId).toBe(SPACE_ID);
			expect(sink.events[0].status).toBe('completed');
		}
	});

	test('setNotificationSink() replaces any previously set sink', async () => {
		const sink1 = new MockSink();
		const sink2 = new MockSink();

		svc.setNotificationSink(sink1);
		svc.setNotificationSink(sink2); // replaces sink1

		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: 'Replace Sink',
			description: '',
			steps: [{ id: STEP_A, name: 'Only Step', agentId: AGENT_ID }],
			transitions: [],
			startStepId: STEP_A,
			rules: [],
			tags: [],
		});

		const runtime = await svc.createOrGetRuntime(SPACE_ID);
		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
		taskRepo.updateTask(tasks[0].id, { status: 'completed' });

		await runtime.executeTick();

		// Only sink2 should have received events
		expect(sink1.events).toHaveLength(0);
		expect(sink2.events).toHaveLength(1);
		expect(sink2.events[0].kind).toBe('workflow_run_completed');
	});
});
