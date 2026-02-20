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
	'room.deleted': { sessionId: string; roomId: string };
	'room.contextUpdated': {
		sessionId: string;
		roomId: string;
		changes: {
			background?: string;
			instructions?: string;
		};
	};
	'room.contextRolledBack': {
		sessionId: string;
		roomId: string;
		rolledBackToVersion: number;
		newVersion: number;
	};

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

	// Lobby events (for lobby manager chat)
	'lobby.message': {
		sessionId: string;
		message: {
			id: string;
			role: 'user' | 'assistant';
			content: string;
			images?: MessageImage[];
			timestamp: string;
		};
	};

	// GitHub integration events
	'github.roomMappingUpdated': {
		sessionId: string;
		roomId: string;
		mapping: import('@neokai/shared').RoomGitHubMapping;
	};
	'github.roomMappingDeleted': {
		sessionId: string;
		roomId: string;
	};
	'github.inboxItemRouted': {
		sessionId: string;
		item: import('@neokai/shared').InboxItem;
		roomId: string;
	};
	'github.inboxItemDismissed': {
		sessionId: string;
		itemId: string;
	};
	'github.filterConfigUpdated': {
		sessionId: string;
		repository?: string;
		config: import('@neokai/shared').GitHubFilterConfig;
	};
	'github.eventReceived': {
		sessionId: string;
		event: import('./github/types').GitHubEvent;
	};
	'github.eventFiltered': {
		sessionId: string;
		eventId: string;
		reason?: string;
	};
	'github.eventSecurityFailed': {
		sessionId: string;
		eventId: string;
		securityResult: import('@neokai/shared').SecurityCheckResult;
	};
	'github.eventRouted': {
		sessionId: string;
		eventId: string;
		roomId: string;
		confidence: 'high' | 'medium' | 'low';
		reason: string;
	};
	'github.inboxItemAdded': {
		sessionId: string;
		item: import('@neokai/shared').InboxItem;
		reason: string;
	};
	'github.eventError': {
		sessionId: string;
		eventId: string;
		error: string;
		inboxItemId: string;
	};

	// Goal events
	'goal.created': {
		sessionId: string;
		roomId: string;
		goalId: string;
		goal: import('@neokai/shared').RoomGoal;
	};
	'goal.updated': {
		sessionId: string;
		roomId: string;
		goalId: string;
		goal?: Partial<import('@neokai/shared').RoomGoal>;
	};
	'goal.progressUpdated': {
		sessionId: string;
		roomId: string;
		goalId: string;
		progress: number;
	};
	'goal.completed': {
		sessionId: string;
		roomId: string;
		goalId: string;
		goal: import('@neokai/shared').RoomGoal;
	};

	// Recurring job events
	'recurringJob.created': {
		sessionId: string;
		roomId: string;
		jobId: string;
		job: import('@neokai/shared').RecurringJob;
	};
	'recurringJob.updated': {
		sessionId: string;
		roomId: string;
		jobId: string;
		job?: Partial<import('@neokai/shared').RecurringJob>;
	};
	'recurringJob.triggered': {
		sessionId: string;
		roomId: string;
		jobId: string;
		taskId: string;
		timestamp: number;
	};
	'recurringJob.completed': {
		sessionId: string;
		roomId: string;
		jobId: string;
		taskId: string;
	};
	'recurringJob.enabled': {
		sessionId: string;
		roomId: string;
		jobId: string;
	};
	'recurringJob.disabled': {
		sessionId: string;
		roomId: string;
		jobId: string;
	};
	'recurringJob.deleted': {
		sessionId: string;
		roomId: string;
		jobId: string;
	};

	// Room agent lifecycle events
	'roomAgent.stateChanged': {
		sessionId: string;
		roomId: string;
		previousState: import('@neokai/shared').RoomAgentLifecycleState;
		newState: import('@neokai/shared').RoomAgentLifecycleState;
		reason?: string;
	};
	'roomAgent.hook': {
		sessionId: string;
		roomId: string;
		event: import('@neokai/shared').ManagerHookEvent;
		payload: import('@neokai/shared').ManagerHookPayload;
	};
	'roomAgent.error': {
		sessionId: string;
		roomId: string;
		error: string;
		errorCount: number;
	};
	'roomAgent.idle': {
		sessionId: string;
		roomId: string;
		hasPendingTasks: boolean;
		hasIncompleteGoals: boolean;
	};
	'roomAgent.reviewReceived': {
		sessionId: string;
		roomId: string;
		taskId: string;
		approved: boolean;
		response: string;
	};
	'roomAgent.escalationResolved': {
		sessionId: string;
		roomId: string;
		escalationId: string;
		response: string;
	};
	'roomAgent.questionAnswered': {
		sessionId: string;
		roomId: string;
		questionId: string;
		responses: Record<string, string | string[]>;
	};

	// Multi-session task events
	'task.sessionStarted': {
		sessionId: string;
		roomId: string;
		taskId: string;
		taskSessionId: string;
		role: 'primary' | 'secondary' | 'reviewer';
	};
	'task.sessionCompleted': {
		sessionId: string;
		roomId: string;
		taskId: string;
		taskSessionId: string;
		role: 'primary' | 'secondary' | 'reviewer';
		result?: string;
	};
	'task.allSessionsCompleted': {
		sessionId: string;
		roomId: string;
		taskId: string;
	};

	// Lobby Agent events (for external message processing)
	'lobby.messageReceived': {
		sessionId: string;
		message: import('./lobby/types').ExternalMessage;
	};
	'lobby.messageRouted': {
		sessionId: string;
		messageId: string;
		roomId: string;
		confidence: 'high' | 'medium' | 'low';
		reason: string;
	};
	'lobby.messageToInbox': {
		sessionId: string;
		messageId: string;
		reason: string;
	};
	'lobby.messageRejected': {
		sessionId: string;
		messageId: string;
		reason: string;
	};
	'lobby.messageSecurityFailed': {
		sessionId: string;
		messageId: string;
		securityCheck: import('./lobby/types').ExternalSecurityCheck;
	};

	// Prompt Template events
	'promptTemplate.updated': {
		sessionId: string;
		templateId: string;
		version: number;
	};
	'promptTemplate.deleted': {
		sessionId: string;
		templateId: string;
	};
	'promptTemplate.roomUpdated': {
		sessionId: string;
		roomId: string;
		templateId: string;
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
