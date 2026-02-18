/**
 * GitHub RPC Handlers
 *
 * RPC handlers for GitHub integration operations:
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

import type {
	MessageHub,
	RepositoryMapping,
	InboxItemStatus,
	GitHubFilterConfig,
	RoomGitHubMapping,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { GitHubService } from '../github/github-service';
import type { RoomManager } from '../room/room-manager';

export function setupGitHubHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	db: Database,
	roomManager: RoomManager,
	gitHubService: GitHubService | null
): void {
	// Helper to check if GitHub service is available
	const requireGitHubService = (): GitHubService => {
		if (!gitHubService) {
			throw new Error(
				'GitHub integration is not configured. Set GITHUB_WEBHOOK_SECRET or GITHUB_POLLING_INTERVAL to enable.'
			);
		}
		return gitHubService;
	};

	// github.configureRoom - Link room to GitHub repos
	messageHub.onRequest('github.configureRoom', async (data) => {
		const params = data as {
			roomId: string;
			repositories: RepositoryMapping[];
			priority?: number;
		};

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		if (!params.repositories || params.repositories.length === 0) {
			throw new Error('At least one repository is required');
		}

		// Verify room exists
		const room = roomManager.getRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// Check if mapping already exists for this room
		const existingMapping = db.getGitHubMappingByRoomId(params.roomId);

		let mapping: RoomGitHubMapping;
		if (existingMapping) {
			// Update existing mapping
			mapping = db.updateGitHubMapping(existingMapping.id, {
				repositories: params.repositories,
				priority: params.priority,
			})!;
		} else {
			// Create new mapping
			mapping = db.createGitHubMapping({
				roomId: params.roomId,
				repositories: params.repositories,
				priority: params.priority,
			});
		}

		// Add repositories to polling if service is available
		if (gitHubService) {
			for (const repo of params.repositories) {
				gitHubService.addRepository(repo.owner, repo.repo);
			}
		}

		// Emit event for state sync
		daemonHub
			.emit('github.roomMappingUpdated', {
				sessionId: 'global',
				roomId: params.roomId,
				mapping,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		return { mapping };
	});

	// github.getRoomMapping - Get room's GitHub config
	messageHub.onRequest('github.getRoomMapping', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const mapping = db.getGitHubMappingByRoomId(params.roomId);

		return { mapping };
	});

	// github.deleteRoomMapping - Remove room's GitHub config
	messageHub.onRequest('github.deleteRoomMapping', async (data) => {
		const params = data as { roomId: string };

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		const existingMapping = db.getGitHubMappingByRoomId(params.roomId);
		if (!existingMapping) {
			throw new Error(`No GitHub mapping found for room: ${params.roomId}`);
		}

		db.deleteGitHubMappingByRoomId(params.roomId);

		// Emit event for state sync
		daemonHub
			.emit('github.roomMappingDeleted', {
				sessionId: 'global',
				roomId: params.roomId,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		return { success: true };
	});

	// github.getInbox - List pending inbox items
	messageHub.onRequest('github.getInbox', async (data) => {
		const params = data as {
			status?: InboxItemStatus;
			repository?: string;
			limit?: number;
		};

		const items = db.listInboxItems({
			status: params.status,
			repository: params.repository,
			limit: params.limit,
		});

		return { items };
	});

	// github.getInboxItem - Get single inbox item
	messageHub.onRequest('github.getInboxItem', async (data) => {
		const params = data as { id: string };

		if (!params.id) {
			throw new Error('Item ID is required');
		}

		const item = db.getInboxItem(params.id);

		if (!item) {
			throw new Error(`Inbox item not found: ${params.id}`);
		}

		return { item };
	});

	// github.routeItem - Manually route inbox item to room
	messageHub.onRequest('github.routeItem', async (data) => {
		const params = data as { itemId: string; roomId: string };

		if (!params.itemId) {
			throw new Error('Item ID is required');
		}

		if (!params.roomId) {
			throw new Error('Room ID is required');
		}

		// Verify room exists
		const room = roomManager.getRoom(params.roomId);
		if (!room) {
			throw new Error(`Room not found: ${params.roomId}`);
		}

		// Verify item exists
		const item = db.getInboxItem(params.itemId);
		if (!item) {
			throw new Error(`Inbox item not found: ${params.itemId}`);
		}

		// Update item status and route to room
		const updatedItem = db.routeInboxItem(params.itemId, params.roomId);

		if (!updatedItem) {
			throw new Error(`Failed to route inbox item: ${params.itemId}`);
		}

		// Emit event for state sync and room notification
		daemonHub
			.emit('github.inboxItemRouted', {
				sessionId: 'global',
				item: updatedItem,
				roomId: params.roomId,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		// Also emit to the specific room channel
		daemonHub
			.emit('room.message', {
				sessionId: `room:${params.roomId}`,
				roomId: params.roomId,
				message: {
					id: `inbox-route-${params.itemId}`,
					role: 'github_routing',
					content: `Manually routed GitHub item from ${updatedItem.repository}#${updatedItem.issueNumber}: ${updatedItem.title}`,
					timestamp: Date.now(),
				},
				sender: 'system',
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		return { success: true, item: updatedItem };
	});

	// github.dismissItem - Dismiss inbox item
	messageHub.onRequest('github.dismissItem', async (data) => {
		const params = data as { itemId: string };

		if (!params.itemId) {
			throw new Error('Item ID is required');
		}

		// Verify item exists
		const item = db.getInboxItem(params.itemId);
		if (!item) {
			throw new Error(`Inbox item not found: ${params.itemId}`);
		}

		// Dismiss the item
		const updatedItem = db.dismissInboxItem(params.itemId);

		if (!updatedItem) {
			throw new Error(`Failed to dismiss inbox item: ${params.itemId}`);
		}

		// Emit event for state sync
		daemonHub
			.emit('github.inboxItemDismissed', {
				sessionId: 'global',
				itemId: params.itemId,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		return { success: true };
	});

	// github.getFilterConfig - Get filter settings
	messageHub.onRequest('github.getFilterConfig', async (data) => {
		const params = data as { repository?: string };

		const service = requireGitHubService();
		const filterConfigManager = service.getFilterConfigManager();

		let config: GitHubFilterConfig;
		if (params.repository) {
			config = filterConfigManager.getFilterForRepository(params.repository);
		} else {
			config = filterConfigManager.getGlobalFilter();
		}

		return { config };
	});

	// github.updateFilterConfig - Update filter settings
	messageHub.onRequest('github.updateFilterConfig', async (data) => {
		const params = data as {
			repository?: string;
			config: Partial<GitHubFilterConfig>;
		};

		if (!params.config) {
			throw new Error('Filter config is required');
		}

		const service = requireGitHubService();
		const filterConfigManager = service.getFilterConfigManager();
		let config: GitHubFilterConfig;
		if (params.repository) {
			filterConfigManager.setRepositoryFilter(params.repository, params.config);
			config = filterConfigManager.getFilterForRepository(params.repository);
		} else {
			filterConfigManager.updateGlobalFilter(params.config);
			config = filterConfigManager.getGlobalFilter();
		}

		// Emit event for state sync
		daemonHub
			.emit('github.filterConfigUpdated', {
				sessionId: 'global',
				repository: params.repository,
				config,
			})
			.catch(() => {
				// Event emission error - non-critical, continue
			});

		return { config };
	});

	// github.getRoomMappings - List all room-GitHub mappings
	messageHub.onRequest('github.getRoomMappings', async () => {
		const mappings = db.listGitHubMappings();

		return { mappings };
	});

	// github.getStatus - Get GitHub integration status
	messageHub.onRequest('github.getStatus', async () => {
		// Count inbox items by status
		const inboxCounts: Record<InboxItemStatus, number> = {
			pending: db.countInboxItemsByStatus('pending'),
			routed: db.countInboxItemsByStatus('routed'),
			dismissed: db.countInboxItemsByStatus('dismissed'),
			blocked: db.countInboxItemsByStatus('blocked'),
		};

		// Get configured repositories from mappings
		const mappings = db.listGitHubMappings();
		const repositories = new Set<string>();
		for (const mapping of mappings) {
			for (const repo of mapping.repositories) {
				repositories.add(`${repo.owner}/${repo.repo}`);
			}
		}

		// Get polled repositories if service is available
		if (gitHubService) {
			const polledRepos = gitHubService.getPolledRepositories();
			for (const repo of polledRepos) {
				repositories.add(`${repo.owner}/${repo.repo}`);
			}
		}

		return {
			enabled: !!gitHubService,
			webhookEnabled: gitHubService?.hasWebhookHandler() ?? false,
			pollingEnabled: gitHubService?.isPolling() ?? false,
			pollingInterval: gitHubService?.isPolling() ? 60 : 0, // TODO: Get actual interval from config
			repositories: Array.from(repositories),
			inboxCounts,
		};
	});
}
