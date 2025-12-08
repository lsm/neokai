/**
 * MessageHub WebSocket Handlers using Bun Native WebSocket
 *
 * UNIFIED WebSocket endpoint - all messages routed by sessionId field
 * Following MessageHub architectural principle: "sessionId in message, not URL"
 */

import type { ServerWebSocket } from 'bun';
import { createEventMessage, createErrorMessage, MessageType, generateUUID } from '@liuboer/shared';
import type { HubMessage } from '@liuboer/shared/message-hub/protocol';
import type { WebSocketServerTransport } from '../lib/websocket-server-transport';
import type { SessionManager } from '../lib/session-manager';
import type { SubscriptionManager } from '../lib/subscription-manager';

const GLOBAL_SESSION_ID = 'global';

// FIX P1.1: Message size validation constants (DoS prevention)
const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10MB max message size
const MAX_MESSAGE_SIZE_MB = MAX_MESSAGE_SIZE / (1024 * 1024);

/**
 * WebSocket data stored on each connection
 */
interface WebSocketData {
	connectionSessionId: string;
	clientId?: string;
}

/**
 * Parsed WebSocket message with sessionId for routing
 */
interface ParsedWebSocketMessage {
	id?: string;
	type: string;
	method?: string;
	sessionId: string;
	timestamp?: string;
	data?: unknown;
	[key: string]: unknown;
}

export function createWebSocketHandlers(
	transport: WebSocketServerTransport,
	sessionManager: SessionManager,
	_subscriptionManager: SubscriptionManager
) {
	return {
		open(ws: ServerWebSocket<WebSocketData>) {
			console.log('WebSocket connection established');

			// Register client with transport (starts in global session)
			const clientId = transport.registerClient(ws, GLOBAL_SESSION_ID);

			// Store clientId on websocket data for cleanup and message handling
			ws.data.clientId = clientId;

			// NOTE: We don't auto-subscribe clients to events anymore.
			// Clients will subscribe themselves by sending SUBSCRIBE messages.
			// This prevents the server-side subscription timeout issue.

			// Send connection confirmation as a proper EVENT message
			const connectionEvent = createEventMessage({
				method: 'connection.established',
				sessionId: GLOBAL_SESSION_ID,
				data: {
					message: 'WebSocket connection established',
					protocol: 'MessageHub',
					version: '1.0.0',
				},
			});
			ws.send(JSON.stringify(connectionEvent));
		},

		async message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
			try {
				// FIX P1.1: Validate message size before parsing (DoS prevention)
				const messageStr = typeof message === 'string' ? message : message.toString();
				const messageSize = new TextEncoder().encode(messageStr).length;

				if (messageSize > MAX_MESSAGE_SIZE) {
					console.error(
						`Message rejected: size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds limit ${MAX_MESSAGE_SIZE_MB}MB`
					);
					const errorMsg = createErrorMessage({
						method: 'message.process',
						error: {
							code: 'MESSAGE_TOO_LARGE',
							message: `Message size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds maximum ${MAX_MESSAGE_SIZE_MB}MB`,
						},
						sessionId: GLOBAL_SESSION_ID,
					});
					ws.send(JSON.stringify(errorMsg));
					return;
				}

				const data: ParsedWebSocketMessage = JSON.parse(messageStr);

				// Handle ping/pong
				if (data.type === 'ping' || data.type === 'PING') {
					const pongMsg = {
						id: generateUUID(),
						type: MessageType.PONG,
						sessionId: data.sessionId || GLOBAL_SESSION_ID,
						method: 'heartbeat',
						timestamp: new Date().toISOString(),
						requestId: data.id,
					};
					ws.send(JSON.stringify(pongMsg));
					return;
				}

				// Get client ID for subscription tracking
				const clientId = ws.data.clientId;

				// Validate sessionId exists in message
				if (!data.sessionId) {
					console.warn('Message without sessionId, defaulting to global');
					data.sessionId = GLOBAL_SESSION_ID;
				}

				// For session-specific messages, verify session exists (except for global)
				// SUBSCRIBE/UNSUBSCRIBE are protocol-level and don't require session validation
				const isProtocolMessage = data.type === 'SUBSCRIBE' || data.type === 'UNSUBSCRIBE';
				if (data.sessionId !== GLOBAL_SESSION_ID && !isProtocolMessage) {
					const session = await sessionManager.getSessionAsync(data.sessionId);
					if (!session) {
						const errorMsg = createErrorMessage({
							method: data.method || 'unknown.method',
							error: {
								code: 'SESSION_NOT_FOUND',
								message: `Session not found: ${data.sessionId}`,
							},
							sessionId: data.sessionId,
							requestId: data.id,
						});
						ws.send(JSON.stringify(errorMsg));
						return;
					}
				}

				// Pass to transport which will notify MessageHub
				// Message routing is handled by sessionId field, not connection
				// Cast to HubMessage - the parsed JSON has the same structure
				if (clientId) {
					transport.handleClientMessage(data as unknown as HubMessage, clientId);
				}
			} catch (error) {
				console.error('Error processing WebSocket message:', error);
				const errorMsg = createErrorMessage({
					method: 'message.process',
					error: {
						code: 'INVALID_MESSAGE',
						message: error instanceof Error ? error.message : 'Invalid message format',
					},
					sessionId: GLOBAL_SESSION_ID,
				});
				ws.send(JSON.stringify(errorMsg));
			}
		},

		close(ws: ServerWebSocket<WebSocketData>) {
			console.log('WebSocket disconnected');
			const clientId = ws.data.clientId;
			if (clientId) {
				transport.unregisterClient(clientId);
			}
		},

		error(ws: ServerWebSocket<WebSocketData>, error: Error) {
			console.error('WebSocket error:', error);
			const clientId = ws.data.clientId;
			if (clientId) {
				transport.unregisterClient(clientId);
			}
		},
	};
}
