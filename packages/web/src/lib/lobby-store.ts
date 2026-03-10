/**
 * LobbyStore - Lobby state management with WebSocket subscriptions
 *
 * ARCHITECTURE: Pure WebSocket (no REST API)
 * - Initial state: Fetched via RPC over WebSocket on lobby mount
 * - Updates: Real-time via room event subscriptions
 * - Single subscription source for lobby data
 *
 * Signals (reactive state):
 * - rooms: List of rooms
 * - globalStatus: Global Neo status across all rooms
 * - loading: Loading state
 * - error: Error state
 */

import { signal, computed } from '@preact/signals';
import type { Room, GlobalStatus, CreateRoomParams } from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';
import { toast } from './toast';

const logger = new Logger('kai:web:lobbystore');

class LobbyStore {
	// ========================================
	// Core Signals
	// ========================================

	/** List of rooms */
	readonly rooms = signal<Room[]>([]);

	/** Global Neo status across all rooms */
	readonly globalStatus = signal<GlobalStatus | null>(null);

	/** Loading state */
	readonly loading = signal<boolean>(false);

	/** Error state */
	readonly error = signal<string | null>(null);

	// ========================================
	// Computed Accessors
	// ========================================

	/** Total room count */
	readonly roomCount = computed(() => this.rooms.value.length);

	/** Active room count */
	readonly activeRoomCount = computed(
		() => this.rooms.value.filter((r) => r.status === 'active').length
	);

	/** Archived room count */
	readonly archivedRoomCount = computed(
		() => this.rooms.value.filter((r) => r.status === 'archived').length
	);

	/** Total sessions across all rooms */
	readonly totalSessionCount = computed(() =>
		this.rooms.value.reduce((sum, r) => sum + r.sessionIds.length, 0)
	);

	// ========================================
	// Private State
	// ========================================

	/** Subscription cleanup functions */
	private cleanupFunctions: Array<() => void> = [];

	/** Whether initialized */
	private initialized = false;

	/** Promise-chain lock for atomic initialization */
	private initPromise: Promise<void> = Promise.resolve();

	// ========================================
	// Initialization
	// ========================================

	/**
	 * Initialize the lobby store
	 * Fetches initial data and sets up subscriptions
	 */
	async initialize(): Promise<void> {
		// Already initialized - return immediately
		if (this.initialized) {
			return;
		}

		// Chain onto existing init promise to prevent races
		this.initPromise = this.initPromise.then(() => this.doInitialize());
		return this.initPromise;
	}

	/**
	 * Internal initialization logic (called via promise-chain lock)
	 */
	private async doInitialize(): Promise<void> {
		// Double-check after acquiring lock
		if (this.initialized) {
			return;
		}

		try {
			await this.fetchRooms();
			await this.startSubscriptions();
			this.initialized = true;
		} catch (err) {
			logger.error('Failed to initialize lobby store:', err);
			this.error.value = err instanceof Error ? err.message : 'Failed to initialize';
		}
	}

	/**
	 * Fetch rooms and global status
	 * Waits for WebSocket connection before fetching
	 */
	async fetchRooms(): Promise<void> {
		try {
			this.loading.value = true;
			// Wait for connection instead of returning early
			const hub = await connectionManager.getHub();

			const { rooms } = await hub.request<{ rooms: Room[] }>('room.list', {});
			this.rooms.value = rooms;

			// Fetch global status
			const { status } = await hub.request<{ status: GlobalStatus }>('neo.status', {});
			this.globalStatus.value = status;
		} catch (err) {
			logger.error('Failed to fetch rooms:', err);
			this.error.value = err instanceof Error ? err.message : 'Failed to load';
		} finally {
			this.loading.value = false;
		}
	}

	/**
	 * Start subscriptions for real-time updates
	 */
	private async startSubscriptions(): Promise<void> {
		try {
			const hub = await connectionManager.getHub();

			// Subscribe to room creation events
			const unsubRoomCreated = hub.onEvent<{ room: Room }>('room.created', (data) => {
				// Check if room already exists (idempotent)
				const exists = this.rooms.value.some((r) => r.id === data.room.id);
				if (!exists) {
					this.rooms.value = [...this.rooms.value, data.room];
				}
			});
			this.cleanupFunctions.push(unsubRoomCreated);

			// Subscribe to room update events
			const unsubRoomUpdated = hub.onEvent<{ room: Room }>('room.updated', (data) => {
				const idx = this.rooms.value.findIndex((r) => r.id === data.room.id);
				if (idx >= 0) {
					this.rooms.value = [
						...this.rooms.value.slice(0, idx),
						data.room,
						...this.rooms.value.slice(idx + 1),
					];
				}
			});
			this.cleanupFunctions.push(unsubRoomUpdated);

			// Subscribe to room archive events
			const unsubRoomArchived = hub.onEvent<{ roomId: string }>('room.archived', (data) => {
				const idx = this.rooms.value.findIndex((r) => r.id === data.roomId);
				if (idx >= 0) {
					const updatedRoom = { ...this.rooms.value[idx], status: 'archived' as const };
					this.rooms.value = [
						...this.rooms.value.slice(0, idx),
						updatedRoom,
						...this.rooms.value.slice(idx + 1),
					];
				}
			});
			this.cleanupFunctions.push(unsubRoomArchived);

			// Subscribe to room delete events
			const unsubRoomDeleted = hub.onEvent<{ roomId: string }>('room.deleted', (data) => {
				this.rooms.value = this.rooms.value.filter((r) => r.id !== data.roomId);
			});
			this.cleanupFunctions.push(unsubRoomDeleted);
		} catch (err) {
			logger.error('Failed to start lobby subscriptions:', err);
		}
	}

	/**
	 * Stop all subscriptions
	 */
	private stopSubscriptions(): void {
		for (const cleanup of this.cleanupFunctions) {
			try {
				cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		this.cleanupFunctions = [];
	}

	// ========================================
	// Actions
	// ========================================

	/**
	 * Create a new room
	 */
	async createRoom(params: CreateRoomParams): Promise<Room | null> {
		try {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				toast.error('Not connected to server');
				return null;
			}

			const { room } = await hub.request<{ room: Room }>('room.create', params);
			// Add room locally for immediate UX, but dedupe in case subscription already added it
			const exists = this.rooms.value.some((r) => r.id === room.id);
			if (!exists) {
				this.rooms.value = [...this.rooms.value, room];
			}
			return room;
		} catch (err) {
			logger.error('Failed to create room:', err);
			toast.error(err instanceof Error ? err.message : 'Failed to create room');
			return null;
		}
	}

	/**
	 * Refresh lobby state
	 */
	async refresh(): Promise<void> {
		await this.fetchRooms();
	}

	/**
	 * Cleanup (for testing or unmounting)
	 */
	cleanup(): void {
		this.stopSubscriptions();
		this.initialized = false;
		this.rooms.value = [];
		this.globalStatus.value = null;
		this.error.value = null;
	}
}

/** Singleton lobby store instance */
export const lobbyStore = new LobbyStore();
