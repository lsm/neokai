/**
 * WebSocket Mock Utilities
 *
 * Provides mock implementations for Bun's ServerWebSocket
 * that can be used in unit tests.
 */

import { mock } from 'bun:test';
import type { ServerWebSocket } from 'bun';

/**
 * WebSocket data interface matching setup-websocket.ts
 */
export interface MockWebSocketData {
	connectionSessionId: string;
	clientId?: string;
}

/**
 * Mock ServerWebSocket implementation
 */
export interface MockServerWebSocket<T = MockWebSocketData> {
	data: T;
	send: ReturnType<typeof mock>;
	close: ReturnType<typeof mock>;
	readyState: number;
	sentMessages: string[];
}

/**
 * Create a mock ServerWebSocket
 */
export function createMockServerWebSocket<T = MockWebSocketData>(
	data?: T
): MockServerWebSocket<T> & ServerWebSocket<T> {
	const sentMessages: string[] = [];

	const mockWs = {
		data:
			data ||
			({
				connectionSessionId: 'global',
				clientId: undefined,
			} as unknown as T),
		send: mock((message: string) => {
			sentMessages.push(message);
			return 0; // Bun's send returns number of bytes sent
		}),
		close: mock((_code?: number, _reason?: string) => {}),
		readyState: 1, // WebSocket.OPEN
		sentMessages,
		// Additional WebSocket properties that might be accessed
		remoteAddress: '127.0.0.1',
		binaryType: 'arraybuffer' as const,
		subscribe: mock(() => {}),
		unsubscribe: mock(() => {}),
		isSubscribed: mock(() => false),
		cork: mock((callback: () => void) => callback()),
		publish: mock(() => 0),
		publishText: mock(() => 0),
		publishBinary: mock(() => 0),
	};

	return mockWs as MockServerWebSocket<T> & ServerWebSocket<T>;
}

/**
 * Create mock WebSocket handlers dependencies
 */
export interface MockHandlerDependencies {
	transport: {
		registerClient: ReturnType<typeof mock>;
		unregisterClient: ReturnType<typeof mock>;
		handleClientMessage: ReturnType<typeof mock>;
		updateClientActivity: ReturnType<typeof mock>;
	};
	sessionManager: {
		getSessionAsync: ReturnType<typeof mock>;
	};
	subscriptionManager: Record<string, unknown>;
}

export function createMockHandlerDependencies(): MockHandlerDependencies {
	return {
		transport: {
			registerClient: mock((ws: unknown, sessionId: string) => {
				return `client-${sessionId}-${Date.now()}`;
			}),
			unregisterClient: mock(() => {}),
			handleClientMessage: mock(() => {}),
			updateClientActivity: mock(() => {}),
		},
		sessionManager: {
			getSessionAsync: mock(async (sessionId: string) => {
				// Return mock session for valid IDs
				if (sessionId && sessionId !== 'nonexistent') {
					return {
						id: sessionId,
						title: 'Mock Session',
						workspacePath: '/mock/path',
						status: 'active',
					};
				}
				return null;
			}),
		},
		subscriptionManager: {},
	};
}

/**
 * Parse sent message from mock WebSocket
 */
export function parseSentMessage(mockWs: MockServerWebSocket): unknown | null {
	if (mockWs.sentMessages.length === 0) {
		return null;
	}
	const lastMessage = mockWs.sentMessages[mockWs.sentMessages.length - 1];
	try {
		return JSON.parse(lastMessage);
	} catch {
		return lastMessage;
	}
}

/**
 * Get all sent messages as parsed JSON
 */
export function getAllSentMessages(mockWs: MockServerWebSocket): unknown[] {
	return mockWs.sentMessages.map((msg) => {
		try {
			return JSON.parse(msg);
		} catch {
			return msg;
		}
	});
}
