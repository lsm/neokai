/**
 * Tests for GitHub RPC Handlers
 *
 * Tests the RPC handlers for GitHub integration operations:
 * - github.configureRoom - Link room to GitHub repos
 * - github.getRoomMapping - Get room's GitHub config
 * - github.deleteRoomMapping - Remove room's GitHub config
 * - github.getInbox - List pending inbox items
 * - github.getInboxItem - Get single inbox item
 * - github.routeItem - Manually route inbox item to room
 * - github.dismissItem - Dismiss inbox item
 * - github.getFilterConfig - Get filter settings
 * - github.updateFilterConfig - Update filter settings
 * - github.getRoomMappings - List all room-GitHub mappings
 * - github.getStatus - Get GitHub integration status
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type RoomGitHubMapping, type InboxItem } from '@neokai/shared';
import { setupGitHubHandlers } from '../../../src/lib/rpc-handlers/github-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { GitHubService } from '../../../src/lib/github/github-service';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Factory function to create a mock GitHub mapping
function createMockGitHubMapping(overrides: Partial<RoomGitHubMapping> = {}): RoomGitHubMapping {
	return {
		id: 'mapping-123',
		roomId: 'room-123',
		repositories: [{ owner: 'test-owner', repo: 'test-repo' }],
		priority: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

// Factory function to create a mock inbox item
function createMockInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
	return {
		id: 'item-123',
		eventId: 'event-123',
		eventType: 'issues',
		action: 'opened',
		repository: 'test-owner/test-repo',
		issueNumber: 42,
		title: 'Test Issue',
		status: 'pending',
		securityFlags: { injectionRisk: 'none' },
		createdAt: Date.now(),
		...overrides,
	};
}

// Mock Database methods
const mockDb = {
	getGitHubMappingByRoomId: mock(() => null as RoomGitHubMapping | null),
	createGitHubMapping: mock(() => createMockGitHubMapping()),
	updateGitHubMapping: mock(() => createMockGitHubMapping() as RoomGitHubMapping | null),
	deleteGitHubMappingByRoomId: mock(() => {}),
	getInboxItem: mock(() => createMockInboxItem() as InboxItem | null),
	listInboxItems: mock(() => [] as InboxItem[]),
	routeInboxItem: mock(
		() => createMockInboxItem({ status: 'routed', routedToRoomId: 'room-456' }) as InboxItem | null
	),
	dismissInboxItem: mock(() => createMockInboxItem({ status: 'dismissed' }) as InboxItem | null),
	listGitHubMappings: mock(() => [] as RoomGitHubMapping[]),
	countInboxItemsByStatus: mock(() => 0),
};

// Mock RoomManager
const mockRoomManager = {
	getRoom: mock(() => ({ id: 'room-123', name: 'Test Room' })),
};

// Mock GitHubService
const mockFilterConfigManager = {
	getGlobalFilter: mock(() => ({
		repositories: [],
		events: { issues: ['opened'], issue_comment: ['created'], pull_request: ['opened'] },
		authors: { mode: 'all' },
		labels: { mode: 'any' },
	})),
	getFilterForRepository: mock(() => ({
		repositories: [],
		events: { issues: ['opened'], issue_comment: ['created'], pull_request: ['opened'] },
		authors: { mode: 'all' },
		labels: { mode: 'any' },
	})),
	updateGlobalFilter: mock(() => {}),
	setRepositoryFilter: mock(() => {}),
};

const mockGitHubService = {
	addRepository: mock(() => {}),
	getPolledRepositories: mock(() => [] as Array<{ owner: string; repo: string }>),
	getFilterConfigManager: mock(() => mockFilterConfigManager),
	hasWebhookHandler: mock(() => false),
	isPolling: mock(() => false),
};

// Helper to create a minimal mock MessageHub that captures handlers
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

// Helper to create mock DaemonHub
function createMockDaemonHub(): {
	daemonHub: DaemonHub;
	emit: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emit: emitMock };
}

describe('GitHub RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;

	beforeEach(() => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();

		// Reset all mocks
		mockDb.getGitHubMappingByRoomId.mockClear();
		mockDb.createGitHubMapping.mockClear();
		mockDb.updateGitHubMapping.mockClear();
		mockDb.deleteGitHubMappingByRoomId.mockClear();
		mockDb.getInboxItem.mockClear();
		mockDb.listInboxItems.mockClear();
		mockDb.routeInboxItem.mockClear();
		mockDb.dismissInboxItem.mockClear();
		mockDb.listGitHubMappings.mockClear();
		mockDb.countInboxItemsByStatus.mockClear();

		mockRoomManager.getRoom.mockClear();
		mockGitHubService.addRepository.mockClear();
		mockGitHubService.getPolledRepositories.mockClear();

		// Setup handlers with mocked dependencies
		setupGitHubHandlers(
			messageHubData.hub,
			daemonHubData.daemonHub,
			mockDb as unknown as Database,
			mockRoomManager as unknown as RoomManager,
			mockGitHubService as unknown as GitHubService
		);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('github.configureRoom', () => {
		it('creates a new room mapping', async () => {
			const handler = messageHubData.handlers.get('github.configureRoom');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(null);

			const params = {
				roomId: 'room-123',
				repositories: [{ owner: 'test-owner', repo: 'test-repo' }],
			};

			const result = (await handler!(params, {})) as { mapping: RoomGitHubMapping };

			expect(mockDb.createGitHubMapping).toHaveBeenCalled();
			expect(result.mapping).toBeDefined();
			expect(result.mapping.roomId).toBe('room-123');
		});

		it('updates an existing room mapping', async () => {
			const handler = messageHubData.handlers.get('github.configureRoom');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(createMockGitHubMapping());

			const params = {
				roomId: 'room-123',
				repositories: [{ owner: 'new-owner', repo: 'new-repo' }],
			};

			const result = (await handler!(params, {})) as { mapping: RoomGitHubMapping };

			expect(mockDb.updateGitHubMapping).toHaveBeenCalled();
			expect(result.mapping).toBeDefined();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('github.configureRoom');
			expect(handler).toBeDefined();

			const params = {
				repositories: [{ owner: 'test-owner', repo: 'test-repo' }],
			};

			await expect(handler!(params, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when repositories is empty', async () => {
			const handler = messageHubData.handlers.get('github.configureRoom');
			expect(handler).toBeDefined();

			const params = {
				roomId: 'room-123',
				repositories: [],
			};

			await expect(handler!(params, {})).rejects.toThrow('At least one repository is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('github.configureRoom');
			expect(handler).toBeDefined();

			mockRoomManager.getRoom.mockReturnValueOnce(null);

			const params = {
				roomId: 'non-existent-room',
				repositories: [{ owner: 'test-owner', repo: 'test-repo' }],
			};

			await expect(handler!(params, {})).rejects.toThrow('Room not found');
		});

		it('adds repositories to polling service', async () => {
			const handler = messageHubData.handlers.get('github.configureRoom');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(null);

			const params = {
				roomId: 'room-123',
				repositories: [
					{ owner: 'owner1', repo: 'repo1' },
					{ owner: 'owner2', repo: 'repo2' },
				],
			};

			await handler!(params, {});

			expect(mockGitHubService.addRepository).toHaveBeenCalledTimes(2);
		});

		it('emits github.roomMappingUpdated event', async () => {
			const handler = messageHubData.handlers.get('github.configureRoom');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(null);

			await handler!(
				{ roomId: 'room-123', repositories: [{ owner: 'test-owner', repo: 'test-repo' }] },
				{}
			);

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'github.roomMappingUpdated',
				expect.objectContaining({
					sessionId: 'global',
					roomId: 'room-123',
				})
			);
		});
	});

	describe('github.getRoomMapping', () => {
		it('returns mapping for room', async () => {
			const handler = messageHubData.handlers.get('github.getRoomMapping');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(createMockGitHubMapping());

			const params = { roomId: 'room-123' };
			const result = (await handler!(params, {})) as { mapping: RoomGitHubMapping | null };

			expect(mockDb.getGitHubMappingByRoomId).toHaveBeenCalledWith('room-123');
			expect(result.mapping).toBeDefined();
		});

		it('returns null when no mapping exists', async () => {
			const handler = messageHubData.handlers.get('github.getRoomMapping');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(null);

			const params = { roomId: 'room-123' };
			const result = (await handler!(params, {})) as { mapping: RoomGitHubMapping | null };

			expect(result.mapping).toBeNull();
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('github.getRoomMapping');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});
	});

	describe('github.deleteRoomMapping', () => {
		it('deletes existing mapping', async () => {
			const handler = messageHubData.handlers.get('github.deleteRoomMapping');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(createMockGitHubMapping());

			const params = { roomId: 'room-123' };
			const result = (await handler!(params, {})) as { success: boolean };

			expect(mockDb.deleteGitHubMappingByRoomId).toHaveBeenCalledWith('room-123');
			expect(result.success).toBe(true);
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('github.deleteRoomMapping');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when no mapping exists', async () => {
			const handler = messageHubData.handlers.get('github.deleteRoomMapping');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(null);

			await expect(handler!({ roomId: 'room-123' }, {})).rejects.toThrow(
				'No GitHub mapping found for room'
			);
		});

		it('emits github.roomMappingDeleted event', async () => {
			const handler = messageHubData.handlers.get('github.deleteRoomMapping');
			expect(handler).toBeDefined();

			mockDb.getGitHubMappingByRoomId.mockReturnValueOnce(createMockGitHubMapping());

			await handler!({ roomId: 'room-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'github.roomMappingDeleted',
				expect.objectContaining({
					sessionId: 'global',
					roomId: 'room-123',
				})
			);
		});
	});

	describe('github.getInbox', () => {
		it('lists all inbox items', async () => {
			const handler = messageHubData.handlers.get('github.getInbox');
			expect(handler).toBeDefined();

			mockDb.listInboxItems.mockReturnValueOnce([
				createMockInboxItem({ id: 'item-1' }),
				createMockInboxItem({ id: 'item-2' }),
			]);

			const result = (await handler!({}, {})) as { items: InboxItem[] };

			expect(mockDb.listInboxItems).toHaveBeenCalled();
			expect(result.items).toHaveLength(2);
		});

		it('filters by status', async () => {
			const handler = messageHubData.handlers.get('github.getInbox');
			expect(handler).toBeDefined();

			const params = { status: 'pending' };
			await handler!(params, {});

			expect(mockDb.listInboxItems).toHaveBeenCalledWith(
				expect.objectContaining({ status: 'pending' })
			);
		});

		it('filters by repository', async () => {
			const handler = messageHubData.handlers.get('github.getInbox');
			expect(handler).toBeDefined();

			const params = { repository: 'owner/repo' };
			await handler!(params, {});

			expect(mockDb.listInboxItems).toHaveBeenCalledWith(
				expect.objectContaining({ repository: 'owner/repo' })
			);
		});

		it('respects limit parameter', async () => {
			const handler = messageHubData.handlers.get('github.getInbox');
			expect(handler).toBeDefined();

			const params = { limit: 10 };
			await handler!(params, {});

			expect(mockDb.listInboxItems).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
		});
	});

	describe('github.getInboxItem', () => {
		it('returns item by id', async () => {
			const handler = messageHubData.handlers.get('github.getInboxItem');
			expect(handler).toBeDefined();

			mockDb.getInboxItem.mockReturnValueOnce(createMockInboxItem({ id: 'item-123' }));

			const params = { id: 'item-123' };
			const result = (await handler!(params, {})) as { item: InboxItem };

			expect(mockDb.getInboxItem).toHaveBeenCalledWith('item-123');
			expect(result.item.id).toBe('item-123');
		});

		it('throws error when id is missing', async () => {
			const handler = messageHubData.handlers.get('github.getInboxItem');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Item ID is required');
		});

		it('throws error when item not found', async () => {
			const handler = messageHubData.handlers.get('github.getInboxItem');
			expect(handler).toBeDefined();

			mockDb.getInboxItem.mockReturnValueOnce(null);

			await expect(handler!({ id: 'non-existent' }, {})).rejects.toThrow('Inbox item not found');
		});
	});

	describe('github.routeItem', () => {
		it('routes item to room', async () => {
			const handler = messageHubData.handlers.get('github.routeItem');
			expect(handler).toBeDefined();

			mockDb.getInboxItem.mockReturnValueOnce(createMockInboxItem());
			mockDb.routeInboxItem.mockReturnValueOnce(
				createMockInboxItem({ status: 'routed', routedToRoomId: 'room-456' })
			);

			const params = { itemId: 'item-123', roomId: 'room-456' };
			const result = (await handler!(params, {})) as { success: boolean; item: InboxItem };

			expect(mockDb.routeInboxItem).toHaveBeenCalledWith('item-123', 'room-456');
			expect(result.success).toBe(true);
			expect(result.item.status).toBe('routed');
		});

		it('throws error when itemId is missing', async () => {
			const handler = messageHubData.handlers.get('github.routeItem');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-456' }, {})).rejects.toThrow('Item ID is required');
		});

		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('github.routeItem');
			expect(handler).toBeDefined();

			await expect(handler!({ itemId: 'item-123' }, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when room not found', async () => {
			const handler = messageHubData.handlers.get('github.routeItem');
			expect(handler).toBeDefined();

			mockRoomManager.getRoom.mockReturnValueOnce(null);

			await expect(handler!({ itemId: 'item-123', roomId: 'non-existent' }, {})).rejects.toThrow(
				'Room not found'
			);
		});

		it('throws error when item not found', async () => {
			const handler = messageHubData.handlers.get('github.routeItem');
			expect(handler).toBeDefined();

			mockDb.getInboxItem.mockReturnValueOnce(null);

			await expect(handler!({ itemId: 'non-existent', roomId: 'room-456' }, {})).rejects.toThrow(
				'Inbox item not found'
			);
		});

		it('emits github.inboxItemRouted event', async () => {
			const handler = messageHubData.handlers.get('github.routeItem');
			expect(handler).toBeDefined();

			mockDb.getInboxItem.mockReturnValueOnce(createMockInboxItem());
			mockDb.routeInboxItem.mockReturnValueOnce(
				createMockInboxItem({ status: 'routed', routedToRoomId: 'room-456' })
			);

			await handler!({ itemId: 'item-123', roomId: 'room-456' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'github.inboxItemRouted',
				expect.objectContaining({
					sessionId: 'global',
					roomId: 'room-456',
				})
			);
		});
	});

	describe('github.dismissItem', () => {
		it('dismisses item', async () => {
			const handler = messageHubData.handlers.get('github.dismissItem');
			expect(handler).toBeDefined();

			mockDb.getInboxItem.mockReturnValueOnce(createMockInboxItem());
			mockDb.dismissInboxItem.mockReturnValueOnce(createMockInboxItem({ status: 'dismissed' }));

			const params = { itemId: 'item-123' };
			const result = (await handler!(params, {})) as { success: boolean };

			expect(mockDb.dismissInboxItem).toHaveBeenCalledWith('item-123');
			expect(result.success).toBe(true);
		});

		it('throws error when itemId is missing', async () => {
			const handler = messageHubData.handlers.get('github.dismissItem');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Item ID is required');
		});

		it('throws error when item not found', async () => {
			const handler = messageHubData.handlers.get('github.dismissItem');
			expect(handler).toBeDefined();

			mockDb.getInboxItem.mockReturnValueOnce(null);

			await expect(handler!({ itemId: 'non-existent' }, {})).rejects.toThrow(
				'Inbox item not found'
			);
		});

		it('emits github.inboxItemDismissed event', async () => {
			const handler = messageHubData.handlers.get('github.dismissItem');
			expect(handler).toBeDefined();

			mockDb.getInboxItem.mockReturnValueOnce(createMockInboxItem());
			mockDb.dismissInboxItem.mockReturnValueOnce(createMockInboxItem({ status: 'dismissed' }));

			await handler!({ itemId: 'item-123' }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'github.inboxItemDismissed',
				expect.objectContaining({
					sessionId: 'global',
					itemId: 'item-123',
				})
			);
		});
	});

	describe('github.getFilterConfig', () => {
		it('returns global filter config', async () => {
			const handler = messageHubData.handlers.get('github.getFilterConfig');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as { config: unknown };

			expect(mockFilterConfigManager.getGlobalFilter).toHaveBeenCalled();
			expect(result.config).toBeDefined();
		});

		it('returns repository-specific filter config', async () => {
			const handler = messageHubData.handlers.get('github.getFilterConfig');
			expect(handler).toBeDefined();

			const params = { repository: 'owner/repo' };
			await handler!(params, {});

			expect(mockFilterConfigManager.getFilterForRepository).toHaveBeenCalledWith('owner/repo');
		});
	});

	describe('github.updateFilterConfig', () => {
		it('updates global filter config', async () => {
			const handler = messageHubData.handlers.get('github.updateFilterConfig');
			expect(handler).toBeDefined();

			const params = {
				config: { authors: { mode: 'allowlist' as const, users: ['user1'] } },
			};

			const result = (await handler!(params, {})) as { config: unknown };

			expect(mockFilterConfigManager.updateGlobalFilter).toHaveBeenCalled();
			expect(result.config).toBeDefined();
		});

		it('updates repository-specific filter config', async () => {
			const handler = messageHubData.handlers.get('github.updateFilterConfig');
			expect(handler).toBeDefined();

			const params = {
				repository: 'owner/repo',
				config: { authors: { mode: 'blocklist' as const, users: ['user1'] } },
			};

			await handler!(params, {});

			expect(mockFilterConfigManager.setRepositoryFilter).toHaveBeenCalledWith(
				'owner/repo',
				expect.any(Object)
			);
		});

		it('throws error when config is missing', async () => {
			const handler = messageHubData.handlers.get('github.updateFilterConfig');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Filter config is required');
		});

		it('emits github.filterConfigUpdated event', async () => {
			const handler = messageHubData.handlers.get('github.updateFilterConfig');
			expect(handler).toBeDefined();

			await handler!({ config: { authors: { mode: 'all' } } }, {});

			expect(daemonHubData.emit).toHaveBeenCalledWith(
				'github.filterConfigUpdated',
				expect.objectContaining({
					sessionId: 'global',
				})
			);
		});
	});

	describe('github.getRoomMappings', () => {
		it('returns all room mappings', async () => {
			const handler = messageHubData.handlers.get('github.getRoomMappings');
			expect(handler).toBeDefined();

			mockDb.listGitHubMappings.mockReturnValueOnce([
				createMockGitHubMapping({ id: 'mapping-1' }),
				createMockGitHubMapping({ id: 'mapping-2' }),
			]);

			const result = (await handler!({}, {})) as { mappings: RoomGitHubMapping[] };

			expect(mockDb.listGitHubMappings).toHaveBeenCalled();
			expect(result.mappings).toHaveLength(2);
		});
	});

	describe('github.getStatus', () => {
		it('returns integration status', async () => {
			const handler = messageHubData.handlers.get('github.getStatus');
			expect(handler).toBeDefined();

			mockDb.listGitHubMappings.mockReturnValueOnce([]);
			mockDb.countInboxItemsByStatus.mockReturnValue(5);

			const result = (await handler!({}, {})) as {
				enabled: boolean;
				inboxCounts: Record<string, number>;
			};

			expect(result.enabled).toBe(true);
			expect(result.inboxCounts).toBeDefined();
		});

		it('includes configured repositories', async () => {
			const handler = messageHubData.handlers.get('github.getStatus');
			expect(handler).toBeDefined();

			mockDb.listGitHubMappings.mockReturnValueOnce([
				createMockGitHubMapping({
					repositories: [{ owner: 'owner1', repo: 'repo1' }],
				}),
			]);

			const result = (await handler!({}, {})) as { repositories: string[] };

			expect(result.repositories).toContain('owner1/repo1');
		});

		it('includes polled repositories', async () => {
			const handler = messageHubData.handlers.get('github.getStatus');
			expect(handler).toBeDefined();

			mockDb.listGitHubMappings.mockReturnValueOnce([]);
			mockGitHubService.getPolledRepositories.mockReturnValueOnce([
				{ owner: 'owner2', repo: 'repo2' },
			]);

			const result = (await handler!({}, {})) as { repositories: string[] };

			expect(result.repositories).toContain('owner2/repo2');
		});
	});
});
