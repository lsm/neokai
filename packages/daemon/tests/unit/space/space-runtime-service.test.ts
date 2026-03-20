/**
 * SpaceRuntimeService Unit Tests
 *
 * Covers:
 * - createOrGetRuntime(): throws if space not found
 * - createOrGetRuntime(): starts runtime and returns SpaceRuntime instance
 * - createOrGetRuntime(): returns the same runtime on repeated calls
 * - stopRuntime(): is a no-op (doesn't throw)
 * - start() / stop() lifecycle: idempotent, starts/stops underlying runtime
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { SpaceRuntimeService } from '../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceRuntimeServiceConfig } from '../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import type { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import type { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import type { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import type { Space } from '@neokai/shared';
import type { Database as BunDatabase } from 'bun:sqlite';

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
