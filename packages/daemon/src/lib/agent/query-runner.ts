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
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'crypto';
import type { Session, MessageHub } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { generateUUID } from '@neokai/shared';
import { Database } from '../../storage/database';
import { ErrorCategory, ErrorManager } from '../error-manager';
import { Logger } from '../logger';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { QueryOptionsBuilder } from './query-options-builder';
import type { AskUserQuestionHandler } from './ask-user-question-handler';

const DEFAULT_STARTUP_TIMEOUT_MS = 15000;

function getStartupTimeoutMs(): number {
	const raw = process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;
	if (!raw) return DEFAULT_STARTUP_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

const STARTUP_TIMEOUT_MS = getStartupTimeoutMs();

/**
 * Original environment variables for restoration after SDK query
 */
export interface OriginalEnvVars {
	ANTHROPIC_API_KEY?: string;
	ANTHROPIC_AUTH_TOKEN?: string;
	ANTHROPIC_BASE_URL?: string;
	API_TIMEOUT_MS?: string;
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
	ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
	ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
	ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
	CLAUDE_AGENT_SDK_CLIENT_APP?: string;
}

/**
 * Context interface - what QueryRunner needs from AgentSession
 * Handlers take AgentSession instance directly via this context pattern
 */
export interface QueryRunnerContext {
	// Core dependencies (readonly)
	readonly session: Session;
	readonly db: Database;
	readonly messageHub: MessageHub;
	readonly messageQueue: MessageQueue;
	readonly stateManager: ProcessingStateManager;
	readonly errorManager: ErrorManager;
	readonly logger: Logger;
	readonly optionsBuilder: QueryOptionsBuilder;
	readonly askUserQuestionHandler: AskUserQuestionHandler;

	// Mutable SDK state (accessed directly)
	queryObject: Query | null;
	queryPromise: Promise<void> | null;
	queryAbortController: AbortController | null;
	firstMessageReceived: boolean;
	startupTimeoutTimer: ReturnType<typeof setTimeout> | null;
	originalEnvVars: OriginalEnvVars;
	// Methods for state coordination
	incrementQueryGeneration(): number;
	getQueryGeneration(): number;
	isCleaningUp(): boolean;

	// Callbacks for message handling
	onSDKMessage(message: SDKMessage, queuedMessages?: SDKMessage[]): Promise<void>;
	onSlashCommandsFetched(): Promise<void>;
	onModelsFetched(): Promise<void>;
	onMarkApiSuccess(): Promise<void>;
}

/**
 * Runs SDK queries with streaming input mode
 */
export class QueryRunner {
	constructor(private ctx: QueryRunnerContext) {}

	/**
	 * Start the streaming query (called from AgentSession.startStreamingQuery)
	 */
	async start(): Promise<void> {
		const { messageQueue } = this.ctx;

		if (messageQueue.isRunning()) {
			return;
		}

		messageQueue.start();

		// Increment query generation for this new query
		const currentGeneration = this.ctx.incrementQueryGeneration();

		// Reset firstMessageReceived flag for new query
		this.ctx.firstMessageReceived = false;

		// Store query promise for cleanup
		this.ctx.queryPromise = this.runQuery(currentGeneration);
	}

	/**
	 * Run the query (main execution loop)
	 */
	private async runQuery(queryGeneration: number): Promise<void> {
		const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;

		try {
			// Verify authentication for the selected provider
			const { initializeProviders } = await import('../providers/factory.js');
			const providerRegistry = initializeProviders();
			const modelId = session.config.model || 'sonnet';
			// Routing is deterministic: session.config.provider is always set by the model
			// picker and stored on every model switch. Legacy sessions without a stored
			// provider fall back to heuristic detection (@deprecated path).
			const explicitProviderId = session.config.provider as string | undefined;
			const provider = explicitProviderId
				? providerRegistry.detectProviderForModel(modelId, explicitProviderId)
				: providerRegistry.detectProvider(modelId);

			// Check if the provider can make API calls (env vars, auth.json, gh CLI — all count).
			// isAvailable() is the runtime gate; getAuthStatus().isAuthenticated is UI-only
			// (NeoKai-managed OAuth) and must NOT be used here or env-var users will be blocked.
			if (provider?.isAvailable && !(await provider.isAvailable())) {
				const authStatus = provider.getAuthStatus ? await provider.getAuthStatus() : null;
				const errorMsg = authStatus?.error || 'Please configure credentials.';
				const authError = new Error(
					`Provider ${provider.displayName} is not available. ${errorMsg}`
				);
				await errorManager.handleError(
					session.id,
					authError,
					ErrorCategory.PROVIDER_AUTH_ERROR,
					`Provider ${provider.displayName} is not available. Please configure credentials to continue.`,
					stateManager.getState(),
					{ providerId: provider.id, providerName: provider.displayName }
				);
				throw authError;
			}
			// needsRefresh is a UI hint — warn but do not block the session.
			if (provider?.getAuthStatus) {
				const authStatus = await provider.getAuthStatus();
				if (authStatus.needsRefresh) {
					logger.warn(
						`Provider ${provider.displayName} token needs refresh. Attempting to continue.`
					);
				}
			}
			if (!provider?.isAvailable) {
				// Fall back to checking Anthropic/GLM auth for SDK-based providers
				const { getProviderService } = await import('../provider-service');
				const providerService = getProviderService();

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
			}

			// Ensure workspace exists
			const fs = await import('fs/promises');
			await fs.mkdir(session.workspacePath, { recursive: true });

			// Build query options
			optionsBuilder.setCanUseTool(this.ctx.askUserQuestionHandler.createCanUseToolCallback());
			let queryOptions = await optionsBuilder.build();
			queryOptions = optionsBuilder.addSessionStateOptions(queryOptions);

			// Apply provider env vars
			{
				const { getProviderService } = await import('../provider-service');
				const providerService = getProviderService();
				// Use the resolved provider ID (falls back to 'anthropic' for legacy sessions)
				const resolvedProviderId = explicitProviderId ?? provider?.id ?? 'anthropic';
				const originalEnvVars = providerService.applyEnvVarsToProcess(modelId, resolvedProviderId);
				this.ctx.originalEnvVars = originalEnvVars;
			}

			// Set SDK client identifier for analytics
			this.ctx.originalEnvVars.CLAUDE_AGENT_SDK_CLIENT_APP =
				process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
			process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'neokai/0.5.0';

			// Create query with AsyncGenerator
			const queryObject = query({
				prompt: this.createMessageGeneratorWrapper(),
				options: queryOptions,
			});
			this.ctx.queryObject = queryObject;

			// Set up startup timeout
			const queryStartTime = Date.now();
			let startupTimeoutReached = false;

			const startupTimer = setTimeout(() => {
				if (!this.ctx.firstMessageReceived) {
					startupTimeoutReached = true;
					const elapsed = Date.now() - queryStartTime;
					logger.error(
						`SDK startup timeout: SDK did not respond within ${elapsed}ms. ` +
							`Model: ${queryOptions.model}, Workspace: ${session.workspacePath}` +
							(session.worktree ? ` (worktree: ${session.worktree.worktreePath})` : '')
					);

					// Actively abort a stuck startup so finally{} cleanup runs and the
					// session can recover without requiring manual reset.
					const abortController = this.ctx.queryAbortController;
					if (abortController && !abortController.signal.aborted) {
						abortController.abort();
					}
				}
			}, STARTUP_TIMEOUT_MS);
			this.ctx.startupTimeoutTimer = startupTimer;

			// Fetch slash commands and models in background
			this.ctx.onSlashCommandsFetched().catch((e) => {
				logger.warn('Background fetch of slash commands failed:', e);
			});
			this.ctx.onModelsFetched().catch((e) => {
				logger.warn('Background fetch of models failed:', e);
			});

			if (!queryObject) {
				throw new Error('Query object is null after initialization');
			}

			// Create abort controller for this query
			const abortController = new AbortController();
			this.ctx.queryAbortController = abortController;

			let messageCount = 0;

			for await (const message of this.createAbortableQuery(queryObject, abortController.signal)) {
				if (startupTimeoutReached && messageCount === 0) {
					throw new Error('SDK startup timeout - query aborted');
				}

				messageCount++;

				// Clear startup timeout on first message
				const timer = this.ctx.startupTimeoutTimer;
				if (timer && messageCount === 1) {
					clearTimeout(timer);
					this.ctx.startupTimeoutTimer = null;
				}

				this.ctx.firstMessageReceived = true;

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

			// If startup timed out before first message, surface as timeout error
			// (after abort-driven iterator shutdown) so error state is visible.
			if (startupTimeoutReached && messageCount === 0) {
				throw new Error('SDK startup timeout - query aborted');
			}
		} catch (error) {
			logger.error('Streaming query error:', error);
			messageQueue.clear();

			const errorMessage = error instanceof Error ? error.message : String(error);
			const isAbortError = error instanceof Error && error.name === 'AbortError';

			// If startup timed out while trying to resume a session, clear sdkSessionId
			// so the next attempt (Reset Agent, or sending a message) starts a fresh SDK
			// session instead of repeatedly failing on the same problematic session file.
			if (errorMessage.includes('SDK startup timeout') && session.sdkSessionId) {
				logger.error(
					`Clearing sdkSessionId (${session.sdkSessionId}) due to startup timeout. ` +
						'Next query will start fresh without resume.'
				);
				session.sdkSessionId = undefined;
				this.ctx.db.updateSession(session.id, { sdkSessionId: undefined });
			}

			if (!isAbortError) {
				const apiErrorHandled = await this.handleApiValidationError(error);

				if (!apiErrorHandled) {
					let category = ErrorCategory.SYSTEM;
					const providerId = session.config.provider as string | undefined;

					// Detect provider-specific errors before general categorization
					const isProviderSession =
						providerId && providerId !== 'anthropic' && providerId !== 'glm';

					if (
						isProviderSession &&
						(errorMessage.includes('401') ||
							errorMessage.includes('403') ||
							errorMessage.includes('unauthorized') ||
							errorMessage.includes('Unauthorized') ||
							errorMessage.includes('token expired') ||
							errorMessage.includes('token_expired') ||
							errorMessage.includes('not authenticated') ||
							errorMessage.includes('invalid_api_key'))
					) {
						category = ErrorCategory.PROVIDER_AUTH_ERROR;
					} else if (
						isProviderSession &&
						(errorMessage.includes('ECONNREFUSED') ||
							errorMessage.includes('ENOTFOUND') ||
							errorMessage.includes('EHOSTUNREACH') ||
							errorMessage.includes('service unavailable') ||
							errorMessage.includes('503') ||
							errorMessage.includes('502'))
					) {
						category = ErrorCategory.PROVIDER_UNAVAILABLE;
					} else if (
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
							providerId: providerId ?? 'anthropic',
						}
					);
				}

				await stateManager.setIdle();
			}
		} finally {
			// Check for stale query FIRST to avoid race conditions.
			// When a query is restarted (e.g., model switch), the old query's finally block
			// must not touch shared state (abort controller, timers) that belongs to the new query.
			const isStaleQuery = this.ctx.getQueryGeneration() !== queryGeneration;

			if (!isStaleQuery) {
				// This is the current query — safe to clean up shared state

				// Clear startup timer
				const timer = this.ctx.startupTimeoutTimer;
				if (timer) {
					clearTimeout(timer);
					this.ctx.startupTimeoutTimer = null;
				}

				// Cleanup abort controller
				const abortController = this.ctx.queryAbortController;
				if (abortController) {
					abortController.abort();
					this.ctx.queryAbortController = null;
				}

				messageQueue.stop();

				// Close and null queryObject BEFORE any async operation so that
				// concurrent stop()/interrupt() callers see null and skip their
				// own close() call. queryPromise is nulled LAST — callers awaiting
				// it exit the race only after this synchronous block has run,
				// guaranteeing they observe queryObject=null and skip the redundant
				// close().
				if (this.ctx.queryObject) {
					try {
						this.ctx.queryObject.close();
					} catch {
						// Ignore close errors — subprocess may already be terminated
					}
					this.ctx.queryObject = null;
				}

				// Restore original env vars
				const originalEnvVars = this.ctx.originalEnvVars;
				if (Object.keys(originalEnvVars).length > 0) {
					const { getProviderService: getProviderServiceRestore } = await import(
						'../provider-service'
					);
					const providerServiceRestore = getProviderServiceRestore();
					providerServiceRestore.restoreEnvVars(originalEnvVars);
					this.ctx.originalEnvVars = {};
				}

				if (!this.ctx.isCleaningUp()) {
					await stateManager.setIdle();
				}

				// Null queryPromise last so callers awaiting it see queryObject=null.
				this.ctx.queryPromise = null;
			}
			// Stale query: skip all cleanup — new query owns shared state
		}
	}

	/**
	 * Create wrapper for MessageQueue's AsyncGenerator
	 * Public for testing
	 */
	async *createMessageGeneratorWrapper() {
		const { session, messageQueue, stateManager } = this.ctx;

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
	 * Public for testing
	 */
	async handleSDKMessage(message: SDKMessage): Promise<void> {
		// Delegate to callback
		await this.ctx.onSDKMessage(message);
		await this.ctx.onMarkApiSuccess();
	}

	/**
	 * Create an abortable async iterator wrapper
	 * Public for testing
	 */
	async *createAbortableQuery(
		queryObj: Query,
		signal: AbortSignal
	): AsyncGenerator<unknown, void, unknown> {
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
				return;
			}

			while (!signal.aborted) {
				const nextPromise = iterator.next();
				const abortPromise = setupAbortPromise();

				try {
					const result = await Promise.race([nextPromise, abortPromise]);

					if (signal.aborted) {
						break;
					}

					if (result.done) {
						break;
					}

					yield result.value;
				} catch (error) {
					if ((error as Error).message === 'Query aborted') {
						break;
					}
					throw error;
				}
			}
		} finally {
			try {
				await iterator.return?.();
			} catch {
				// Ignore cleanup errors
			}
		}
	}

	/**
	 * Handle API validation errors (400-level)
	 */
	private async handleApiValidationError(error: unknown): Promise<boolean> {
		const { logger } = this.ctx;

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

			await this.displayErrorAsAssistantMessage(
				`**API Error (${statusCode})**: ${apiErrorType}\n\n${apiErrorMessage}\n\nThis error occurred while processing your request. Please review the error message above and adjust your request accordingly.`,
				{ markAsError: true }
			);

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
		const { session, db, messageHub } = this.ctx;

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

		messageHub.event(
			'state.sdkMessages.delta',
			{ added: [assistantMessage], timestamp: Date.now() },
			{ channel: `session:${session.id}` }
		);
	}
}
