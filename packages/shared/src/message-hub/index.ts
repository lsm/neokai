/**
 * MessageHub - Unified messaging system
 *
 * Public API exports
 */

// Core
export { MessageHub } from "./message-hub.ts";
export { MessageHubRouter } from "./router.ts";

// Protocol
export {
  PROTOCOL_VERSION,
  GLOBAL_SESSION_ID,
  MessageType,
  ErrorCode,
  type HubMessage,
  type CallMessage,
  type ResultMessage,
  type ErrorMessage,
  type PublishMessage,
  type EventMessage,
  type SubscribeMessage,
  type UnsubscribeMessage,
  type ErrorDetail,
  type CreateCallMessageParams,
  type CreateResultMessageParams,
  type CreateErrorMessageParams,
  type CreatePublishMessageParams,
  type CreateEventMessageParams,
  type CreateSubscribeMessageParams,
  type CreateUnsubscribeMessageParams,
  isCallMessage,
  isResultMessage,
  isErrorMessage,
  isPublishMessage,
  isEventMessage,
  isSubscribeMessage,
  isUnsubscribeMessage,
  isResponseMessage,
  validateMethod,
  createCallMessage,
  createResultMessage,
  createErrorMessage,
  createPublishMessage,
  createEventMessage,
} from "./protocol.ts";

// Types
export type {
  UnsubscribeFn,
  RPCHandler,
  EventHandler,
  MessageHandler,
  ConnectionStateHandler,
  CallContext,
  EventContext,
  ConnectionState,
  CallOptions,
  PublishOptions,
  SubscribeOptions,
  MessageHubOptions,
  IMessageTransport,
  PendingCall,
} from "./types.ts";

// Transports - renamed to avoid conflict with EventBus transports
export { WebSocketClientTransport as HubWebSocketClientTransport } from "./transport-websocket-client.ts";
export { WebSocketServerTransport as HubWebSocketServerTransport } from "./transport-websocket-server.ts";
export type { WebSocketClientTransportOptions as HubWebSocketClientTransportOptions } from "./transport-websocket-client.ts";
export type { WebSocketServerTransportOptions as HubWebSocketServerTransportOptions } from "./transport-websocket-server.ts";
