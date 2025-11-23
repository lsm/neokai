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

import { generateUUID } from "../utils.ts";

/**
 * Protocol version for compatibility checking
 */
export const PROTOCOL_VERSION = "1.0.0";

/**
 * Message types following WAMP-inspired pattern
 */
export enum MessageType {
  /**
   * RPC call (request)
   * Can be sent by either client or server
   */
  CALL = "CALL",

  /**
   * RPC success response
   */
  RESULT = "RESULT",

  /**
   * RPC error response
   */
  ERROR = "ERROR",

  /**
   * Publish an event
   */
  PUBLISH = "PUBLISH",

  /**
   * Explicit subscription request (optional)
   */
  SUBSCRIBE = "SUBSCRIBE",

  /**
   * Unsubscribe request
   */
  UNSUBSCRIBE = "UNSUBSCRIBE",

  /**
   * Event delivery to subscriber
   */
  EVENT = "EVENT",

  /**
   * Heartbeat/ping for connection health
   */
  PING = "PING",

  /**
   * Pong response to ping
   */
  PONG = "PONG",
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
 * PUBLISH message
 */
export interface PublishMessage extends HubMessage {
  type: MessageType.PUBLISH;
  method: string;
  data?: unknown;
}

/**
 * EVENT message (delivered to subscribers)
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
 * Type guards
 */
export function isCallMessage(msg: HubMessage): msg is CallMessage {
  return msg.type === MessageType.CALL;
}

export function isResultMessage(msg: HubMessage): msg is ResultMessage {
  return msg.type === MessageType.RESULT;
}

export function isErrorMessage(msg: HubMessage): msg is ErrorMessage {
  return msg.type === MessageType.ERROR;
}

export function isPublishMessage(msg: HubMessage): msg is PublishMessage {
  return msg.type === MessageType.PUBLISH;
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

/**
 * Check if message is a response (RESULT or ERROR)
 */
export function isResponseMessage(msg: HubMessage): msg is ResultMessage | ErrorMessage {
  return msg.type === MessageType.RESULT || msg.type === MessageType.ERROR;
}

/**
 * Session ID constants
 */
export const GLOBAL_SESSION_ID = "global";

/**
 * Reserved method prefixes
 */
export const RESERVED_METHOD_PREFIXES = [
  "system.", // System operations
  "client.", // Client-side methods (server→client RPC)
  "server.", // Server-side methods (client→server RPC)
];

/**
 * Validate method name
 *
 * Supports both:
 * - Simple methods: "session.create", "user.update"
 * - Session-scoped events: "sessionId:event.name", "global:session.created"
 */
export function validateMethod(method: string): boolean {
  // Must have at least one dot (for the method part)
  if (!method.includes(".")) {
    return false;
  }

  // Must not start or end with dot or colon
  if (method.startsWith(".") || method.endsWith(".") || method.startsWith(":") || method.endsWith(":")) {
    return false;
  }

  // Must contain only alphanumeric, dots, underscores, hyphens, and colons
  // Colons are used for session-scoped event patterns like "sessionId:event.name"
  return /^[a-zA-Z0-9._:-]+$/.test(method);
}

/**
 * Error codes
 */
export enum ErrorCode {
  // Protocol errors
  INVALID_MESSAGE = "INVALID_MESSAGE",
  INVALID_METHOD = "INVALID_METHOD",
  PROTOCOL_VERSION_MISMATCH = "PROTOCOL_VERSION_MISMATCH",

  // RPC errors
  METHOD_NOT_FOUND = "METHOD_NOT_FOUND",
  HANDLER_ERROR = "HANDLER_ERROR",
  TIMEOUT = "TIMEOUT",
  INVALID_PARAMS = "INVALID_PARAMS",

  // Session errors
  INVALID_SESSION = "INVALID_SESSION",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",

  // Transport errors
  TRANSPORT_ERROR = "TRANSPORT_ERROR",
  NOT_CONNECTED = "NOT_CONNECTED",

  // General errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
  UNAUTHORIZED = "UNAUTHORIZED",
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
 * Parameters for creating a PUBLISH message
 */
export interface CreatePublishMessageParams {
  method: string;
  data: unknown;
  sessionId: string;
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
 * Create a PUBLISH message
 */
export function createPublishMessage(params: CreatePublishMessageParams): PublishMessage {
  const { method, data, sessionId, id } = params;
  return {
    id: id || generateUUID(),
    type: MessageType.PUBLISH,
    sessionId,
    method,
    data,
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
export function createUnsubscribeMessage(params: CreateUnsubscribeMessageParams): UnsubscribeMessage {
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
 * Validate message structure
 */
export function isValidMessage(msg: any): msg is HubMessage {
  return (
    msg &&
    typeof msg === "object" &&
    typeof msg.id === "string" &&
    typeof msg.type === "string" &&
    typeof msg.sessionId === "string" &&
    typeof msg.method === "string" &&
    typeof msg.timestamp === "string"
  );
}
