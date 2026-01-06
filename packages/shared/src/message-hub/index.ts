/**
 * MessageHub - Unified messaging system
 *
 * Public API exports
 */

// Core
export { MessageHub } from './message-hub.ts';
export { MessageHubRouter } from './router.ts';
export type {
	ClientConnection,
	RouterLogger,
	MessageHubRouterOptions,
	RouteResult,
} from './router.ts';

// Protocol
export {
	MessageType,
	type HubMessage,
	type CallMessage,
	type ResultMessage,
	type ErrorMessage,
	type EventMessage,
	type SubscribeMessage,
	type UnsubscribeMessage,
	type ErrorDetail,
	type CreateCallMessageParams,
	type CreateResultMessageParams,
	type CreateErrorMessageParams,
	type CreateEventMessageParams,
	type CreateSubscribeMessageParams,
	type CreateUnsubscribeMessageParams,
	createErrorMessage,
	createEventMessage,
} from './protocol.ts';

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
} from './types.ts';

// Transports
export { WebSocketClientTransport } from './websocket-client-transport.ts';
export type { WebSocketClientTransportOptions } from './websocket-client-transport.ts';

export { InProcessTransport, InProcessTransportBus } from './in-process-transport.ts';
export type { InProcessTransportOptions } from './in-process-transport.ts';
