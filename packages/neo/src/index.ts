/**
 * Neo - AI Orchestrator Package
 *
 * A daemon client that uses MessageHub RPC to communicate with the daemon.
 * Provides RoomNeo for AI-powered room orchestration.
 */

// RoomNeo - AI orchestrator for a single room
export { RoomNeo, type RoomNeoConfig, type MessageMetadata } from './room-neo';

// Session watcher - monitors worker session state changes
export { NeoSessionWatcher, type SessionEventHandlers } from './neo-session-watcher';

// Prompt utilities
export {
	ROOM_NEO_SYSTEM_PROMPT,
	buildRoomPrompt,
	parseNeoActions,
	extractTextResponse,
	type NeoAction,
} from './neo-prompt';
