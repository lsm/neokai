/**
 * Tests for Space Session Group RPC Handlers
 *
 * Covers:
 * - space.sessionGroup.list: happy path, missing spaceId, space not found
 * - space.sessionGroup.updateMember: happy path, missing params, space/group/member not found,
 *   cross-space group rejection, memberUpdated event emission, optional role update
 * - space.sessionGroup.delete: happy path, missing params, space/group not found,
 *   cross-space group rejection
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { Space, SpaceSessionGroup, SpaceSessionGroupMember } from '@neokai/shared';
import { setupSpaceSessionGroupHandlers } from '../../../src/lib/rpc-handlers/space-session-group-handlers';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager';
import type { SpaceSessionGroupRepository } from '../../../src/storage/repositories/space-session-group-repository';
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

const mockMember: SpaceSessionGroupMember = {
	id: 'member-1',
	groupId: 'group-1',
	sessionId: 'session-1',
	role: 'coder',
	status: 'active',
	orderIndex: 0,
	createdAt: NOW,
};

const mockGroup: SpaceSessionGroup = {
	id: 'group-1',
	spaceId: 'space-1',
	name: 'task:task-1',
	status: 'active',
	members: [mockMember],
	taskId: 'task-1',
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

function createMockRepo(
	overrides?: Partial<SpaceSessionGroupRepository>
): SpaceSessionGroupRepository {
	return {
		getGroupsBySpace: mock(() => [mockGroup]),
		getGroup: mock(() => mockGroup),
		updateMember: mock(() => mockMember),
		deleteGroup: mock(() => true),
		...overrides,
	} as unknown as SpaceSessionGroupRepository;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('space.sessionGroup.list', () => {
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let spaceManager: SpaceManager;
	let repo: SpaceSessionGroupRepository;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		handlers = h;
		daemonHub = createMockDaemonHub();
		spaceManager = createMockSpaceManager();
		repo = createMockRepo();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
	});

	it('returns all groups for the space', async () => {
		const result = await handlers.get('space.sessionGroup.list')!({ spaceId: 'space-1' });
		expect(result).toEqual({ groups: [mockGroup] });
		expect(repo.getGroupsBySpace).toHaveBeenCalledWith('space-1');
	});

	it('throws if spaceId is missing', async () => {
		await expect(handlers.get('space.sessionGroup.list')!({ spaceId: '' })).rejects.toThrow(
			'spaceId is required'
		);
	});

	it('throws if spaceId not provided at all', async () => {
		await expect(handlers.get('space.sessionGroup.list')!({})).rejects.toThrow(
			'spaceId is required'
		);
	});

	it('throws if space not found', async () => {
		spaceManager = createMockSpaceManager(null);
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		await expect(h.get('space.sessionGroup.list')!({ spaceId: 'bad-id' })).rejects.toThrow(
			'Space not found: bad-id'
		);
	});

	it('returns empty groups array when space has no groups', async () => {
		repo = createMockRepo({ getGroupsBySpace: mock(() => []) });
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		const result = await h.get('space.sessionGroup.list')!({ spaceId: 'space-1' });
		expect(result).toEqual({ groups: [] });
	});
});

describe('space.sessionGroup.updateMember', () => {
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let spaceManager: SpaceManager;
	let repo: SpaceSessionGroupRepository;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		handlers = h;
		daemonHub = createMockDaemonHub();
		spaceManager = createMockSpaceManager();
		repo = createMockRepo();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
	});

	it('updates member status and returns updated member', async () => {
		const completedMember = { ...mockMember, status: 'completed' as const };
		repo = createMockRepo({ updateMember: mock(() => completedMember) });
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);

		const result = await h.get('space.sessionGroup.updateMember')!({
			spaceId: 'space-1',
			groupId: 'group-1',
			sessionId: 'session-1',
			status: 'completed',
		});
		expect(result).toEqual({ member: completedMember });
		expect(repo.updateMember).toHaveBeenCalledWith('group-1', 'session-1', { status: 'completed' });
	});

	it('emits spaceSessionGroup.memberUpdated event', async () => {
		await handlers.get('space.sessionGroup.updateMember')!({
			spaceId: 'space-1',
			groupId: 'group-1',
			sessionId: 'session-1',
			status: 'completed',
		});
		expect(daemonHub.emit).toHaveBeenCalledWith('spaceSessionGroup.memberUpdated', {
			sessionId: 'space:space-1',
			spaceId: 'space-1',
			groupId: 'group-1',
			memberId: mockMember.id,
			member: mockMember,
		});
	});

	it('includes optional role in update when provided', async () => {
		await handlers.get('space.sessionGroup.updateMember')!({
			spaceId: 'space-1',
			groupId: 'group-1',
			sessionId: 'session-1',
			status: 'active',
			role: 'reviewer',
		});
		expect(repo.updateMember).toHaveBeenCalledWith('group-1', 'session-1', {
			status: 'active',
			role: 'reviewer',
		});
	});

	it('throws if spaceId is missing', async () => {
		await expect(
			handlers.get('space.sessionGroup.updateMember')!({
				groupId: 'group-1',
				sessionId: 'session-1',
				status: 'completed',
			})
		).rejects.toThrow('spaceId is required');
	});

	it('throws if groupId is missing', async () => {
		await expect(
			handlers.get('space.sessionGroup.updateMember')!({
				spaceId: 'space-1',
				sessionId: 'session-1',
				status: 'completed',
			})
		).rejects.toThrow('groupId is required');
	});

	it('throws if sessionId is missing', async () => {
		await expect(
			handlers.get('space.sessionGroup.updateMember')!({
				spaceId: 'space-1',
				groupId: 'group-1',
				status: 'completed',
			})
		).rejects.toThrow('sessionId is required');
	});

	it('throws if status is missing', async () => {
		await expect(
			handlers.get('space.sessionGroup.updateMember')!({
				spaceId: 'space-1',
				groupId: 'group-1',
				sessionId: 'session-1',
			})
		).rejects.toThrow('status is required');
	});

	it('throws if status is not a valid enum value', async () => {
		await expect(
			handlers.get('space.sessionGroup.updateMember')!({
				spaceId: 'space-1',
				groupId: 'group-1',
				sessionId: 'session-1',
				status: 'bogus',
			})
		).rejects.toThrow('Invalid status: must be one of active, completed, failed');
	});

	it('throws if space not found', async () => {
		spaceManager = createMockSpaceManager(null);
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		await expect(
			h.get('space.sessionGroup.updateMember')!({
				spaceId: 'bad-space',
				groupId: 'group-1',
				sessionId: 'session-1',
				status: 'completed',
			})
		).rejects.toThrow('Space not found: bad-space');
	});

	it('throws if group not found', async () => {
		repo = createMockRepo({ getGroup: mock(() => null) });
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		await expect(
			h.get('space.sessionGroup.updateMember')!({
				spaceId: 'space-1',
				groupId: 'bad-group',
				sessionId: 'session-1',
				status: 'completed',
			})
		).rejects.toThrow('Session group not found: bad-group');
	});

	it('throws if group belongs to a different space', async () => {
		repo = createMockRepo({
			getGroup: mock(() => ({ ...mockGroup, spaceId: 'other-space' })),
		});
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		await expect(
			h.get('space.sessionGroup.updateMember')!({
				spaceId: 'space-1',
				groupId: 'group-1',
				sessionId: 'session-1',
				status: 'completed',
			})
		).rejects.toThrow('does not belong to space space-1');
	});

	it('throws if member not found in group', async () => {
		repo = createMockRepo({ updateMember: mock(() => null) });
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		await expect(
			h.get('space.sessionGroup.updateMember')!({
				spaceId: 'space-1',
				groupId: 'group-1',
				sessionId: 'missing-session',
				status: 'completed',
			})
		).rejects.toThrow('Member session missing-session not found in group group-1');
	});
});

describe('space.sessionGroup.delete', () => {
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let spaceManager: SpaceManager;
	let repo: SpaceSessionGroupRepository;

	beforeEach(() => {
		const { hub, handlers: h } = createMockMessageHub();
		handlers = h;
		daemonHub = createMockDaemonHub();
		spaceManager = createMockSpaceManager();
		repo = createMockRepo();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
	});

	it('deletes the group and returns deleted: true', async () => {
		const result = await handlers.get('space.sessionGroup.delete')!({
			spaceId: 'space-1',
			groupId: 'group-1',
		});
		expect(result).toEqual({ deleted: true });
		expect(repo.deleteGroup).toHaveBeenCalledWith('group-1');
	});

	it('returns deleted: false if repo returns false', async () => {
		repo = createMockRepo({ deleteGroup: mock(() => false) });
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		const result = await h.get('space.sessionGroup.delete')!({
			spaceId: 'space-1',
			groupId: 'group-1',
		});
		expect(result).toEqual({ deleted: false });
	});

	it('throws if spaceId is missing', async () => {
		await expect(
			handlers.get('space.sessionGroup.delete')!({ groupId: 'group-1' })
		).rejects.toThrow('spaceId is required');
	});

	it('throws if groupId is missing', async () => {
		await expect(
			handlers.get('space.sessionGroup.delete')!({ spaceId: 'space-1' })
		).rejects.toThrow('groupId is required');
	});

	it('throws if space not found', async () => {
		spaceManager = createMockSpaceManager(null);
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		await expect(
			h.get('space.sessionGroup.delete')!({ spaceId: 'bad-space', groupId: 'group-1' })
		).rejects.toThrow('Space not found: bad-space');
	});

	it('throws if group not found', async () => {
		repo = createMockRepo({ getGroup: mock(() => null) });
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		await expect(
			h.get('space.sessionGroup.delete')!({ spaceId: 'space-1', groupId: 'bad-group' })
		).rejects.toThrow('Session group not found: bad-group');
	});

	it('throws if group belongs to a different space', async () => {
		repo = createMockRepo({
			getGroup: mock(() => ({ ...mockGroup, spaceId: 'other-space' })),
		});
		const { hub, handlers: h } = createMockMessageHub();
		setupSpaceSessionGroupHandlers(hub, daemonHub, spaceManager, repo);
		await expect(
			h.get('space.sessionGroup.delete')!({ spaceId: 'space-1', groupId: 'group-1' })
		).rejects.toThrow('does not belong to space space-1');
	});

	it('emits spaceSessionGroup.deleted event on successful delete', async () => {
		await handlers.get('space.sessionGroup.delete')!({
			spaceId: 'space-1',
			groupId: 'group-1',
		});
		expect(daemonHub.emit).toHaveBeenCalledWith('spaceSessionGroup.deleted', {
			sessionId: 'space:space-1',
			spaceId: 'space-1',
			groupId: 'group-1',
		});
	});

	it('does not emit spaceSessionGroup.deleted when repo returns false', async () => {
		repo = createMockRepo({ deleteGroup: mock(() => false) });
		const { hub, handlers: h } = createMockMessageHub();
		const localDaemonHub = createMockDaemonHub();
		setupSpaceSessionGroupHandlers(hub, localDaemonHub, spaceManager, repo);
		await h.get('space.sessionGroup.delete')!({ spaceId: 'space-1', groupId: 'group-1' });
		expect(localDaemonHub.emit).not.toHaveBeenCalled();
	});
});
