/**
 * WebSocket Type Definitions for Bun/Elysia
 *
 * These types provide proper typing for WebSocket handlers to avoid `any` casts.
 * Bun's native WebSocket API and Elysia's wrapper don't provide complete types,
 * so we define our own interfaces here.
 */

import type { ServerWebSocket as BunServerWebSocket } from 'bun';

/**
 * Extended WebSocket with client ID stored for cleanup and routing.
 * The __clientId is set when the client connects and used for subscription tracking.
 */
export interface WebSocketWithClientId extends BunServerWebSocket<unknown> {
	/** Client ID assigned by the transport for routing and cleanup */
	__clientId?: string;
}

/**
 * Elysia WebSocket wrapper that provides access to the raw Bun WebSocket.
 * Elysia wraps Bun's WebSocket to add its own functionality.
 */
export interface ElysiaWebSocket {
	/** The underlying Bun ServerWebSocket */
	raw: WebSocketWithClientId;
	/** Send a message to the client */
	send(message: string | ArrayBuffer | Uint8Array): void;
	/** Close the connection */
	close(code?: number, reason?: string): void;
	/** Subscribe to a topic */
	subscribe(topic: string): void;
	/** Unsubscribe from a topic */
	unsubscribe(topic: string): void;
	/** Publish to a topic */
	publish(topic: string, message: string | ArrayBuffer | Uint8Array): void;
	/** Check if subscribed to a topic */
	isSubscribed(topic: string): boolean;
	/** Connection ready state */
	readyState: number;
}

/**
 * WebSocket message data - can be string, Buffer, or ArrayBuffer
 */
export type WebSocketMessage = string | Buffer | ArrayBuffer;

/**
 * Parsed WebSocket message with sessionId for routing
 */
export interface ParsedWebSocketMessage {
	id?: string;
	type: string;
	method?: string;
	sessionId: string;
	timestamp?: string;
	data?: unknown;
	[key: string]: unknown;
}

/**
 * WebSocket handler configuration for Elysia's ws() method
 */
export interface WebSocketHandlers {
	open(ws: ElysiaWebSocket): void;
	message(ws: ElysiaWebSocket, message: WebSocketMessage): void | Promise<void>;
	close(ws: ElysiaWebSocket): void;
	error(ws: ElysiaWebSocket, error: Error): void;
}
