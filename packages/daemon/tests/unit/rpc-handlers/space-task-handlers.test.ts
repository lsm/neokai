/**
 * Tests for Space Task RPC Handlers
 *
 * Covers:
 * - spaceTask.create: happy path, missing spaceId, missing title, null description,
 *   empty description (allowed), space not found, dependency not found error propagation
 * - spaceTask.list: happy path, missing spaceId, space not found
 * - spaceTask.get: happy path, space existence check, missing params, task not found
 * - spaceTask.update: status transition (delegates to setTaskStatus), same-status update
 *   (routes to updateTask — not spurious transition error), non-status update, missing params
 * - DaemonHub events emitted on mutations
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { Space, SpaceTask } from '@neokai/shared';
import { setupSpaceTaskHandlers } from '../../../src/lib/rpc-handlers/space-task-handlers';
import type { SpaceTaskManagerFactory } from '../../../src/lib/rpc-handlers/space-task-handlers';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager';
import type { SpaceTaskManager } from '../../../src/lib/space/managers/space-task-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

type RequestHandler = (data: unknown) => Promise<unknown>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

const mockTask: SpaceTask = {
	id: 'task-1',
	spaceId: 'space-1',
	title: 'Test Task',
	description: 'A task description',
	status: 'pending',
	priority: 'normal',
	dependsOn: [],
	createdAt: NOW,
	updatedAt: NOW,
};

// ─── Mock helpers ────────────────────────────────────────────────────────────

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
	return {
		getSpace: mock(async () => space),
	} as unknown as SpaceManager;
}

function createMockTaskManager(task: SpaceTask | null = mockTask): SpaceTaskManager {
	return {
		createTask: mock(async () => task!),
		getTask: mock(async () => task),
		listTasks: mock(async () => (task ? [task] : [])),
		setTaskStatus: mock(async () => ({ ...task!, status: 'in_progress' as const })),
		updateTask: mock(async () => ({ ...task!, title: 'Updated' })),
		updateTaskProgress: mock(async () => ({ ...task!, progress: 50 })),
	} as unknown as SpaceTaskManager;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('space-task-handlers', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let spaceManager: SpaceManager;
	let taskManager: SpaceTaskManager;
	let taskManagerFactory: SpaceTaskManagerFactory;

	function setup(space: Space | null = mockSpace, task: SpaceTask | null = mockTask) {
		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;
		daemonHub = createMockDaemonHub();
		spaceManager = createMockSpaceManager(space);
		taskManager = createMockTaskManager(task);
		taskManagerFactory = mock((_spaceId: string) => taskManager);
		setupSpaceTaskHandlers(hub, spaceManager, taskManagerFactory, daemonHub);
	}

	const call = (method: string, data: unknown) => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`No handler registered for ${method}`);
		return handler(data);
	};

	// ─── spaceTask.create ──────────────────────────────────────────────────────

	describe('spaceTask.create', () => {
		beforeEach(() => setup());

		it('creates a task and emits space.task.created', async () => {
			const result = await call('spaceTask.create', {
				spaceId: 'space-1',
				title: 'Do work',
				description: 'description',
			});

			expect(result).toEqual(mockTask);
			expect(taskManager.createTask).toHaveBeenCalledTimes(1);
			expect(daemonHub.emit).toHaveBeenCalledWith('space.task.created', {
				sessionId: 'global',
				spaceId: 'space-1',
				taskId: mockTask.id,
				task: mockTask,
			});
		});

		it('allows empty string description', async () => {
			await expect(
				call('spaceTask.create', { spaceId: 'space-1', title: 'T', description: '' })
			).resolves.toBeDefined();
		});

		it('throws when spaceId is missing', async () => {
			await expect(call('spaceTask.create', { title: 'T', description: 'D' })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('throws when title is missing', async () => {
			await expect(
				call('spaceTask.create', { spaceId: 'space-1', description: 'D' })
			).rejects.toThrow('title is required');
		});

		it('throws when title is empty string', async () => {
			await expect(
				call('spaceTask.create', { spaceId: 'space-1', title: '', description: 'D' })
			).rejects.toThrow('title is required');
		});

		it('throws when description is null', async () => {
			await expect(
				call('spaceTask.create', { spaceId: 'space-1', title: 'T', description: null })
			).rejects.toThrow('description must not be null');
		});

		it('throws when description is undefined', async () => {
			await expect(call('spaceTask.create', { spaceId: 'space-1', title: 'T' })).rejects.toThrow(
				'description must not be null'
			);
		});

		it('throws when space is not found', async () => {
			setup(null);
			await expect(
				call('spaceTask.create', {
					spaceId: 'ghost',
					title: 'T',
					description: 'D',
				})
			).rejects.toThrow('Space not found: ghost');
		});

		it('propagates task manager errors (e.g. invalid dependency)', async () => {
			(taskManager.createTask as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Dependency task not found in space: bad-dep')
			);

			await expect(
				call('spaceTask.create', {
					spaceId: 'space-1',
					title: 'T',
					description: 'D',
					dependsOn: ['bad-dep'],
				})
			).rejects.toThrow('Dependency task not found');
		});
	});

	// ─── spaceTask.list ────────────────────────────────────────────────────────

	describe('spaceTask.list', () => {
		beforeEach(() => setup());

		it('lists tasks for a space', async () => {
			const result = await call('spaceTask.list', { spaceId: 'space-1' });
			expect(result).toEqual([mockTask]);
			expect(taskManager.listTasks).toHaveBeenCalledWith(false);
		});

		it('passes includeArchived flag', async () => {
			await call('spaceTask.list', { spaceId: 'space-1', includeArchived: true });
			expect(taskManager.listTasks).toHaveBeenCalledWith(true);
		});

		it('throws when spaceId is missing', async () => {
			await expect(call('spaceTask.list', {})).rejects.toThrow('spaceId is required');
		});

		it('throws when space is not found', async () => {
			setup(null);
			await expect(call('spaceTask.list', { spaceId: 'ghost' })).rejects.toThrow(
				'Space not found: ghost'
			);
		});
	});

	// ─── spaceTask.get ─────────────────────────────────────────────────────────

	describe('spaceTask.get', () => {
		beforeEach(() => setup());

		it('returns the task when found', async () => {
			const result = await call('spaceTask.get', {
				spaceId: 'space-1',
				taskId: 'task-1',
			});
			expect(result).toEqual(mockTask);
		});

		it('verifies space existence before fetching task', async () => {
			setup(null);
			await expect(call('spaceTask.get', { spaceId: 'ghost', taskId: 'task-1' })).rejects.toThrow(
				'Space not found: ghost'
			);
			expect(taskManager.getTask).not.toHaveBeenCalled();
		});

		it('throws when spaceId is missing', async () => {
			await expect(call('spaceTask.get', { taskId: 'task-1' })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('throws when taskId is missing', async () => {
			await expect(call('spaceTask.get', { spaceId: 'space-1' })).rejects.toThrow(
				'taskId is required'
			);
		});

		it('throws when task is not found', async () => {
			setup(mockSpace, null);
			await expect(call('spaceTask.get', { spaceId: 'space-1', taskId: 'ghost' })).rejects.toThrow(
				'Task not found: ghost'
			);
		});
	});

	// ─── spaceTask.update ──────────────────────────────────────────────────────

	describe('spaceTask.update', () => {
		beforeEach(() => setup());

		it('delegates status change to setTaskStatus and emits space.task.updated', async () => {
			const result = await call('spaceTask.update', {
				spaceId: 'space-1',
				taskId: 'task-1',
				status: 'in_progress',
			});

			expect((result as SpaceTask).status).toBe('in_progress');
			expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'in_progress', {
				result: undefined,
				error: undefined,
			});
			expect(daemonHub.emit).toHaveBeenCalledWith('space.task.updated', {
				sessionId: 'global',
				spaceId: 'space-1',
				taskId: 'task-1',
				task: expect.objectContaining({ status: 'in_progress' }),
			});
		});

		it('does NOT call setTaskStatus when status is unchanged (avoids spurious transition error)', async () => {
			// mockTask has status: 'pending'; sending status: 'pending' should not call setTaskStatus
			const result = await call('spaceTask.update', {
				spaceId: 'space-1',
				taskId: 'task-1',
				status: 'pending', // same as current
				title: 'New title',
			});

			expect(taskManager.setTaskStatus).not.toHaveBeenCalled();
			expect(taskManager.updateTask).toHaveBeenCalledWith('task-1', {
				status: 'pending',
				title: 'New title',
			});
			expect(result).toBeDefined();
		});

		it('delegates non-status update to updateTask', async () => {
			const result = await call('spaceTask.update', {
				spaceId: 'space-1',
				taskId: 'task-1',
				title: 'Updated',
			});

			expect((result as SpaceTask).title).toBe('Updated');
			expect(taskManager.updateTask).toHaveBeenCalledWith('task-1', { title: 'Updated' });
			expect(daemonHub.emit).toHaveBeenCalledWith('space.task.updated', {
				sessionId: 'global',
				spaceId: 'space-1',
				taskId: 'task-1',
				task: expect.objectContaining({ title: 'Updated' }),
			});
		});

		it('passes result and error to setTaskStatus when provided with status', async () => {
			await call('spaceTask.update', {
				spaceId: 'space-1',
				taskId: 'task-1',
				status: 'needs_attention',
				error: 'Build failed',
			});

			expect(taskManager.setTaskStatus).toHaveBeenCalledWith('task-1', 'needs_attention', {
				result: undefined,
				error: 'Build failed',
			});
		});

		it('throws when spaceId is missing', async () => {
			await expect(call('spaceTask.update', { taskId: 'task-1', title: 'X' })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('throws when taskId is missing', async () => {
			await expect(call('spaceTask.update', { spaceId: 'space-1', title: 'X' })).rejects.toThrow(
				'taskId is required'
			);
		});

		it('propagates errors from setTaskStatus (invalid transitions)', async () => {
			// For this test, use a task that is already 'completed' to trigger an invalid transition
			const completedTask = { ...mockTask, status: 'completed' as const };
			setup(mockSpace, completedTask);

			(taskManager.setTaskStatus as ReturnType<typeof mock>).mockRejectedValue(
				new Error("Invalid status transition from 'completed' to 'pending'. Allowed: none")
			);

			await expect(
				call('spaceTask.update', {
					spaceId: 'space-1',
					taskId: 'task-1',
					status: 'pending',
				})
			).rejects.toThrow('Invalid status transition');
		});

		it('propagates errors from updateTask', async () => {
			(taskManager.updateTask as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Task not found: task-1')
			);

			await expect(
				call('spaceTask.update', {
					spaceId: 'space-1',
					taskId: 'task-1',
					title: 'X',
				})
			).rejects.toThrow('Task not found');
		});
	});
});
