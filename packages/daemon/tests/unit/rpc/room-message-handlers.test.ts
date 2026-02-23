/**
 * Tests for Room Message RPC Handlers
 *
 * Tests the RPC handlers for room message operations:
 * - room.message.send - Send message to room (supports both 'user' and 'assistant' roles)
 * - room.message.history - Get conversation history
 *
 * Note: These tests verify handler behavior with mocked ContextManager.
 * Integration tests cover the full database flow.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub, type NeoContextMessage } from '@neokai/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { RoomManager } from '../../../src/lib/room/room-manager';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

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
	emitMock: ReturnType<typeof mock>;
} {
	const emitMock = mock(async () => {});
	const daemonHub = {
		emit: emitMock,
		on: mock(() => () => {}),
		off: mock(() => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;

	return { daemonHub, emitMock };
}

// Mock message storage for tests
let mockMessages: NeoContextMessage[] = [];
let messageIdCounter = 0;

// Helper to create mock Database that works with ContextManager
function createMockDatabase(): {
	db: Database;
	mocks: {
		getDatabase: ReturnType<typeof mock>;
	};
} {
	// Reset state for each test
	mockMessages = [];
	messageIdCounter = 0;

	// Create a proper bun:sqlite mock with prepared statements
	const preparedStatements = new Map<string, ReturnType<typeof mock>>();

	const createPreparedStatement = () => ({
		run: mock((..._args: unknown[]) => {
			messageIdCounter++;
			return { lastInsertRowid: messageIdCounter, changes: 1 };
		}),
		get: mock((..._args: unknown[]) => {
			// Return context if queried
			if (mockMessages.length === 0) {
				return { id: 'ctx-1', roomId: 'room-123', totalTokens: 0 };
			}
			return { id: 'ctx-1', roomId: 'room-123', totalTokens: 100 };
		}),
		all: mock((..._args: unknown[]) => mockMessages),
	});

	const mockRawDb = {
		prepare: mock((sql: string) => {
			// Cache prepared statements
			if (!preparedStatements.has(sql)) {
				preparedStatements.set(sql, createPreparedStatement());
			}
			return preparedStatements.get(sql);
		}),
		query: mock(() => []),
		exec: mock(() => {}),
		close: mock(() => {}),
	};

	const mocks = {
		getDatabase: mock(() => mockRawDb),
	};

	return {
		db: {
			getDatabase: mocks.getDatabase,
		} as unknown as Database,
		mocks,
	};
}

function createMockRoomManager(): {
	roomManager: RoomManager;
	mocks: {
		getRoom: ReturnType<typeof mock>;
	};
} {
	const mocks = {
		getRoom: mock((roomId: string) => {
			if (roomId === 'room-123') {
				return { id: 'room-123', name: 'Test Room' };
			}
			return null;
		}),
	};

	return {
		roomManager: {
			getRoom: mocks.getRoom,
		} as unknown as RoomManager,
		mocks,
	};
}

// Import handlers after setting up mocks
async function setupHandlersWithMocks(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	db: Database,
	roomManager: RoomManager
) {
	// Dynamic import to ensure module is loaded fresh
	const { setupRoomMessageHandlers } = await import(
		'../../../src/lib/rpc-handlers/room-message-handlers'
	);
	setupRoomMessageHandlers(messageHub, roomManager, daemonHub, db);
}

describe('Room Message RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;
	let daemonHubData: ReturnType<typeof createMockDaemonHub>;
	let dbData: ReturnType<typeof createMockDatabase>;
	let roomManagerData: ReturnType<typeof createMockRoomManager>;

	beforeEach(async () => {
		messageHubData = createMockMessageHub();
		daemonHubData = createMockDaemonHub();
		dbData = createMockDatabase();
		roomManagerData = createMockRoomManager();

		// Setup handlers with mocked dependencies
		await setupHandlersWithMocks(
			messageHubData.hub,
			daemonHubData.daemonHub,
			dbData.db,
			roomManagerData.roomManager
		);
	});

	afterEach(() => {
		mock.restore();
		mockMessages = [];
		messageIdCounter = 0;
	});

	describe('room.message.send', () => {
		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.message.send');
			expect(handler).toBeDefined();

			await expect(handler!({ content: 'Hello', role: 'user' }, {})).rejects.toThrow(
				'Room ID is required'
			);
		});

		it('throws error when content is missing', async () => {
			const handler = messageHubData.handlers.get('room.message.send');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', role: 'user' }, {})).rejects.toThrow(
				'Message content is required'
			);
		});

		it('throws error when role is missing', async () => {
			const handler = messageHubData.handlers.get('room.message.send');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-123', content: 'Hello' }, {})).rejects.toThrow(
				"Role must be 'user' or 'assistant'"
			);
		});

		it('throws error when role is invalid', async () => {
			const handler = messageHubData.handlers.get('room.message.send');
			expect(handler).toBeDefined();

			await expect(
				handler!({ roomId: 'room-123', content: 'Hello', role: 'invalid' }, {})
			).rejects.toThrow("Role must be 'user' or 'assistant'");
		});

		it('throws error when room does not exist', async () => {
			const handler = messageHubData.handlers.get('room.message.send');
			expect(handler).toBeDefined();

			await expect(
				handler!({ roomId: 'room-missing', content: 'Hello', role: 'user' }, {})
			).rejects.toThrow('Room not found: room-missing');
		});
	});

	describe('room.message.history', () => {
		it('throws error when roomId is missing', async () => {
			const handler = messageHubData.handlers.get('room.message.history');
			expect(handler).toBeDefined();

			await expect(handler!({}, {})).rejects.toThrow('Room ID is required');
		});

		it('throws error when room does not exist', async () => {
			const handler = messageHubData.handlers.get('room.message.history');
			expect(handler).toBeDefined();

			await expect(handler!({ roomId: 'room-missing' }, {})).rejects.toThrow(
				'Room not found: room-missing'
			);
		});
	});

	describe('handler registration', () => {
		it('registers room.message.send handler', async () => {
			// Re-setup handlers for this test
			const newHubData = createMockMessageHub();
			await setupHandlersWithMocks(
				newHubData.hub,
				daemonHubData.daemonHub,
				dbData.db,
				roomManagerData.roomManager
			);
			expect(newHubData.handlers.has('room.message.send')).toBe(true);
		});

		it('registers room.message.history handler', async () => {
			// Re-setup handlers for this test
			const newHubData = createMockMessageHub();
			await setupHandlersWithMocks(
				newHubData.hub,
				daemonHubData.daemonHub,
				dbData.db,
				roomManagerData.roomManager
			);
			expect(newHubData.handlers.has('room.message.history')).toBe(true);
		});
	});
});
