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
	MessageDeliveryMode,
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

	// SDK events — message may include a neokai-injected `timestamp` field from the DB layer
	'sdk.message': { sessionId: string; message: SDKMessage & { timestamp?: number } };

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

	// API retry events
	'session.retryAttempt': {
		sessionId: string;
		attempt: number;
		max_retries: number;
		delay_ms: number;
		error_status: number | null;
		error: string;
	};

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
	'model.switchRequest': { sessionId: string; model: string; provider: string };
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
		deliveryMode?: MessageDeliveryMode;
	};
	'message.persisted': {
		sessionId: string;
		messageId: string;
		messageContent: string | MessageContent[];
		userMessageText: string;
		needsWorkspaceInit: boolean;
		hasDraftToClear: boolean;
		sendStatus: 'saved' | 'queued' | 'sent';
		deliveryMode: MessageDeliveryMode;
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
	// Room channel events (emitted to room:${roomId} channel via sessionId)
	// UI subscribes to these for real-time updates
	// sessionId is set to 'room:${roomId}' for channel routing
	'room.overview': {
		sessionId: string; // 'room:${roomId}' for channel routing
		room: Room;
		sessions: { id: string; title: string; status: string; lastActiveAt: number }[];
		activeTasks: TaskSummary[];
		allTasks?: TaskSummary[];
	};
	'room.runtime.stateChanged': {
		sessionId: string; // 'room:${roomId}' for channel routing
		roomId: string;
		state: import('@neokai/shared').RuntimeState;
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

	// Room message events (for room chat)
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

	// Worker events (Manager-less Architecture v1.0)
	'worker.started': {
		sessionId: string;
		roomId: string;
		taskId: string;
	};
	'worker.task_completed': {
		sessionId: string;
		taskId: string;
		summary: string;
		filesChanged?: string[];
		nextSteps?: string[];
	};
	'worker.review_requested': {
		sessionId: string;
		taskId: string;
		reason: string;
	};
	'worker.failed': {
		sessionId: string;
		taskId: string;
		error: string;
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
	/** Emitted when a coder/general task completes without human review (semi-autonomous mode) */
	'goal.task.auto_completed': {
		sessionId: string; // 'room:${roomId}' for channel routing
		roomId: string;
		goalId: string;
		taskId: string;
		taskTitle: string;
		prUrl: string;
		approvalSource: 'leader_semi_auto';
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

	// Space events (global events - use 'global' as sessionId)
	'space.created': { sessionId: string; spaceId: string; space: import('@neokai/shared').Space };
	'space.updated': {
		sessionId: string;
		spaceId: string;
		space?: Partial<import('@neokai/shared').Space>;
	};
	'space.archived': { sessionId: string; spaceId: string; space: import('@neokai/shared').Space };
	'space.deleted': { sessionId: string; spaceId: string };

	// Space task events (global events - use 'global' as sessionId)
	'space.task.created': {
		sessionId: string;
		spaceId: string;
		taskId: string;
		task: import('@neokai/shared').SpaceTask;
	};
	'space.task.updated': {
		sessionId: string;
		spaceId: string;
		taskId: string;
		task: import('@neokai/shared').SpaceTask;
	};

	// Space Task Agent completion events (use 'global' as sessionId)
	/** Emitted by report_result when a Task Agent marks a task as completed. */
	'space.task.completed': {
		sessionId: string;
		taskId: string;
		spaceId: string;
		status: string;
		summary: string;
		workflowRunId: string;
		taskTitle: string;
	};
	/** Emitted by report_result when a Task Agent marks a task as needs_attention or cancelled. */
	'space.task.failed': {
		sessionId: string;
		taskId: string;
		spaceId: string;
		status: string;
		summary: string;
		workflowRunId: string;
		taskTitle: string;
	};

	// Space workflow run events (global events - use 'global' as sessionId)
	'space.workflowRun.created': {
		sessionId: string;
		spaceId: string;
		runId: string;
		run: import('@neokai/shared').SpaceWorkflowRun;
	};
	'space.workflowRun.updated': {
		sessionId: string;
		spaceId: string;
		runId: string;
		run?: Partial<import('@neokai/shared').SpaceWorkflowRun>;
	};

	// Space Agent events (channel: 'space:${spaceId}')
	'spaceAgent.created': {
		sessionId: string;
		spaceId: string;
		agent: import('@neokai/shared').SpaceAgent;
	};
	'spaceAgent.updated': {
		sessionId: string;
		spaceId: string;
		agent: import('@neokai/shared').SpaceAgent;
	};
	'spaceAgent.deleted': {
		sessionId: string;
		spaceId: string;
		agentId: string;
	};

	// Space workflow definition events (global events - use 'global' as sessionId)
	// NOTE: namespace is 'spaceWorkflow.*' (not 'space.workflow.*') — matches SpaceStore subscriptions in M5
	'spaceWorkflow.created': {
		sessionId: string;
		spaceId: string;
		workflow: import('@neokai/shared').SpaceWorkflow;
	};
	'spaceWorkflow.updated': {
		sessionId: string;
		spaceId: string;
		workflow: import('@neokai/shared').SpaceWorkflow;
	};
	'spaceWorkflow.deleted': {
		sessionId: string;
		spaceId: string;
		workflowId: string;
	};

	// Feature Flag events (PHASE 3: Gradual rollout infrastructure)
	'featureFlag.updated': {
		sessionId: string;
		flagName: string;
		updates: { enabled?: boolean; rolloutPercentage?: number };
	};
	'featureFlag.rolloutChanged': {
		sessionId: string;
		flagName: string;
		percentage: number;
	};
	'featureFlag.roomWhitelisted': {
		sessionId: string;
		flagName: string;
		roomId: string;
	};
	'featureFlag.roomBlacklisted': {
		sessionId: string;
		flagName: string;
		roomId: string;
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
