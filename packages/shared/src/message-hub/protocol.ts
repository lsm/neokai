/**
 * MessageHub Protocol
 *
 * WAMP-inspired unified messaging protocol for bidirectional RPC and Pub/Sub.
 *
 * Key features:
 * - Bidirectional RPC (client↔server)
 * - Pub/Sub messaging
 * - Session-based routing (sessionId in message, not URL)
 * - Type-safe method registry
 */

import { generateUUID } from '../utils.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('liuboer:messagehub:protocol');

/**
 * Protocol version for compatibility checking
 */
const PROTOCOL_VERSION = '1.0.0';

/**
 * Message types following WAMP-inspired pattern
 */
export enum MessageType {
	/**
	 * RPC call (request)
	 * Can be sent by either client or server
	 */
	CALL = 'CALL',

	/**
	 * RPC success response
	 */
	RESULT = 'RESULT',

	/**
	 * RPC error response
	 */
	ERROR = 'ERROR',

	/**
	 * Event delivery to subscriber
	 */
	EVENT = 'EVENT',

	/**
	 * Explicit subscription request (optional)
	 */
	SUBSCRIBE = 'SUBSCRIBE',

	/**
	 * Unsubscribe request
	 */
	UNSUBSCRIBE = 'UNSUBSCRIBE',

	/**
	 * Subscription confirmation (response to SUBSCRIBE)
	 */
	SUBSCRIBED = 'SUBSCRIBED',

	/**
	 * Unsubscription confirmation (response to UNSUBSCRIBE)
	 */
	UNSUBSCRIBED = 'UNSUBSCRIBED',

	/**
	 * Heartbeat/ping for connection health
	 */
	PING = 'PING',

	/**
	 * Pong response to ping
	 */
	PONG = 'PONG',
}

/**
 * Base message structure for all MessageHub communications
 */
export interface HubMessage {
	/**
	 * Unique message identifier (UUID)
	 */
	id: string;

	/**
	 * Message type
	 */
	type: MessageType;

	/**
	 * Session routing identifier
	 * - "global" for system-wide operations
	 * - Specific session ID for session-scoped operations
	 */
	sessionId: string;

	/**
	 * Method/Event name
	 * Format: <domain>.<action>[.<type>]
	 * Examples: "session.create", "session.deleted", "client.getViewportInfo"
	 */
	method: string;

	/**
	 * Message payload (method-specific)
	 */
	data?: unknown;

	/**
	 * Original request ID (for RESULT/ERROR responses)
	 */
	requestId?: string;

	/**
	 * Error message (for ERROR type)
	 */
	error?: string;

	/**
	 * Error code (for ERROR type)
	 */
	errorCode?: string;

	/**
	 * ISO 8601 timestamp
	 */
	timestamp: string;

	/**
	 * Protocol version
	 */
	version?: string;

	/**
	 * Sequence number for message ordering (optional)
	 * Monotonically increasing per-session sequence number
	 * Allows detection of out-of-order messages
	 */
	sequence?: number;
}

/**
 * CALL message (RPC request)
 */
export interface CallMessage extends HubMessage {
	type: MessageType.CALL;
	method: string;
	data?: unknown;
}

/**
 * RESULT message (RPC success response)
 */
export interface ResultMessage extends HubMessage {
	type: MessageType.RESULT;
	method: string;
	requestId: string;
	data?: unknown;
}

/**
 * ERROR message (RPC error response)
 */
export interface ErrorMessage extends HubMessage {
	type: MessageType.ERROR;
	method: string;
	requestId: string;
	error: string;
	errorCode?: string;
}

/**
 * EVENT message (pub/sub event delivery)
 */
export interface EventMessage extends HubMessage {
	type: MessageType.EVENT;
	method: string;
	data?: unknown;
}

/**
 * SUBSCRIBE message (explicit subscription)
 */
export interface SubscribeMessage extends HubMessage {
	type: MessageType.SUBSCRIBE;
	method: string;
}

/**
 * UNSUBSCRIBE message
 */
export interface UnsubscribeMessage extends HubMessage {
	type: MessageType.UNSUBSCRIBE;
	method: string;
}

/**
 * SUBSCRIBED message (subscription confirmation)
 */
export interface SubscribedMessage extends HubMessage {
	type: MessageType.SUBSCRIBED;
	method: string;
	requestId: string;
	data?: {
		subscribed: boolean;
		method: string;
		sessionId: string;
	};
}

/**
 * UNSUBSCRIBED message (unsubscription confirmation)
 */
export interface UnsubscribedMessage extends HubMessage {
	type: MessageType.UNSUBSCRIBED;
	method: string;
	requestId: string;
	data?: {
		unsubscribed: boolean;
		method: string;
		sessionId: string;
	};
}

/**
 * Type guards
 */
export function isCallMessage(msg: HubMessage): msg is CallMessage {
	return msg.type === MessageType.CALL;
}

export function isEventMessage(msg: HubMessage): msg is EventMessage {
	return msg.type === MessageType.EVENT;
}

export function isSubscribeMessage(msg: HubMessage): msg is SubscribeMessage {
	return msg.type === MessageType.SUBSCRIBE;
}

export function isUnsubscribeMessage(msg: HubMessage): msg is UnsubscribeMessage {
	return msg.type === MessageType.UNSUBSCRIBE;
}

export function isSubscribedMessage(msg: HubMessage): msg is SubscribedMessage {
	return msg.type === MessageType.SUBSCRIBED;
}

export function isUnsubscribedMessage(msg: HubMessage): msg is UnsubscribedMessage {
	return msg.type === MessageType.UNSUBSCRIBED;
}

/**
 * Check if message is a response (RESULT or ERROR)
 */
export function isResponseMessage(msg: HubMessage): msg is ResultMessage | ErrorMessage {
	return msg.type === MessageType.RESULT || msg.type === MessageType.ERROR;
}

/**
 * HubMessage with internal metadata added by transport layer
 * This extends the protocol message with server-side routing metadata
 */
export interface HubMessageWithMetadata extends HubMessage {
	/**
	 * Client ID added by server-side transport for subscription tracking and routing.
	 * Not part of the wire protocol - added internally during message processing.
	 */
	clientId?: string;
}

/**
 * Session ID constants
 */
export const GLOBAL_SESSION_ID = 'global';

/**
 * Validate method name
 *
 * Format: "domain.action" (e.g., "session.create", "user.update")
 * - Must contain at least one dot
 * - Can contain alphanumeric, dots, underscores, hyphens
 * - Colons are RESERVED for internal use (not allowed in user-defined methods)
 */
export function validateMethod(method: string): boolean {
	// Must have at least one dot (for the method part)
	if (!method.includes('.')) {
		return false;
	}

	// Must not start or end with dot
	if (method.startsWith('.') || method.endsWith('.')) {
		return false;
	}

	// Must not contain colons (reserved for internal routing)
	if (method.includes(':')) {
		return false;
	}

	// Must contain only alphanumeric, dots, underscores, and hyphens
	return /^[a-zA-Z0-9._-]+$/.test(method);
}

/**
 * Error codes
 */
export enum ErrorCode {
	// Protocol errors
	INVALID_MESSAGE = 'INVALID_MESSAGE',
	INVALID_METHOD = 'INVALID_METHOD',
	PROTOCOL_VERSION_MISMATCH = 'PROTOCOL_VERSION_MISMATCH',

	// RPC errors
	METHOD_NOT_FOUND = 'METHOD_NOT_FOUND',
	HANDLER_ERROR = 'HANDLER_ERROR',
	TIMEOUT = 'TIMEOUT',
	INVALID_PARAMS = 'INVALID_PARAMS',

	// Session errors
	INVALID_SESSION = 'INVALID_SESSION',
	SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',

	// Transport errors
	TRANSPORT_ERROR = 'TRANSPORT_ERROR',
	NOT_CONNECTED = 'NOT_CONNECTED',

	// General errors
	INTERNAL_ERROR = 'INTERNAL_ERROR',
	UNAUTHORIZED = 'UNAUTHORIZED',
}

/**
 * Error object with code and message
 */
export interface ErrorDetail {
	code: string;
	message: string;
}

/**
 * Parameters for creating a CALL message
 */
export interface CreateCallMessageParams {
	method: string;
	data: unknown;
	sessionId: string;
	id?: string;
}

/**
 * Parameters for creating a RESULT message
 */
export interface CreateResultMessageParams {
	method: string;
	data: unknown;
	sessionId: string;
	requestId?: string;
	id?: string;
}

/**
 * Parameters for creating an ERROR message
 */
export interface CreateErrorMessageParams {
	method: string;
	error: string | ErrorDetail;
	sessionId: string;
	requestId?: string;
	id?: string;
}

/**
 * Parameters for creating an EVENT message
 */
export interface CreateEventMessageParams {
	method: string;
	data: unknown;
	sessionId: string;
	id?: string;
}

/**
 * Parameters for creating a SUBSCRIBE message
 */
export interface CreateSubscribeMessageParams {
	method: string;
	sessionId: string;
	id?: string;
}

/**
 * Parameters for creating an UNSUBSCRIBE message
 */
export interface CreateUnsubscribeMessageParams {
	method: string;
	sessionId: string;
	id?: string;
}

/**
 * Parameters for creating a SUBSCRIBED message
 */
export interface CreateSubscribedMessageParams {
	method: string;
	sessionId: string;
	requestId: string;
	id?: string;
}

/**
 * Parameters for creating an UNSUBSCRIBED message
 */
export interface CreateUnsubscribedMessageParams {
	method: string;
	sessionId: string;
	requestId: string;
	id?: string;
}

/**
 * Create a CALL message
 */
export function createCallMessage(params: CreateCallMessageParams): CallMessage {
	const { method, data, sessionId, id } = params;
	return {
		id: id || generateUUID(),
		type: MessageType.CALL,
		sessionId,
		method,
		data,
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
	};
}

/**
 * Create a RESULT message
 */
export function createResultMessage(params: CreateResultMessageParams): ResultMessage {
	const { method, data, sessionId, requestId, id } = params;
	return {
		id: id || generateUUID(),
		type: MessageType.RESULT,
		sessionId,
		method,
		data,
		requestId: requestId || '',
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
	};
}

/**
 * Create an ERROR message
 */
export function createErrorMessage(params: CreateErrorMessageParams): ErrorMessage {
	const { method, error: errorParam, sessionId, requestId, id } = params;
	const errorMessage = typeof errorParam === 'string' ? errorParam : errorParam.message;
	const code = typeof errorParam === 'string' ? undefined : errorParam.code;

	return {
		id: id || generateUUID(),
		type: MessageType.ERROR,
		sessionId,
		method,
		error: errorMessage,
		errorCode: code,
		requestId: requestId || '',
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
	};
}

/**
 * Create an EVENT message
 */
export function createEventMessage(params: CreateEventMessageParams): EventMessage {
	const { method, data, sessionId, id } = params;
	return {
		id: id || generateUUID(),
		type: MessageType.EVENT,
		sessionId,
		method,
		data,
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
	};
}

/**
 * Create a SUBSCRIBE message
 */
export function createSubscribeMessage(params: CreateSubscribeMessageParams): SubscribeMessage {
	const { method, sessionId, id } = params;
	return {
		id: id || generateUUID(),
		type: MessageType.SUBSCRIBE,
		sessionId,
		method,
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
	};
}

/**
 * Create an UNSUBSCRIBE message
 */
export function createUnsubscribeMessage(
	params: CreateUnsubscribeMessageParams
): UnsubscribeMessage {
	const { method, sessionId, id } = params;
	return {
		id: id || generateUUID(),
		type: MessageType.UNSUBSCRIBE,
		sessionId,
		method,
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
	};
}

/**
 * Create a SUBSCRIBED message (subscription confirmation)
 */
export function createSubscribedMessage(params: CreateSubscribedMessageParams): SubscribedMessage {
	const { method, sessionId, requestId, id } = params;
	return {
		id: id || generateUUID(),
		type: MessageType.SUBSCRIBED,
		sessionId,
		method,
		requestId,
		data: {
			subscribed: true,
			method,
			sessionId,
		},
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
	};
}

/**
 * Create an UNSUBSCRIBED message (unsubscription confirmation)
 */
export function createUnsubscribedMessage(
	params: CreateUnsubscribedMessageParams
): UnsubscribedMessage {
	const { method, sessionId, requestId, id } = params;
	return {
		id: id || generateUUID(),
		type: MessageType.UNSUBSCRIBED,
		sessionId,
		method,
		requestId,
		data: {
			unsubscribed: true,
			method,
			sessionId,
		},
		timestamp: new Date().toISOString(),
		version: PROTOCOL_VERSION,
	};
}

/**
 * Validate message structure
 * Checks all required fields and basic type correctness
 * FIX P2.3: Add protocol version validation
 */
export function isValidMessage(msg: unknown): msg is HubMessage {
	if (!msg || typeof msg !== 'object') {
		return false;
	}

	// Type assertion after basic check - we know it's an object now
	const m = msg as Record<string, unknown>;

	// Check required fields
	if (typeof m.id !== 'string' || m.id.length === 0) {
		return false;
	}

	if (typeof m.type !== 'string' || !Object.values(MessageType).includes(m.type as MessageType)) {
		return false;
	}

	if (typeof m.sessionId !== 'string' || m.sessionId.length === 0) {
		return false;
	}

	if (typeof m.method !== 'string' || m.method.length === 0) {
		return false;
	}

	if (typeof m.timestamp !== 'string') {
		return false;
	}

	// FIX P2.3: Validate protocol version if present (warn on mismatch, but don't reject)
	// Note: Accept both undefined and null for optional fields (Zig serializes optionals as null)
	if (m.version !== undefined && m.version !== null) {
		if (typeof m.version !== 'string') {
			return false;
		}

		// Warn if version doesn't match (but allow for backward/forward compatibility)
		if (m.version !== PROTOCOL_VERSION) {
			log.warn(
				`Version mismatch: received ${m.version}, expected ${PROTOCOL_VERSION}. ` +
					`Message will be processed but may have compatibility issues.`
			);
		}
	}

	// Validate method format (except for PING/PONG which don't need method validation)
	if (m.type !== MessageType.PING && m.type !== MessageType.PONG) {
		if (!validateMethod(m.method)) {
			return false;
		}
	}

	// Response messages must have requestId
	if (
		(m.type === MessageType.RESULT || m.type === MessageType.ERROR) &&
		typeof m.requestId !== 'string'
	) {
		return false;
	}

	// ERROR messages must have error field
	if (m.type === MessageType.ERROR && typeof m.error !== 'string') {
		return false;
	}

	return true;
}
