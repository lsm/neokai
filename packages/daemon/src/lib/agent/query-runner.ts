/**
 * QueryRunner - Executes SDK queries with streaming input
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - Starting and running SDK queries with AsyncGenerator
 * - Abortable query iteration for interrupt support
 * - Message generation wrapper
 * - API error handling and display
 * - Provider environment variable management
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { UUID } from 'crypto';
import type { Session, MessageHub } from '@liuboer/shared';
import type { SDKMessage } from '@liuboer/shared/sdk';
import { generateUUID } from '@liuboer/shared';
import { isSDKSystemMessage } from '@liuboer/shared/sdk/type-guards';
import { Database } from '../../storage/database';
import { ErrorCategory, ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { QueryOptionsBuilder } from './query-options-builder';
import type { AskUserQuestionHandler } from './ask-user-question-handler';

const STARTUP_TIMEOUT_MS = 15000; // 15 seconds - enough for CI load

/**
 * Original environment variables for restoration after SDK query
 */
interface OriginalEnvVars {
	ANTHROPIC_AUTH_TOKEN?: string;
	ANTHROPIC_BASE_URL?: string;
	API_TIMEOUT_MS?: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
	ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
}

/**
 * Dependencies required for QueryRunner
 */
export interface QueryRunnerDependencies {
	session: Session;
	db: Database;
	messageHub: MessageHub;
	messageQueue: MessageQueue;
	stateManager: ProcessingStateManager;
	errorManager: ErrorManager;
	logger: Logger;
	optionsBuilder: QueryOptionsBuilder;
	askUserQuestionHandler: AskUserQuestionHandler;

	// Callbacks for state coordination with AgentSession
	getQueryGeneration: () => number;
	incrementQueryGeneration: () => number;
	getFirstMessageReceived: () => boolean;
	setFirstMessageReceived: (value: boolean) => void;
	setQueryObject: (q: Query | null) => void;
	setQueryPromise: (p: Promise<void> | null) => void;
	setQueryAbortController: (c: AbortController | null) => void;
	getQueryAbortController: () => AbortController | null;
	setStartupTimeoutTimer: (t: ReturnType<typeof setTimeout> | null) => void;
	getStartupTimeoutTimer: () => ReturnType<typeof setTimeout> | null;
	setOriginalEnvVars: (vars: OriginalEnvVars) => void;
	getOriginalEnvVars: () => OriginalEnvVars;
	isCleaningUp: () => boolean;

	// Callbacks for message handling
	onSDKMessage: (message: SDKMessage, queuedMessages?: SDKMessage[]) => Promise<void>;
	onSlashCommandsFetched: () => Promise<void>;
	onModelsFetched: () => Promise<void>;
	onMarkApiSuccess: () => Promise<void>;
}

/**
 * Runs SDK queries with streaming input mode
 */
export class QueryRunner {
	private deps: QueryRunnerDependencies;

	constructor(deps: QueryRunnerDependencies) {
		this.deps = deps;
	}

	/**
	 * Start the streaming query (called from AgentSession.startStreamingQuery)
	 */
	async start(): Promise<void> {
		const { messageQueue, logger } = this.deps;

		if (messageQueue.isRunning()) {
			logger.log('Query already running, skipping start');
			return;
		}

		logger.log('Starting streaming query...');
		messageQueue.start();

		// Increment query generation for this new query
		const currentGeneration = this.deps.incrementQueryGeneration();
		logger.log(`Starting query with generation ${currentGeneration}`);

		// Reset firstMessageReceived flag for new query
		this.deps.setFirstMessageReceived(false);
		logger.log('Reset firstMessageReceived flag for new query');

		// Store query promise for cleanup
		this.deps.setQueryPromise(this.runQuery(currentGeneration));
	}

	/**
	 * Run the query (main execution loop)
	 */
	private async runQuery(queryGeneration: number): Promise<void> {
		const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.deps;

		try {
			// Verify authentication
			const { getProviderService } = await import('../provider-service');
			const providerService = getProviderService();
			const { getProviderRegistry } = await import('../providers/factory.js');
			const providerRegistry = getProviderRegistry();

			const hasAnthropicAuth = !!(
				process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY
			);
			const hasGlmAuth = await providerService.isGlmAvailable();
			const hasAuth = hasAnthropicAuth || hasGlmAuth;

			if (!hasAuth) {
				const authError = new Error(
					'No authentication configured. Please set up API key for Anthropic or GLM.'
				);
				await errorManager.handleError(
					session.id,
					authError,
					ErrorCategory.AUTHENTICATION,
					undefined,
					stateManager.getState()
				);
				throw authError;
			}

			// Ensure workspace exists
			const fs = await import('fs/promises');
			await fs.mkdir(session.workspacePath, { recursive: true });

			logger.log('Creating streaming query with AsyncGenerator');
			logger.log(`SDK cwd (session.workspacePath): ${session.workspacePath}`);
			if (session.worktree) {
				logger.log(`Session uses worktree:`);
				logger.log(`  - Worktree path: ${session.worktree.worktreePath}`);
				logger.log(`  - Main repo: ${session.worktree.mainRepoPath}`);
				logger.log(`  - Branch: ${session.worktree.branch}`);
			} else {
				logger.log('Session uses shared workspace (no worktree)');
			}

			// Build query options
			optionsBuilder.setCanUseTool(this.deps.askUserQuestionHandler.createCanUseToolCallback());
			let queryOptions = await optionsBuilder.build();
			queryOptions = optionsBuilder.addSessionStateOptions(queryOptions);

			// Apply provider env vars
			const modelId = session.config.model || 'default';
			const originalEnvVars = providerService.applyEnvVarsToProcess(modelId);
			this.deps.setOriginalEnvVars(originalEnvVars);

			const provider = providerRegistry.detectProvider(modelId);
			if (provider && provider.id === 'glm') {
				logger.log(`Applied GLM env vars for model ${modelId} to process.env`);
			}

			// Create query with AsyncGenerator
			const queryObject = query({
				prompt: this.createMessageGeneratorWrapper(),
				options: queryOptions,
			});
			this.deps.setQueryObject(queryObject);

			// Set up startup timeout
			const queryStartTime = Date.now();
			let startupTimeoutReached = false;

			const startupTimer = setTimeout(() => {
				if (!this.deps.getFirstMessageReceived()) {
					startupTimeoutReached = true;
					const elapsed = Date.now() - queryStartTime;
					logger.error(
						`SDK startup timeout: SDK did not respond within ${elapsed}ms. ` +
							`Model: ${queryOptions.model}, Workspace: ${session.workspacePath}` +
							(session.worktree ? ` (worktree: ${session.worktree.worktreePath})` : '')
					);
					this.deps.setQueryPromise(null);
					stateManager.setIdle().catch((e) => logger.warn('Failed to set idle:', e));
				}
			}, STARTUP_TIMEOUT_MS);
			this.deps.setStartupTimeoutTimer(startupTimer);

			logger.log('Processing SDK stream...');

			// Fetch slash commands and models in background
			this.deps.onSlashCommandsFetched().catch((e) => {
				logger.warn('Background fetch of slash commands failed:', e);
			});
			this.deps.onModelsFetched().catch((e) => {
				logger.warn('Background fetch of models failed:', e);
			});

			if (!queryObject) {
				throw new Error('Query object is null after initialization');
			}

			// Create abort controller for this query
			const abortController = new AbortController();
			this.deps.setQueryAbortController(abortController);

			let messageCount = 0;

			for await (const message of this.createAbortableQuery(queryObject, abortController.signal)) {
				if (startupTimeoutReached && messageCount === 0) {
					throw new Error('SDK startup timeout - query aborted');
				}

				messageCount++;

				// Clear startup timeout on first message
				const timer = this.deps.getStartupTimeoutTimer();
				if (timer && messageCount === 1) {
					clearTimeout(timer);
					this.deps.setStartupTimeoutTimer(null);
					logger.log(`SDK first message received after ${Date.now() - queryStartTime}ms`);
				}

				this.deps.setFirstMessageReceived(true);

				try {
					await this.handleSDKMessage(message as SDKMessage);
				} catch (error) {
					logger.error('Error handling SDK message:', error);
					logger.error('Message type:', (message as SDKMessage).type);

					const processingState = stateManager.getState();
					await stateManager.setIdle();

					await errorManager.handleError(
						session.id,
						error as Error,
						ErrorCategory.MESSAGE,
						'Error processing SDK message. The session has been reset.',
						processingState,
						{ messageType: (message as SDKMessage).type }
					);
				}
			}

			logger.log('SDK stream ended');
		} catch (error) {
			logger.error('Streaming query error:', error);
			messageQueue.clear();

			const errorMessage = error instanceof Error ? error.message : String(error);
			const isAbortError = error instanceof Error && error.name === 'AbortError';

			if (!isAbortError) {
				const apiErrorHandled = await this.handleApiValidationError(error);

				if (!apiErrorHandled) {
					let category = ErrorCategory.SYSTEM;

					if (
						errorMessage.includes('401') ||
						errorMessage.includes('unauthorized') ||
						errorMessage.includes('invalid_api_key')
					) {
						category = ErrorCategory.AUTHENTICATION;
					} else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
						category = ErrorCategory.CONNECTION;
					} else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
						category = ErrorCategory.RATE_LIMIT;
					} else if (errorMessage.includes('timeout')) {
						category = ErrorCategory.TIMEOUT;
					} else if (errorMessage.includes('model_not_found')) {
						category = ErrorCategory.MODEL;
					} else if (
						errorMessage.includes('cannot be run as root') ||
						errorMessage.includes('dangerously-skip-permissions') ||
						errorMessage.includes('permission') ||
						errorMessage.includes('Exit code: 1')
					) {
						category = ErrorCategory.PERMISSION;
					}

					const processingState = stateManager.getState();

					await errorManager.handleError(
						session.id,
						error as Error,
						category,
						undefined,
						processingState,
						{
							errorMessage,
							queueSize: messageQueue.size(),
						}
					);
				}

				await stateManager.setIdle();
			}
		} finally {
			// Cleanup abort controller
			const abortController = this.deps.getQueryAbortController();
			if (abortController) {
				abortController.abort();
				this.deps.setQueryAbortController(null);
			}

			// Check for stale query
			const isStaleQuery = this.deps.getQueryGeneration() !== queryGeneration;

			if (!isStaleQuery) {
				messageQueue.stop();
				this.deps.setQueryPromise(null);

				// Restore original env vars
				const originalEnvVars = this.deps.getOriginalEnvVars();
				if (Object.keys(originalEnvVars).length > 0) {
					const { getProviderService: getProviderServiceRestore } = await import(
						'../provider-service'
					);
					const providerServiceRestore = getProviderServiceRestore();
					providerServiceRestore.restoreEnvVars(originalEnvVars);
					this.deps.setOriginalEnvVars({});
					logger.log('Restored original environment variables after SDK query');
				}

				if (!this.deps.isCleaningUp()) {
					await stateManager.setIdle();
				}

				logger.log(`Streaming query stopped (generation ${queryGeneration})`);
			} else {
				logger.log(
					`Skipping all cleanup in finally block - stale query detected (generation ${queryGeneration} != current ${this.deps.getQueryGeneration()})`
				);
			}
		}
	}

	/**
	 * Create wrapper for MessageQueue's AsyncGenerator
	 */
	private async *createMessageGeneratorWrapper() {
		const { session, messageQueue, stateManager } = this.deps;

		for await (const { message, onSent } of messageQueue.messageGenerator(session.id)) {
			const queuedMessage = message as typeof message & { internal?: boolean };
			const isInternal = queuedMessage.internal || false;

			if (!isInternal) {
				await stateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
			}

			yield message;
			onSent();
		}
	}

	/**
	 * Handle incoming SDK message
	 */
	private async handleSDKMessage(message: SDKMessage): Promise<void> {
		const { session, db, logger } = this.deps;

		// Mark queued messages as 'sent' when we receive system:init
		if (isSDKSystemMessage(message) && message.subtype === 'init') {
			const queuedMessages = db.getMessagesByStatus(session.id, 'queued');
			if (queuedMessages.length > 0) {
				const dbIds = queuedMessages.map((m) => m.dbId);
				db.updateMessageStatus(dbIds, 'sent');
				logger.log(
					`Marked ${queuedMessages.length} queued messages as sent (received system:init)`
				);
			}
		}

		// Delegate to callback
		await this.deps.onSDKMessage(message);
		await this.deps.onMarkApiSuccess();
	}

	/**
	 * Create an abortable async iterator wrapper
	 */
	private async *createAbortableQuery(
		queryObj: Query,
		signal: AbortSignal
	): AsyncGenerator<unknown, void, unknown> {
		const { logger } = this.deps;
		const iterator = queryObj[Symbol.asyncIterator]();
		const abortError = new Error('Query aborted');

		let _abortPromiseReject: ((error: Error) => void) | null = null;
		const setupAbortPromise = (): Promise<never> => {
			return new Promise<never>((_, reject) => {
				_abortPromiseReject = reject;
				if (signal.aborted) {
					reject(abortError);
				} else {
					signal.addEventListener('abort', () => reject(abortError), { once: true });
				}
			});
		};

		try {
			if (signal.aborted) {
				logger.log('Query already aborted at start of createAbortableQuery');
				return;
			}

			while (!signal.aborted) {
				const nextPromise = iterator.next();
				const abortPromise = setupAbortPromise();

				try {
					const result = await Promise.race([nextPromise, abortPromise]);

					if (signal.aborted) {
						logger.log('Query aborted via immediate signal check after race');
						break;
					}

					if (result.done) {
						logger.log('Query iterator naturally completed');
						break;
					}

					yield result.value;
				} catch (error) {
					if ((error as Error).message === 'Query aborted') {
						logger.log('Query iterator aborted via Promise.race');
						break;
					}
					throw error;
				}
			}

			if (signal.aborted) {
				logger.log('Query aborted via final signal check');
			}
		} finally {
			try {
				await iterator.return?.();
				logger.log('Query iterator cleaned up via return()');
			} catch (error) {
				logger.debug('Error closing query iterator:', error);
			}
		}
	}

	/**
	 * Handle API validation errors (400-level)
	 */
	private async handleApiValidationError(error: unknown): Promise<boolean> {
		const { logger } = this.deps;

		try {
			const errorMessage = error instanceof Error ? error.message : String(error);

			const apiErrorMatch = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);
			if (!apiErrorMatch) {
				return false;
			}

			const [, statusCode, jsonBody] = apiErrorMatch;

			let errorBody: { type?: string; error?: { type?: string; message?: string } };
			try {
				errorBody = JSON.parse(jsonBody);
			} catch {
				return false;
			}

			const apiErrorMessage = errorBody.error?.message || errorMessage;
			const apiErrorType = errorBody.error?.type || 'api_error';

			logger.log(`Handling API validation error as assistant message: ${statusCode}`);

			await this.displayErrorAsAssistantMessage(
				`**API Error (${statusCode})**: ${apiErrorType}\n\n${apiErrorMessage}\n\nThis error occurred while processing your request. Please review the error message above and adjust your request accordingly.`,
				{ markAsError: true }
			);

			logger.log('API validation error displayed as assistant message');
			return true;
		} catch (err) {
			logger.warn('Failed to handle API validation error:', err);
			return false;
		}
	}

	/**
	 * Display error as assistant message
	 */
	async displayErrorAsAssistantMessage(
		text: string,
		options?: { markAsError?: boolean }
	): Promise<void> {
		const { session, db, messageHub } = this.deps;

		const assistantMessage: SDKMessage = {
			type: 'assistant' as const,
			uuid: generateUUID() as UUID,
			session_id: session.id,
			parent_tool_use_id: null,
			...(options?.markAsError ? { error: 'invalid_request' as const } : {}),
			message: {
				role: 'assistant' as const,
				content: [{ type: 'text' as const, text }],
			},
		};

		db.saveSDKMessage(session.id, assistantMessage);

		await messageHub.publish(
			'state.sdkMessages.delta',
			{ added: [assistantMessage], timestamp: Date.now() },
			{ sessionId: session.id }
		);
	}
}
