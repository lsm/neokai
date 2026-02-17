/**
 * DaemonHub - Type-safe event hub for daemon internal coordination
 *
 * Replaces EventBus with TypedHub for:
 * - Async-everywhere design (future cluster-ready)
 * - Same type-safe API
 * - Session-scoped subscriptions with O(1) lookup
 *
 * EVENT NAMING: Uses dots (.) instead of colons (:)
 * - EventBus: 'session:created'
 * - DaemonHub: 'session.created'
 */

import { TypedHub, type BaseEventData } from '@neokai/shared';
import type {
	Session,
	AuthMethod,
	ContextInfo,
	MessageContent,
	MessageImage,
	GlobalSettings,
	AgentProcessingState,
	ApiConnectionState,
	PendingUserQuestion,
	RewindMode,
	RewindResult,
} from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { Room, NeoTask, TaskSummary } from '@neokai/shared';

/**
 * Compaction trigger type
 */
export type CompactionTrigger = 'manual' | 'auto';

/**
 * Daemon event map - all events must include sessionId
 *
 * Design principle: Publishers include their data in events.
 * StateManager maintains its own state from events (no fetching from sources).
 */
export interface DaemonEventMap extends Record<string, BaseEventData> {
	// Session lifecycle events
	'session.created': { sessionId: string; session: Session };
	'session.updated': {
		sessionId: string;
		source?: string;
		session?: Partial<Session>;
		processingState?: AgentProcessingState;
	};
	'session.deleted': { sessionId: string };

	// SDK events
	'sdk.message': { sessionId: string; message: SDKMessage };

	// Auth events (global events - use 'global' as sessionId)
	'auth.changed': {
		sessionId: string;
		method: AuthMethod;
		isAuthenticated: boolean;
	};

	// API connection events - internal server-side only (global events)
	'api.connection': { sessionId: string } & ApiConnectionState;

	// Settings events (global events - use 'global' as sessionId)
	'settings.updated': { sessionId: string; settings: GlobalSettings };
	'sessions.filterChanged': { sessionId: string };

	// Commands events
	'commands.updated': { sessionId: string; commands: string[] };

	// Context events - real-time context window usage tracking
	'context.updated': { sessionId: string; contextInfo: ContextInfo };

	// Compaction events
	'context.compacting': { sessionId: string; trigger: CompactionTrigger };
	'context.compacted': {
		sessionId: string;
		trigger: CompactionTrigger;
		preTokens: number;
	};

	// Session error events
	'session.error': { sessionId: string; error: string; details?: unknown };
	'session.errorClear': { sessionId: string };

	// Message events
	'message.sent': { sessionId: string };

	// Title generation events
	'title.generated': { sessionId: string; title: string };
	'title.generationFailed': {
		sessionId: string;
		error: Error;
		attempts: number;
	};

	// AskUserQuestion events
	'question.asked': {
		sessionId: string;
		pendingQuestion: PendingUserQuestion;
	};

	// User message processing events (3-layer communication pattern)
	'userMessage.persisted': {
		sessionId: string;
		messageId: string;
		messageContent: string | MessageContent[];
		userMessageText: string;
		needsWorkspaceInit: boolean;
		hasDraftToClear: boolean;
		skipQueryStart?: boolean;
	};

	// Model switch events
	'model.switchRequest': { sessionId: string; model: string };
	'model.switched': {
		sessionId: string;
		success: boolean;
		model: string;
		error?: string;
	};

	// Interrupt events
	'agent.interruptRequest': { sessionId: string };
	'agent.interrupted': { sessionId: string };

	// Reset events
	'agent.resetRequest': { sessionId: string; restartQuery?: boolean };
	'agent.reset': { sessionId: string; success: boolean; error?: string };

	// Message sending events
	'message.sendRequest': {
		sessionId: string;
		messageId: string;
		content: string;
		images?: MessageImage[];
	};
	'message.persisted': {
		sessionId: string;
		messageId: string;
		messageContent: string | MessageContent[];
		userMessageText: string;
		needsWorkspaceInit: boolean;
		hasDraftToClear: boolean;
	};

	// Query mode events
	// Trigger to send saved messages (Manual mode)
	'query.trigger': { sessionId: string };
	// Notification when message statuses change
	'messages.statusChanged': {
		sessionId: string;
		messageIds: string[];
		status: 'saved' | 'queued' | 'sent';
	};
	// Send queued messages on turn end (Auto-queue mode)
	'query.sendQueuedOnTurnEnd': { sessionId: string };

	// Rewind events
	'rewind.started': {
		sessionId: string;
		checkpointId: string;
		mode: RewindMode;
	};
	'rewind.completed': {
		sessionId: string;
		checkpointId: string;
		mode: RewindMode;
		result: RewindResult;
	};
	'rewind.failed': {
		sessionId: string;
		checkpointId: string;
		mode: RewindMode;
		error: string;
	};

	// Room events (global events - use 'global' as sessionId)
	'room.created': { sessionId: string; roomId: string; room: Room };
	'room.updated': { sessionId: string; roomId: string; room?: Partial<Room> };
	'room.archived': { sessionId: string; roomId: string };

	// Room channel events (emitted to room:${roomId} channel via sessionId)
	// UI subscribes to these for real-time updates
	// sessionId is set to 'room:${roomId}' for channel routing
	'room.overview': {
		sessionId: string; // 'room:${roomId}' for channel routing
		room: Room;
		sessions: { id: string; title: string; status: string; lastActiveAt: number }[];
		activeTasks: TaskSummary[];
	};
	'room.task.update': {
		sessionId: string; // 'room:${roomId}' for channel routing
		roomId: string;
		task: NeoTask;
	};

	// Legacy task events (kept for backward compatibility)
	'task.created': { sessionId: string; roomId: string; taskId: string; task: NeoTask };
	'task.updated': {
		sessionId: string;
		roomId: string;
		taskId: string;
		task?: Partial<NeoTask>;
	};

	// Room message events (for Neo chat functionality)
	'room.message': {
		sessionId: string;
		roomId: string;
		message: {
			id: string;
			role: string;
			content: string;
			timestamp: number;
		};
		sender?: string;
	};

	// Session bridge events (for dual-session architecture)
	'bridge.workerTerminal': {
		sessionId: string;
		pairId: string;
		agentState: AgentProcessingState;
	};
	'bridge.managerTerminal': {
		sessionId: string;
		pairId: string;
		agentState: AgentProcessingState;
	};
	'bridge.messagesForwarded': {
		sessionId: string;
		pairId: string;
		direction: 'worker-to-manager' | 'manager-to-worker';
		count: number;
	};

	// Session pair events (for manager-worker coordination)
	'pair.task_completed': {
		sessionId: string;
		pairId: string;
		taskId: string;
		summary: string;
		filesChanged?: string[];
		nextSteps?: string[];
	};
}

/**
 * Create a new DaemonHub instance
 * Each component that needs event coordination should use this
 */
export function createDaemonHub(name: string = 'daemon'): TypedHub<DaemonEventMap> {
	return new TypedHub<DaemonEventMap>({ name });
}

/**
 * Type alias for cleaner imports
 */
export type DaemonHub = TypedHub<DaemonEventMap>;
