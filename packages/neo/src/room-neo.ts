/**
 * RoomNeo - The main Room-Neo class with the AI loop
 *
 * This version uses MessageHub RPC to communicate with the daemon,
 * making it a true daemon client instead of an internal module.
 *
 * Handles:
 * - Receiving messages from humans or system events
 * - Processing messages with Claude SDK
 * - Parsing actions from Neo's response
 * - Executing actions via RPC calls
 * - Creating and managing worker sessions
 * - Watching session state changes
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type {
	MessageHub,
	Room,
	NeoContextMessage,
	SessionSummary,
	TaskSummary,
	NeoContextStatus,
	SessionState,
	PendingUserQuestion,
} from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { buildRoomPrompt, parseNeoActions, type NeoAction } from '@neokai/shared/neo-prompt';
import { NeoSessionWatcher, type SessionEventHandlers } from './neo-session-watcher';

/**
 * Configuration for RoomNeo
 */
export interface RoomNeoConfig {
	/** Model to use for Neo (default: claude-sonnet-4-5-20250929) */
	model?: string;
	/** Maximum context tokens before compaction (default: 150000) */
	maxContextTokens?: number;
	/** Workspace path for Neo operations */
	workspacePath?: string;
}

/**
 * Message metadata for incoming messages
 */
export interface MessageMetadata {
	sessionId?: string;
	taskId?: string;
	source?: 'human' | 'system';
}

/**
 * RoomNeo - AI orchestrator for a single room
 *
 * Uses MessageHub RPC for all daemon communication.
 * Can create and manage worker sessions.
 */
export class RoomNeo {
	private logger: Logger;
	private room: Room | null = null;
	private currentQuery: Query | null = null;
	private isProcessing = false;
	private config: Required<RoomNeoConfig>;
	private messageHistory: NeoContextMessage[] = [];
	private sessionWatcher: NeoSessionWatcher;
	private watchedSessions: Set<string> = new Set();
	private roomMessageUnsubscribe: (() => void) | null = null;

	constructor(
		private roomId: string,
		private hub: MessageHub,
		config: RoomNeoConfig = {}
	) {
		this.config = {
			model: config.model ?? 'claude-sonnet-4-5-20250929',
			maxContextTokens: config.maxContextTokens ?? 150000,
			workspacePath: config.workspacePath ?? process.cwd(),
		};
		this.logger = new Logger(`room-neo:${roomId.slice(0, 8)}`);

		// Set up session event handlers
		const handlers: SessionEventHandlers = {
			onTurnCompleted: (sessionId, state) => this.handleTurnCompleted(sessionId, state),
			onWaitingForInput: (sessionId, question) => this.handleWaitingForInput(sessionId, question),
			onProcessing: (sessionId, phase) => this.handleProcessing(sessionId, phase),
			onError: (sessionId, error) => this.handleError(sessionId, error),
		};

		this.sessionWatcher = new NeoSessionWatcher(hub, handlers);
	}

	/**
	 * Initialize the RoomNeo instance
	 */
	async initialize(): Promise<void> {
		// Fetch room data via RPC
		const response = await this.hub.request<{ room: Room }>('room.get', { roomId: this.roomId });
		this.room = response.room;

		if (!this.room) {
			throw new Error(`Room not found: ${this.roomId}`);
		}

		// Load message history via RPC
		await this.loadHistory();

		// Join room channel to receive messages
		await this.hub.joinChannel(`room:${this.roomId}`);

		// Subscribe to room.message events
		this.roomMessageUnsubscribe = this.hub.onEvent('room.message', async (data: unknown) => {
			const eventData = data as {
				roomId: string;
				message: { content: string; role: string };
				sender?: string;
			};

			// Only process messages from humans, not our own
			if (eventData.roomId === this.roomId && eventData.sender === 'human') {
				try {
					await this.sendMessage(eventData.message.content);
				} catch (error) {
					this.logger.error('Error processing room.message event:', error);
				}
			}
		});
	}

	/**
	 * Load conversation history from daemon
	 */
	private async loadHistory(): Promise<void> {
		try {
			const response = await this.hub.request<{ messages: NeoContextMessage[] }>(
				'room.message.history',
				{ roomId: this.roomId }
			);
			this.messageHistory = response.messages ?? [];
		} catch (error) {
			this.logger.warn('Could not load message history:', error);
			this.messageHistory = [];
		}
	}

	/**
	 * Get the room data
	 */
	getRoom(): Room | null {
		return this.room;
	}

	/**
	 * Send message to Room-Neo (from human or event)
	 */
	async sendMessage(content: string, metadata?: MessageMetadata): Promise<void> {
		if (this.isProcessing) {
			this.logger.warn('Already processing a message, queueing not yet implemented');
			throw new Error('Neo is already processing a message');
		}

		this.isProcessing = true;

		try {
			// Reload room data
			if (!this.room) {
				const response = await this.hub.request<{ room: Room }>('room.get', {
					roomId: this.roomId,
				});
				this.room = response.room;
				if (!this.room) {
					throw new Error(`Room not found: ${this.roomId}`);
				}
			}

			// Add user message to local history
			const userMessage: NeoContextMessage = {
				id: `local-${Date.now()}`,
				contextId: this.room.contextId ?? '',
				role: 'user',
				content,
				timestamp: Date.now(),
				tokenCount: Math.ceil(content.length / 4),
				sessionId: metadata?.sessionId,
				taskId: metadata?.taskId,
			};
			this.messageHistory.push(userMessage);

			// Process with SDK
			await this.processWithSDK(content, metadata);
		} catch (error) {
			this.logger.error('Error processing message:', error);

			// Add error to history
			const errorMessage = error instanceof Error ? error.message : String(error);
			const assistantMessage: NeoContextMessage = {
				id: `local-${Date.now()}`,
				contextId: this.room?.contextId ?? '',
				role: 'assistant',
				content: `[Error] ${errorMessage}`,
				timestamp: Date.now(),
				tokenCount: 0,
			};
			this.messageHistory.push(assistantMessage);
		} finally {
			this.isProcessing = false;
		}
	}

	/**
	 * Get current status
	 */
	getStatus() {
		return {
			roomId: this.roomId,
			contextStatus: 'idle' as NeoContextStatus,
			activeTaskCount: 0,
			memoryCount: 0,
		};
	}

	/**
	 * Get conversation history
	 */
	async getHistory(limit?: number): Promise<NeoContextMessage[]> {
		if (limit && this.messageHistory.length > limit) {
			return this.messageHistory.slice(-limit);
		}
		return this.messageHistory;
	}

	/**
	 * Stop/interrupt current processing
	 */
	async interrupt(): Promise<void> {
		if (this.currentQuery) {
			try {
				await this.currentQuery.interrupt();
			} catch (error) {
				this.logger.warn('Error interrupting query:', error);
			}
			this.currentQuery = null;
		}

		this.isProcessing = false;
	}

	// ========================================
	// Worker Session Management
	// ========================================

	/**
	 * Create a worker session for this room
	 *
	 * Creates a new session, assigns it to this room, and starts watching it
	 */
	async createSession(params: {
		workspacePath?: string;
		model?: string;
		title?: string;
	}): Promise<string> {
		const response = await this.hub.request<{ sessionId: string }>('session.create', {
			workspacePath: params.workspacePath ?? this.config.workspacePath,
			title: params.title ?? `Worker session for room ${this.roomId.slice(0, 8)}`,
			config: {
				model: params.model ?? this.config.model,
			},
		});

		const sessionId = response.sessionId;

		// Assign session to this room
		await this.hub.request('room.assignSession', {
			roomId: this.roomId,
			sessionId,
		});

		// Start watching the session
		await this.sessionWatcher.watchSession(sessionId);
		this.watchedSessions.add(sessionId);

		this.logger.info(`Created and watching worker session: ${sessionId}`);
		return sessionId;
	}

	/**
	 * Send a message to a worker session
	 */
	async sendToSession(sessionId: string, content: string): Promise<void> {
		await this.hub.request('message.send', { sessionId, content });
		this.logger.debug(`Sent message to session ${sessionId}`);
	}

	/**
	 * Get list of watched session IDs
	 */
	getWatchedSessions(): string[] {
		return Array.from(this.watchedSessions);
	}

	// ========================================
	// Session Event Handlers
	// ========================================

	/**
	 * Handle turn completed event from a worker session
	 */
	private async handleTurnCompleted(sessionId: string, _state: SessionState): Promise<void> {
		this.logger.info(`Session ${sessionId} turn completed`);
		// Neo can react to turn completion:
		// - Check task progress
		// - Continue with next step
		// - Report to human
		// For now, just log it
	}

	/**
	 * Handle waiting for input event from a worker session
	 */
	private async handleWaitingForInput(
		sessionId: string,
		question: PendingUserQuestion
	): Promise<void> {
		this.logger.info(
			`Session ${sessionId} needs input:`,
			question.questions.map((q) => q.question).join(', ')
		);
		// Session needs input - Neo could:
		// 1. Respond automatically if it has context
		// 2. Ask the human for guidance
		// For MVP, we'll just log it
	}

	/**
	 * Handle processing event from a worker session
	 */
	private async handleProcessing(sessionId: string, phase: string): Promise<void> {
		this.logger.debug(`Session ${sessionId} processing (${phase})`);
		// Session is actively working - update internal state if needed
	}

	/**
	 * Handle error event from a worker session
	 */
	private async handleError(sessionId: string, error: { message: string }): Promise<void> {
		this.logger.error(`Session ${sessionId} error:`, error.message);
		// Session encountered an error - Neo could:
		// - Retry the operation
		// - Notify the human
		// - Create a new session
	}

	// ========================================
	// Cleanup
	// ========================================

	/**
	 * Clean up resources
	 */
	async destroy(): Promise<void> {
		// Unsubscribe from room.message events
		if (this.roomMessageUnsubscribe) {
			this.roomMessageUnsubscribe();
			this.roomMessageUnsubscribe = null;
		}

		// Leave room channel
		try {
			await this.hub.leaveChannel(`room:${this.roomId}`);
		} catch {
			// Ignore errors when leaving channel
		}

		// Stop watching all sessions
		await this.sessionWatcher.unwatchAll();
		this.watchedSessions.clear();

		// Interrupt any ongoing query
		await this.interrupt();

		this.logger.info(`RoomNeo destroyed for room ${this.roomId}`);
	}

	/**
	 * Process message with Claude SDK
	 */
	private async processWithSDK(userMessage: string, metadata?: MessageMetadata): Promise<void> {
		if (!this.room) {
			throw new Error('Room not initialized');
		}

		// Build system prompt with room context fetched via RPC
		const systemPrompt = await this.buildSystemPrompt();

		// Build the prompt with history
		const prompt = this.buildPrompt(systemPrompt, this.messageHistory, userMessage);

		// Create query
		this.currentQuery = query({
			prompt,
			options: {
				model: this.config.model,
				cwd: this.config.workspacePath,
				maxTurns: 1, // Single response for Neo
			},
		});

		try {
			// Collect response
			let responseText = '';

			for await (const message of this.currentQuery) {
				const msg = message as {
					type: string;
					message?: { content: string | Array<{ type: string; text?: string }> };
				};

				if (msg.type === 'assistant' && msg.message) {
					const content = msg.message.content;
					if (typeof content === 'string') {
						responseText += content;
					} else if (Array.isArray(content)) {
						for (const block of content) {
							if (block.type === 'text' && block.text) {
								responseText += block.text;
							}
						}
					}
				}
			}

			// Handle response
			await this.handleResponse(responseText, metadata);
		} finally {
			this.currentQuery = null;
		}
	}

	/**
	 * Build system prompt for Room-Neo
	 */
	private async buildSystemPrompt(): Promise<string> {
		if (!this.room) {
			throw new Error('Room not initialized');
		}

		// Get room overview via RPC
		const overviewResponse = await this.hub.request<{
			overview: { room: Room; sessions: SessionSummary[]; activeTasks: TaskSummary[] };
		}>('room.overview', { roomId: this.roomId });

		const overview = overviewResponse.overview;

		return buildRoomPrompt(overview.room, overview.sessions, overview.activeTasks);
	}

	/**
	 * Build the full prompt with history
	 */
	private buildPrompt(
		systemPrompt: string,
		history: NeoContextMessage[],
		userMessage: string
	): string {
		let prompt = systemPrompt + '\n\n';

		// Add conversation history
		if (history.length > 0) {
			prompt += '## Conversation History\n\n';
			for (const msg of history) {
				const role = msg.role === 'user' ? 'Human' : msg.role === 'assistant' ? 'Neo' : 'System';
				prompt += `${role}: ${msg.content}\n\n`;
			}
		}

		// Add current message
		prompt += `## Current Message\n\nHuman: ${userMessage}`;

		return prompt;
	}

	/**
	 * Handle SDK response
	 */
	private async handleResponse(response: string, metadata?: MessageMetadata): Promise<void> {
		// Add response to local history
		const assistantMessage: NeoContextMessage = {
			id: `local-${Date.now()}`,
			contextId: this.room?.contextId ?? '',
			role: 'assistant',
			content: response,
			timestamp: Date.now(),
			tokenCount: Math.ceil(response.length / 4),
			sessionId: metadata?.sessionId,
			taskId: metadata?.taskId,
		};
		this.messageHistory.push(assistantMessage);

		// Broadcast response to room via RPC
		try {
			await this.hub.request('room.message.send', {
				roomId: this.roomId,
				content: response,
				role: 'assistant',
				sender: 'neo',
				metadata,
			});
		} catch (error) {
			this.logger.error('Error broadcasting Neo response:', error);
		}

		// Parse actions
		const actions = parseNeoActions(response);

		// Execute actions via RPC
		for (const action of actions) {
			try {
				await this.executeAction(action);
			} catch (error) {
				this.logger.error(`Error executing action ${action.type}:`, error);
			}
		}
	}

	/**
	 * Execute a parsed action via RPC
	 */
	private async executeAction(action: NeoAction): Promise<void> {
		switch (action.type) {
			case 'create_task': {
				await this.hub.request('task.create', {
					roomId: this.roomId,
					title: action.params.title || 'Untitled Task',
					description: action.params.description || '',
					priority: action.params.priority || 'normal',
				});
				this.logger.info(`Created task via RPC`);
				break;
			}

			case 'add_memory': {
				await this.hub.request('memory.add', {
					roomId: this.roomId,
					type: action.params.type || 'note',
					content: action.params.content || '',
					tags: action.params.tags?.split(',').map((t: string) => t.trim()) || [],
					importance: action.params.importance || 'normal',
				});
				this.logger.info(`Added memory via RPC`);
				break;
			}

			case 'report_status': {
				this.logger.info(`Status report: ${action.params.message}`);
				break;
			}

			default:
				this.logger.warn(`Unknown action type: ${action.type}`);
		}
	}
}
