/**
 * RoomNeo - The main Room-Neo class with the AI loop
 *
 * This version uses MessageHub RPC to communicate with the daemon,
 * making it a true daemon client instead of an internal module.
 *
 * Handles:
 * - Receiving messages from humans or system events
 * - Processing messages with Claude SDK
 * - Executing room operations through native MCP tool-calling
 * - Creating and managing worker sessions
 * - Watching session state changes
 */

import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type {
	MessageHub,
	Room,
	RoomOverview,
	NeoContextMessage,
	SessionSummary,
	TaskSummary,
	NeoContextStatus,
	SessionState,
	PendingUserQuestion,
} from '@neokai/shared';
import { Logger } from '@neokai/shared';
import { buildRoomPrompt } from '@neokai/shared/neo-prompt';
import { z } from 'zod';
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
	private roomOpsMcpServer: ReturnType<typeof createSdkMcpServer>;

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
		this.roomOpsMcpServer = this.createRoomOpsMcpServer();
	}

	private createRoomOpsMcpServer() {
		return createSdkMcpServer({
			name: `room-ops-${this.roomId.slice(0, 8)}`,
			tools: [
				tool(
					'room_create_session',
					'Create a new worker session in this room',
					{
						workspacePath: z.string().optional(),
						model: z.string().optional(),
						title: z.string().optional(),
					},
					async (args) => {
						const sessionId = await this.createSession({
							workspacePath: args.workspacePath,
							model: args.model,
							title: args.title,
						});

						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({ sessionId }),
								},
							],
						};
					}
				),
				tool(
					'room_create_task',
					'Create a task in this room',
					{
						title: z.string(),
						description: z.string().optional(),
						priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
						dependsOn: z.array(z.string()).optional(),
					},
					async (args) => {
						const { task } = await this.hub.request<{ task: { id: string; status: string } }>(
							'task.create',
							{
								roomId: this.roomId,
								title: args.title,
								description: args.description ?? '',
								priority: args.priority,
								dependsOn: args.dependsOn,
							}
						);

						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({ taskId: task.id, status: task.status }),
								},
							],
						};
					}
				),
				tool(
					'room_assign_task',
					'Assign a task to a worker session and start execution',
					{
						taskId: z.string(),
						sessionId: z.string(),
					},
					async (args) => {
						const { task } = await this.hub.request<{
							task: { id: string; status: string; sessionId?: string };
						}>('task.start', {
							roomId: this.roomId,
							taskId: args.taskId,
							sessionId: args.sessionId,
						});

						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({
										taskId: task.id,
										status: task.status,
										sessionId: task.sessionId,
									}),
								},
							],
						};
					}
				),
				tool(
					'room_send_session_message',
					'Send an instruction message to a worker session',
					{
						sessionId: z.string(),
						content: z.string(),
					},
					async (args) => {
						await this.sendToSession(args.sessionId, args.content);
						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({ sent: true, sessionId: args.sessionId }),
								},
							],
						};
					}
				),
				tool(
					'room_add_memory',
					'Store important memory for this room',
					{
						type: z.enum(['conversation', 'task_result', 'preference', 'pattern', 'note']),
						content: z.string(),
						tags: z.array(z.string()).optional(),
						importance: z.enum(['low', 'normal', 'high']).optional(),
					},
					async (args) => {
						const { memory } = await this.hub.request<{ memory: { id: string } }>('memory.add', {
							roomId: this.roomId,
							type: args.type,
							content: args.content,
							tags: args.tags ?? [],
							importance: args.importance ?? 'normal',
						});

						return {
							content: [
								{
									type: 'text',
									text: JSON.stringify({ memoryId: memory.id }),
								},
							],
						};
					}
				),
			],
		});
	}

	/**
	 * Initialize the RoomNeo instance
	 */
	async initialize(): Promise<void> {
		// Fetch room data via RPC - room.get returns RoomOverview directly
		const overview = await this.hub.request<RoomOverview>('room.get', { roomId: this.roomId });
		this.room = overview.room;

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
				const overview = await this.hub.request<RoomOverview>('room.get', {
					roomId: this.roomId,
				});
				this.room = overview.room;
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
	 * Select workspace path from room's allowed paths
	 *
	 * Priority:
	 * 1. Explicitly requested path (if valid)
	 * 2. Room's default path
	 * 3. First allowed path
	 */
	private selectWorkspacePath(requestedPath?: string): string {
		if (!this.room) {
			throw new Error('Room not initialized');
		}

		// If specific path requested, validate it
		if (requestedPath) {
			if (this.room.allowedPaths.includes(requestedPath)) {
				return requestedPath;
			}
			throw new Error(`Path "${requestedPath}" is not allowed in this room`);
		}

		// Use room's default path if available and valid
		if (this.room.defaultPath && this.room.allowedPaths.includes(this.room.defaultPath)) {
			return this.room.defaultPath;
		}

		// Fall back to first allowed path
		if (this.room.allowedPaths.length > 0) {
			return this.room.allowedPaths[0];
		}

		throw new Error('No allowed paths configured for this room');
	}

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
		const selectedPath = this.selectWorkspacePath(params.workspacePath);

		const response = await this.hub.request<{ sessionId: string }>('session.create', {
			workspacePath: selectedPath,
			title: params.title ?? `Worker session for room ${this.roomId.slice(0, 8)}`,
			config: {
				model: params.model ?? this.config.model,
			},
			roomId: this.roomId,
			createdBy: 'neo',
		});

		const sessionId = response.sessionId;

		// Start watching the session
		await this.sessionWatcher.watchSession(sessionId);
		this.watchedSessions.add(sessionId);

		this.logger.info(
			`Created and watching worker session: ${sessionId} in workspace: ${selectedPath}`
		);
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
				maxTurns: 8,
				// Neo is an orchestrator: expose room operations as MCP tools and disable
				// built-in local execution tools.
				tools: [],
				mcpServers: {
					roomOps: this.roomOpsMcpServer,
				},
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

		// Room operations are executed via native SDK MCP tool-calling.
	}
}
