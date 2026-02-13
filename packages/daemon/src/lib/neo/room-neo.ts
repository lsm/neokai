/**
 * RoomNeo - The main Room-Neo class with the AI loop
 *
 * Handles:
 * - Receiving messages from humans or system events
 * - Processing messages with Claude SDK
 * - Parsing actions from Neo's response
 * - Executing actions and broadcasting state changes
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Database as BunDatabase } from 'bun:sqlite';
import { Logger } from '../logger';
import { resolveSDKCliPath, isBundledBinary } from '../agent/sdk-cli-resolver';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import { NeoContextManager } from './neo-context-manager';
import { NeoMemoryManager } from './neo-memory-manager';
import { NeoTaskManager } from './neo-task-manager';
import { NeoRoomRepository } from '../../storage/repositories/room-repository';
import { buildRoomPrompt, parseNeoActions, type NeoAction } from './neo-prompt';
import type {
	Room,
	NeoStatus,
	NeoContextMessage,
	SessionSummary,
	TaskSummary,
	NeoContextStatus,
} from '@neokai/shared';

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
 */
export class RoomNeo {
	private contextManager: NeoContextManager;
	private memoryManager: NeoMemoryManager;
	private taskManager: NeoTaskManager;
	private roomRepo: NeoRoomRepository;
	private logger: Logger;
	private room: Room | null = null;
	private currentQuery: Query | null = null;
	private isProcessing = false;
	private config: Required<RoomNeoConfig>;

	constructor(
		private roomId: string,
		private daemonHub: DaemonHub,
		private db: Database,
		config: RoomNeoConfig = {}
	) {
		this.config = {
			model: config.model ?? 'claude-sonnet-4-5-20250929',
			maxContextTokens: config.maxContextTokens ?? 150000,
			workspacePath: config.workspacePath ?? process.cwd(),
		};

		// Use raw db for managers
		const rawDb = (db as unknown as { db: BunDatabase }).db;
		this.contextManager = new NeoContextManager(rawDb, roomId);
		this.memoryManager = new NeoMemoryManager(rawDb, roomId);
		this.taskManager = new NeoTaskManager(rawDb, roomId);
		this.roomRepo = new NeoRoomRepository(rawDb);
		this.logger = new Logger(`room-neo:${roomId.slice(0, 8)}`);
	}

	/**
	 * Initialize the RoomNeo instance
	 */
	async initialize(): Promise<void> {
		this.room = this.roomRepo.getRoom(this.roomId);
		if (!this.room) {
			throw new Error(`Room not found: ${this.roomId}`);
		}

		// Ensure context exists
		await this.contextManager.getContext();
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
			// Load room if not loaded
			if (!this.room) {
				this.room = this.roomRepo.getRoom(this.roomId);
				if (!this.room) {
					throw new Error(`Room not found: ${this.roomId}`);
				}
			}

			// Add user message to context
			await this.contextManager.addMessage('user', content, {
				sessionId: metadata?.sessionId,
				taskId: metadata?.taskId,
			});

			// Update status to thinking
			await this.contextManager.updateStatus('thinking');
			await this.broadcastStatus('thinking');

			// Process with SDK
			await this.processWithSDK(content, metadata);
		} catch (error) {
			this.logger.error('Error processing message:', error);

			// Add error to context
			const errorMessage = error instanceof Error ? error.message : String(error);
			await this.contextManager.addMessage('assistant', `[Error] ${errorMessage}`);

			// Broadcast error
			await this.broadcastError(errorMessage);
		} finally {
			this.isProcessing = false;
			await this.contextManager.updateStatus('idle');
			await this.broadcastStatus('idle');
		}
	}

	/**
	 * Get current status
	 */
	getStatus(): NeoStatus {
		return {
			roomId: this.roomId,
			contextStatus: 'idle',
			activeTaskCount: 0,
			memoryCount: 0,
		};
	}

	/**
	 * Get conversation history
	 */
	async getHistory(limit?: number): Promise<NeoContextMessage[]> {
		return this.contextManager.getRecentMessages(limit);
	}

	/**
	 * Get the context manager
	 */
	getContextManager(): NeoContextManager {
		return this.contextManager;
	}

	/**
	 * Get the memory manager
	 */
	getMemoryManager(): NeoMemoryManager {
		return this.memoryManager;
	}

	/**
	 * Get the task manager
	 */
	getTaskManager(): NeoTaskManager {
		return this.taskManager;
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
		await this.contextManager.updateStatus('idle');
		await this.broadcastStatus('idle');
	}

	/**
	 * Process message with Claude SDK
	 */
	private async processWithSDK(userMessage: string, metadata?: MessageMetadata): Promise<void> {
		if (!this.room) {
			throw new Error('Room not initialized');
		}

		// Build system prompt
		const systemPrompt = await this.buildSystemPrompt();

		// Get conversation history
		const history = await this.contextManager.getRecentMessages(50);

		// Build the prompt with history
		const prompt = this.buildPrompt(systemPrompt, history, userMessage);

		// Create query
		this.currentQuery = query({
			prompt,
			options: {
				model: this.config.model,
				cwd: this.config.workspacePath,
				maxTurns: 1, // Single response for Neo
				pathToClaudeCodeExecutable: resolveSDKCliPath(),
				executable: isBundledBinary() ? 'bun' : undefined,
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

		// Get sessions for this room
		const sessions: SessionSummary[] = this.room.sessionIds.map((id) => ({
			id,
			title: `Session ${id.slice(0, 8)}`,
			status: 'active',
			lastActiveAt: Date.now(),
		}));

		// Get tasks for this room
		const tasks = await this.taskManager.listTasks();
		const taskSummaries: TaskSummary[] = tasks.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			priority: t.priority,
			progress: t.progress,
		}));

		return buildRoomPrompt(this.room, sessions, taskSummaries);
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
		// Add response to context
		await this.contextManager.addMessage('assistant', response, {
			sessionId: metadata?.sessionId,
			taskId: metadata?.taskId,
		});

		// Parse actions
		const actions = parseNeoActions(response);

		// Execute actions
		for (const action of actions) {
			try {
				await this.executeAction(action);
			} catch (error) {
				this.logger.error(`Error executing action ${action.type}:`, error);
			}
		}

		// Broadcast the response
		await this.broadcastResponse(response, actions);
	}

	/**
	 * Execute a parsed action
	 */
	private async executeAction(action: NeoAction): Promise<void> {
		switch (action.type) {
			case 'create_task': {
				const task = await this.taskManager.createTask({
					title: action.params.title || 'Untitled Task',
					description: action.params.description || '',
					priority: (action.params.priority as 'low' | 'normal' | 'high' | 'urgent') || 'normal',
				});

				// Broadcast task creation
				await this.daemonHub.emit('task.created', {
					sessionId: 'global',
					roomId: this.roomId,
					taskId: task.id,
					task,
				});

				this.logger.info(`Created task: ${task.id}`);
				break;
			}

			case 'add_memory': {
				const memory = await this.memoryManager.addMemory({
					type:
						(action.params.type as
							| 'conversation'
							| 'task_result'
							| 'preference'
							| 'pattern'
							| 'note') || 'note',
					content: action.params.content || '',
					tags: action.params.tags?.split(',').map((t) => t.trim()) || [],
					importance: (action.params.importance as 'low' | 'normal' | 'high') || 'normal',
				});

				this.logger.info(`Added memory: ${memory.id}`);
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

	/**
	 * Broadcast status update
	 */
	private async broadcastStatus(_status: NeoContextStatus): Promise<void> {
		await this.daemonHub.emit('room.updated', {
			sessionId: 'global',
			roomId: this.roomId,
			room: {
				neoContextId: this.room?.neoContextId,
			},
		});
	}

	/**
	 * Broadcast error
	 */
	private async broadcastError(error: string): Promise<void> {
		this.logger.error(`Broadcasting error: ${error}`);
		// Error is already added to context, status broadcast will handle UI update
	}

	/**
	 * Broadcast response
	 */
	private async broadcastResponse(response: string, actions: NeoAction[]): Promise<void> {
		// The response is already in context, which clients can query
		// Actions have already been executed and broadcast individually
		this.logger.debug(`Response broadcast: ${actions.length} actions executed`);
	}
}
