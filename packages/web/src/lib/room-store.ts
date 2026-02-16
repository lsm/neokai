/**
 * RoomStore - Room state management with WebSocket subscriptions
 *
 * ARCHITECTURE: Pure WebSocket (no REST API)
 * - Initial state: Fetched via RPC over WebSocket on room select
 * - Updates: Real-time via state channel subscriptions
 * - Single subscription source for room data
 * - Promise-chain lock for atomic room switching
 *
 * Signals (reactive state):
 * - roomId: Current room ID
 * - room: Room metadata
 * - tasks: Task list for the room
 * - sessions: Session summaries for the room
 * - neoMessages: Neo context messages
 */

import { signal, computed } from '@preact/signals';
import type {
	Room,
	TaskSummary,
	NeoTask,
	SessionSummary,
	NeoContextMessage,
	RoomOverview,
} from '@neokai/shared';

/**
 * Event payload from backend for room.message
 */
interface RoomMessageEvent {
	sessionId: string;
	roomId: string;
	message: {
		id: string;
		role: string;
		content: string;
		timestamp: number;
	};
	sender?: string;
}
import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';
import { toast } from './toast';

const logger = new Logger('kai:web:roomstore');

class RoomStore {
	// ========================================
	// Core Signals
	// ========================================

	/** Current active room ID */
	readonly roomId = signal<string | null>(null);

	/** Room metadata */
	readonly room = signal<Room | null>(null);

	/** Tasks for this room */
	readonly tasks = signal<TaskSummary[]>([]);

	/** Sessions in this room */
	readonly sessions = signal<SessionSummary[]>([]);

	/** Neo context messages */
	readonly neoMessages = signal<NeoContextMessage[]>([]);

	/** Loading state */
	readonly loading = signal<boolean>(false);

	/** Error state */
	readonly error = signal<string | null>(null);

	// ========================================
	// Computed Accessors
	// ========================================

	/** Total task count */
	readonly taskCount = computed(() => this.tasks.value.length);

	/** Pending tasks */
	readonly pendingTasks = computed(() => this.tasks.value.filter((t) => t.status === 'pending'));

	/** In-progress tasks */
	readonly activeTasks = computed(() => this.tasks.value.filter((t) => t.status === 'in_progress'));

	/** Completed tasks */
	readonly completedTasks = computed(() =>
		this.tasks.value.filter((t) => t.status === 'completed')
	);

	/** Session count */
	readonly sessionCount = computed(() => this.sessions.value.length);

	// ========================================
	// Private State
	// ========================================

	/** Promise-chain lock for atomic room switching */
	private selectPromise: Promise<void> = Promise.resolve();

	/** Subscription cleanup functions */
	private cleanupFunctions: Array<() => void> = [];

	// ========================================
	// Room Selection (with Promise-Chain Lock)
	// ========================================

	/**
	 * Select a room with atomic subscription management
	 *
	 * Uses promise-chain locking to prevent race conditions:
	 * - Each select() waits for previous select() to complete
	 * - Unsubscribe -> Update state -> Subscribe happens atomically
	 */
	select(roomId: string | null): Promise<void> {
		// Chain the new selection onto the previous one
		this.selectPromise = this.selectPromise.then(() => this.doSelect(roomId));
		return this.selectPromise;
	}

	/**
	 * Internal selection logic (called within promise chain)
	 */
	private async doSelect(roomId: string | null): Promise<void> {
		// Skip if already on this room
		if (this.roomId.value === roomId) {
			return;
		}

		const oldRoomId = this.roomId.value;

		// 1. Stop current subscriptions and leave old room
		await this.stopSubscriptions();
		if (oldRoomId) {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				hub.leaveChannel(`room:${oldRoomId}`);
			}
		}

		// 2. Clear state
		this.room.value = null;
		this.tasks.value = [];
		this.sessions.value = [];
		this.neoMessages.value = [];
		this.error.value = null;

		// 3. Update active room
		this.roomId.value = roomId;

		// 4. Start new subscriptions if room selected
		if (roomId) {
			this.loading.value = true;
			try {
				await this.startSubscriptions(roomId);
			} catch (err) {
				logger.error('Failed to start room subscriptions:', err);
				this.error.value = err instanceof Error ? err.message : 'Failed to load room';
			} finally {
				this.loading.value = false;
			}
		}
	}

	// ========================================
	// Subscription Management
	// ========================================

	/**
	 * Start subscriptions for a room
	 */
	private async startSubscriptions(roomId: string): Promise<void> {
		try {
			const hub = await connectionManager.getHub();

			// Join the room channel first
			hub.joinChannel(`room:${roomId}`);

			// 1. Room overview subscription (room + sessions + tasks)
			const unsubRoomOverview = hub.onEvent<RoomOverview>('room.overview', (overview) => {
				if (overview.room.id === roomId) {
					this.room.value = overview.room;
					this.sessions.value = overview.sessions;
					this.tasks.value = overview.activeTasks;
				}
			});
			this.cleanupFunctions.push(unsubRoomOverview);

			// 2. Task updates
			const unsubTaskUpdate = hub.onEvent<{ roomId: string; task: NeoTask }>(
				'room.task.update',
				(event) => {
					if (event.roomId === roomId) {
						const task = event.task;
						const idx = this.tasks.value.findIndex((t) => t.id === task.id);
						if (idx >= 0) {
							this.tasks.value = [
								...this.tasks.value.slice(0, idx),
								task,
								...this.tasks.value.slice(idx + 1),
							];
						} else {
							this.tasks.value = [...this.tasks.value, task];
						}
					}
				}
			);
			this.cleanupFunctions.push(unsubTaskUpdate);

			// 3. Neo context messages (room.message event from backend)
			const unsubNeoMessage = hub.onEvent<RoomMessageEvent>('room.message', (event) => {
				// Only process messages for this room
				if (event.roomId !== roomId) return;

				// Transform backend payload to NeoContextMessage shape
				const msg: NeoContextMessage = {
					id: event.message.id,
					contextId: this.room.value?.contextId ?? '',
					role: event.message.role as 'user' | 'assistant',
					content: event.message.content,
					timestamp: event.message.timestamp,
					tokenCount: 0, // Not provided in event
				};

				this.neoMessages.value = [...this.neoMessages.value, msg];
			});
			this.cleanupFunctions.push(unsubNeoMessage);

			// 4. Fetch initial state via RPC
			await this.fetchInitialState(hub, roomId);

			// 5. Load message history
			await this.loadMessageHistory(hub, roomId);
		} catch (err) {
			logger.error('Failed to start room subscriptions:', err);
			toast.error('Failed to connect to room');
			throw err;
		}
	}

	/**
	 * Fetch initial state via RPC calls (pure WebSocket)
	 */
	private async fetchInitialState(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		roomId: string
	): Promise<void> {
		try {
			const overview = await hub.request<RoomOverview>('room.get', { roomId });

			if (overview) {
				this.room.value = overview.room;
				this.sessions.value = overview.sessions;
				this.tasks.value = overview.activeTasks;
			} else {
				this.error.value = 'Room not found';
			}
		} catch (err) {
			logger.error('Failed to fetch room state:', err);
			this.error.value = err instanceof Error ? err.message : 'Failed to load room';
		}
	}

	/**
	 * Load message history for the room
	 */
	private async loadMessageHistory(
		hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
		roomId: string
	): Promise<void> {
		try {
			const response = await hub.request<{ messages: NeoContextMessage[] }>(
				'room.message.history',
				{ roomId }
			);
			this.neoMessages.value = response.messages ?? [];
		} catch (error) {
			logger.warn('Failed to load message history:', error);
			this.neoMessages.value = [];
		}
	}

	/**
	 * Stop all current subscriptions
	 */
	private async stopSubscriptions(): Promise<void> {
		// Call all cleanup functions
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
	// Refresh (for reconnection)
	// ========================================

	/**
	 * Refresh current room state from server
	 */
	async refresh(): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			return;
		}

		try {
			const hub = await connectionManager.getHub();
			await this.fetchInitialState(hub, roomId);
		} catch (err) {
			logger.error('Failed to refresh room state:', err);
		}
	}

	// ========================================
	// Neo Chat Methods
	// ========================================

	/**
	 * Send a message to Neo
	 */
	async sendNeoMessage(content: string): Promise<void> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		await hub.request('room.message.send', { roomId, content, role: 'user', sender: 'human' });
	}

	/**
	 * Create a new task in the room
	 */
	async createTask(title: string, description: string): Promise<NeoTask> {
		const roomId = this.roomId.value;
		if (!roomId) {
			throw new Error('No room selected');
		}

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		const { task } = await hub.request<{ task: NeoTask }>('task.create', {
			roomId,
			title,
			description,
		});

		if (task) {
			this.tasks.value = [...this.tasks.value, task];
		}

		return task;
	}
}

/** Singleton room store instance */
export const roomStore = new RoomStore();
