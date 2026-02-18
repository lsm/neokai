/**
 * Lobby Agent Types
 *
 * Defines types for the Lobby Agent pattern - a generalized system for
 * processing external messages from any source (GitHub, Slack, Email, etc.)
 *
 * The Lobby Agent:
 * 1. Receives normalized external messages
 * 2. Performs security checks
 * 3. Routes messages to appropriate rooms or inbox
 * 4. Makes it easy to add new sources
 */

/**
 * Supported external message sources
 */
export type ExternalSource =
	| 'github' // GitHub webhooks and polling
	| 'slack' // Slack app mentions and messages
	| 'discord' // Discord bot messages
	| 'email' // Email inbound
	| 'webhook' // Generic webhook
	| 'api' // Direct API call
	| 'schedule'; // Scheduled/recurring trigger

/**
 * Normalized external message from any source
 */
export interface ExternalMessage {
	/** Unique identifier for this message */
	id: string;
	/** Source type */
	source: ExternalSource;
	/** Timestamp when message was received */
	timestamp: number;
	/** Author/sender information */
	sender: {
		/** Username or display name */
		name: string;
		/** Unique identifier for the sender (e.g., GitHub username, Slack user ID) */
		id?: string;
		/** Email if available */
		email?: string;
		/** Avatar URL if available */
		avatarUrl?: string;
	};
	/** Message content */
	content: {
		/** Title or subject */
		title?: string;
		/** Main body/text */
		body: string;
		/** HTML content if available */
		html?: string;
		/** Labels, tags, or categories */
		labels?: string[];
		/** URLs mentioned in the message */
		links?: string[];
	};
	/** Source-specific metadata */
	metadata: Record<string, unknown>;
	/** Repository or channel context (if applicable) */
	context?: {
		/** Repository name (e.g., "owner/repo") */
		repository?: string;
		/** Channel name */
		channel?: string;
		/** Thread or conversation ID */
		threadId?: string;
		/** Issue/PR/discussion number */
		number?: number;
		/** Event type (e.g., "issue_opened", "pr_merged") */
		eventType?: string;
		/** Action (e.g., "opened", "closed", "commented") */
		action?: string;
	};
	/** For replies/responses */
	replyTo?: {
		/** Original message ID */
		messageId: string;
		/** Thread or conversation ID */
		threadId?: string;
	};
}

/**
 * Security check result for external messages
 */
export interface ExternalSecurityCheck {
	/** Whether the message passed security checks */
	passed: boolean;
	/** Risk level assessment */
	riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
	/** Reason if failed */
	reason?: string;
	/** Specific indicators detected */
	indicators?: string[];
	/** Whether to quarantine the message */
	quarantine?: boolean;
}

/**
 * Routing decision for external messages
 */
export type RoutingDecision =
	| 'route' // Route to a specific room
	| 'inbox' // Send to inbox for manual triage
	| 'reject'; // Reject the message

/**
 * Routing result for external messages
 */
export interface ExternalRoutingResult {
	/** The routing decision */
	decision: RoutingDecision;
	/** Target room ID if routing */
	roomId?: string;
	/** Confidence level of the decision */
	confidence: 'high' | 'medium' | 'low';
	/** Reason for the decision */
	reason: string;
	/** Security check result */
	securityCheck: ExternalSecurityCheck;
	/** Suggested labels to apply */
	suggestedLabels?: string[];
	/** Suggested priority */
	suggestedPriority?: 'low' | 'normal' | 'high' | 'urgent';
}

/**
 * Candidate room for routing
 */
export interface RoutingCandidate {
	/** Room ID */
	roomId: string;
	/** Room name */
	roomName: string;
	/** Room description */
	description?: string;
	/** Repositories this room handles */
	repositories: string[];
	/** Channels this room handles */
	channels?: string[];
	/** Priority (higher = more specific match) */
	priority: number;
	/** Tags/labels this room is interested in */
	interestedLabels?: string[];
}

/**
 * External source adapter interface
 *
 * Implement this interface to add support for new external sources.
 */
export interface ExternalSourceAdapter {
	/** Source type identifier */
	readonly sourceType: ExternalSource;

	/** Human-readable name */
	readonly name: string;

	/**
	 * Initialize the adapter
	 * Called when the Lobby Agent starts
	 */
	start(): Promise<void>;

	/**
	 * Stop the adapter
	 * Called when the Lobby Agent stops
	 */
	stop(): Promise<void>;

	/**
	 * Check if the adapter is healthy
	 */
	isHealthy(): boolean;

	/**
	 * Get source-specific statistics
	 */
	getStats(): Record<string, number | string>;
}

/**
 * Callback for when an external message is received
 */
export type ExternalMessageCallback = (message: ExternalMessage) => Promise<void>;

/**
 * Lobby Agent configuration
 */
export interface LobbyAgentConfig {
	/** Enable security checking */
	enableSecurityCheck: boolean;
	/** Enable AI-powered routing */
	enableAiRouting: boolean;
	/** Default confidence threshold for auto-routing */
	routingConfidenceThreshold: 'high' | 'medium' | 'low';
	/** Maximum messages to process concurrently */
	maxConcurrentProcessing: number;
	/** Timeout for processing each message (ms) */
	processingTimeoutMs: number;
}

/**
 * Default lobby agent configuration
 */
export const DEFAULT_LOBBY_AGENT_CONFIG: LobbyAgentConfig = {
	enableSecurityCheck: true,
	enableAiRouting: true,
	routingConfidenceThreshold: 'medium',
	maxConcurrentProcessing: 10,
	processingTimeoutMs: 30000,
};

/**
 * Lobby Agent statistics
 */
export interface LobbyAgentStats {
	/** Total messages received */
	messagesReceived: number;
	/** Messages routed to rooms */
	messagesRouted: number;
	/** Messages sent to inbox */
	messagesToInbox: number;
	/** Messages rejected */
	messagesRejected: number;
	/** Messages that failed security */
	messagesSecurityFailed: number;
	/** Average processing time (ms) */
	averageProcessingTimeMs: number;
	/** Active adapters */
	activeAdapters: string[];
}
