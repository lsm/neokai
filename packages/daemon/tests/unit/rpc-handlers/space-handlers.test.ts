/**
 * Tests for Space RPC Handlers
 *
 * Covers:
 * - space.create: happy path, missing workspacePath, missing name, invalid path, duplicate path
 * - space.list: happy path, includeArchived flag
 * - space.get: happy path, missing id, not found
 * - space.update: happy path, missing id, not found
 * - space.archive: happy path (emits space.archived with full space), missing id
 * - space.delete: happy path, missing id, not found
 * - space.overview: happy path, missing id, not found
 * - DaemonHub events emitted on mutations
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { Space, SpaceTask, SpaceWorkflowRun } from '@neokai/shared';
import { setupSpaceHandlers } from '../../../src/lib/rpc-handlers/space-handlers';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager';
import type { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

type RequestHandler = (data: unknown) => Promise<unknown>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = Date.now();

const mockSpace: Space = {
	id: 'space-1',
	workspacePath: '/tmp/test-workspace',
	name: 'Test Space',
	description: 'A test space',
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
	description: 'desc',
	status: 'pending',
	priority: 'normal',
	dependsOn: [],
	createdAt: NOW,
	updatedAt: NOW,
};

const mockRun: SpaceWorkflowRun = {
	id: 'run-1',
	spaceId: 'space-1',
	workflowId: 'wf-1',
	title: 'Run 1',
	status: 'pending',
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
		createSpace: mock(async () => space!),
		getSpace: mock(async () => space),
		listSpaces: mock(async () => (space ? [space] : [])),
		updateSpace: mock(async () => space!),
		archiveSpace: mock(async () => ({ ...space!, status: 'archived' as const })),
		deleteSpace: mock(async () => true),
		addSession: mock(async () => space!),
		removeSession: mock(async () => space!),
	} as unknown as SpaceManager;
}

function createMockTaskRepo(tasks: SpaceTask[] = [mockTask]): SpaceTaskRepository {
	return {
		listBySpace: mock(() => tasks),
	} as unknown as SpaceTaskRepository;
}

function createMockRunRepo(runs: SpaceWorkflowRun[] = [mockRun]): SpaceWorkflowRunRepository {
	return {
		listBySpace: mock(() => runs),
	} as unknown as SpaceWorkflowRunRepository;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('space-handlers', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let spaceManager: SpaceManager;
	let taskRepo: SpaceTaskRepository;
	let runRepo: SpaceWorkflowRunRepository;

	function setup(space: Space | null = mockSpace) {
		const mh = createMockMessageHub();
		hub = mh.hub;
		handlers = mh.handlers;
		daemonHub = createMockDaemonHub();
		spaceManager = createMockSpaceManager(space);
		taskRepo = createMockTaskRepo();
		runRepo = createMockRunRepo();
		setupSpaceHandlers(hub, spaceManager, taskRepo, runRepo, daemonHub);
	}

	const call = (method: string, data: unknown) => {
		const handler = handlers.get(method);
		if (!handler) throw new Error(`No handler registered for ${method}`);
		return handler(data);
	};

	// ─── space.create ──────────────────────────────────────────────────────────

	describe('space.create', () => {
		beforeEach(() => setup());

		it('creates a space and emits space.created', async () => {
			const result = await call('space.create', {
				workspacePath: '/tmp/test',
				name: 'My Space',
			});

			expect(result).toEqual(mockSpace);
			expect(spaceManager.createSpace).toHaveBeenCalledTimes(1);
			expect(daemonHub.emit).toHaveBeenCalledWith('space.created', {
				sessionId: 'global',
				spaceId: mockSpace.id,
				space: mockSpace,
			});
		});

		it('throws when workspacePath is missing', async () => {
			await expect(call('space.create', { name: 'X' })).rejects.toThrow(
				'workspacePath is required'
			);
		});

		it('throws when name is missing', async () => {
			await expect(call('space.create', { workspacePath: '/tmp/x' })).rejects.toThrow(
				'name is required'
			);
		});

		it('throws when name is empty string', async () => {
			await expect(call('space.create', { workspacePath: '/tmp/x', name: '  ' })).rejects.toThrow(
				'name is required'
			);
		});

		it('propagates SpaceManager errors (e.g. invalid path)', async () => {
			(spaceManager.createSpace as ReturnType<typeof mock>).mockImplementation(async () => {
				throw new Error('Workspace path does not exist: /nonexistent');
			});

			await expect(
				call('space.create', { workspacePath: '/nonexistent', name: 'Bad' })
			).rejects.toThrow('Workspace path does not exist');
		});

		it('propagates duplicate path error from SpaceManager', async () => {
			(spaceManager.createSpace as ReturnType<typeof mock>).mockImplementation(async () => {
				throw new Error('A space already exists for workspace path: /tmp/test');
			});

			await expect(
				call('space.create', { workspacePath: '/tmp/test', name: 'Dup' })
			).rejects.toThrow('A space already exists');
		});
	});

	// ─── space.list ────────────────────────────────────────────────────────────

	describe('space.list', () => {
		beforeEach(() => setup());

		it('lists active spaces by default', async () => {
			const result = await call('space.list', {});
			expect(result).toEqual([mockSpace]);
			expect(spaceManager.listSpaces).toHaveBeenCalledWith(false);
		});

		it('lists including archived when requested', async () => {
			await call('space.list', { includeArchived: true });
			expect(spaceManager.listSpaces).toHaveBeenCalledWith(true);
		});

		it('accepts null/undefined data', async () => {
			await call('space.list', null);
			expect(spaceManager.listSpaces).toHaveBeenCalledWith(false);
		});
	});

	// ─── space.get ─────────────────────────────────────────────────────────────

	describe('space.get', () => {
		beforeEach(() => setup());

		it('returns the space when found', async () => {
			const result = await call('space.get', { id: 'space-1' });
			expect(result).toEqual(mockSpace);
		});

		it('throws when id is missing', async () => {
			await expect(call('space.get', {})).rejects.toThrow('id is required');
		});

		it('throws when space is not found', async () => {
			setup(null);
			await expect(call('space.get', { id: 'nope' })).rejects.toThrow('Space not found: nope');
		});
	});

	// ─── space.update ──────────────────────────────────────────────────────────

	describe('space.update', () => {
		beforeEach(() => setup());

		it('updates the space and emits space.updated', async () => {
			const updated = { ...mockSpace, name: 'Renamed' };
			(spaceManager.updateSpace as ReturnType<typeof mock>).mockResolvedValue(updated);

			const result = await call('space.update', { id: 'space-1', name: 'Renamed' });

			expect(result).toEqual(updated);
			expect(spaceManager.updateSpace).toHaveBeenCalledWith('space-1', { name: 'Renamed' });
			expect(daemonHub.emit).toHaveBeenCalledWith('space.updated', {
				sessionId: 'global',
				spaceId: 'space-1',
				space: updated,
			});
		});

		it('throws when id is missing', async () => {
			await expect(call('space.update', { name: 'X' })).rejects.toThrow('id is required');
		});

		it('propagates errors from SpaceManager', async () => {
			(spaceManager.updateSpace as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Space not found: bad-id')
			);

			await expect(call('space.update', { id: 'bad-id', name: 'X' })).rejects.toThrow(
				'Space not found'
			);
		});
	});

	// ─── space.archive ─────────────────────────────────────────────────────────

	describe('space.archive', () => {
		beforeEach(() => setup());

		it('archives the space and emits dedicated space.archived event with full space', async () => {
			const archivedSpace = { ...mockSpace, status: 'archived' as const };
			(spaceManager.archiveSpace as ReturnType<typeof mock>).mockResolvedValue(archivedSpace);

			const result = await call('space.archive', { id: 'space-1' });

			expect((result as Space).status).toBe('archived');
			expect(spaceManager.archiveSpace).toHaveBeenCalledWith('space-1');
			// Must emit space.archived (not space.updated) with the full space object
			expect(daemonHub.emit).toHaveBeenCalledWith('space.archived', {
				sessionId: 'global',
				spaceId: 'space-1',
				space: archivedSpace,
			});
		});

		it('does NOT emit space.updated on archive', async () => {
			await call('space.archive', { id: 'space-1' });

			const calls = (daemonHub.emit as ReturnType<typeof mock>).mock.calls;
			const updatedCall = calls.find((c: unknown[]) => c[0] === 'space.updated');
			expect(updatedCall).toBeUndefined();
		});

		it('throws when id is missing', async () => {
			await expect(call('space.archive', {})).rejects.toThrow('id is required');
		});

		it('propagates errors from SpaceManager', async () => {
			(spaceManager.archiveSpace as ReturnType<typeof mock>).mockRejectedValue(
				new Error('Space not found: nope')
			);

			await expect(call('space.archive', { id: 'nope' })).rejects.toThrow('Space not found');
		});
	});

	// ─── space.delete ──────────────────────────────────────────────────────────

	describe('space.delete', () => {
		beforeEach(() => setup());

		it('deletes the space and emits space.deleted', async () => {
			const result = await call('space.delete', { id: 'space-1' });

			expect(result).toEqual({ success: true });
			expect(spaceManager.deleteSpace).toHaveBeenCalledWith('space-1');
			expect(daemonHub.emit).toHaveBeenCalledWith('space.deleted', {
				sessionId: 'global',
				spaceId: 'space-1',
			});
		});

		it('throws when id is missing', async () => {
			await expect(call('space.delete', {})).rejects.toThrow('id is required');
		});

		it('throws when space is not found (deleteSpace returns false)', async () => {
			(spaceManager.deleteSpace as ReturnType<typeof mock>).mockResolvedValue(false);

			await expect(call('space.delete', { id: 'ghost' })).rejects.toThrow('Space not found: ghost');
		});
	});

	// ─── space.overview ────────────────────────────────────────────────────────

	describe('space.overview', () => {
		beforeEach(() => setup());

		it('returns space, tasks, workflowRuns, and sessions', async () => {
			const result = (await call('space.overview', { id: 'space-1' })) as {
				space: Space;
				tasks: SpaceTask[];
				workflowRuns: SpaceWorkflowRun[];
				sessions: string[];
			};

			expect(result.space).toEqual(mockSpace);
			expect(result.tasks).toEqual([mockTask]);
			expect(result.workflowRuns).toEqual([mockRun]);
			expect(result.sessions).toEqual(mockSpace.sessionIds);
		});

		it('throws when id is missing', async () => {
			await expect(call('space.overview', {})).rejects.toThrow('id is required');
		});

		it('throws when space is not found', async () => {
			setup(null);
			await expect(call('space.overview', { id: 'ghost' })).rejects.toThrow(
				'Space not found: ghost'
			);
		});
	});
});
