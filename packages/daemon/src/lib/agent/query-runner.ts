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
import type { Query, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawn as nodeSpawn } from 'node:child_process';
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
import type { OriginalEnvVars } from '../provider-service';
// Re-exported for callers that import OriginalEnvVars from this module — canonical definition lives in provider-service.ts.
export type { OriginalEnvVars } from '../provider-service';

/**
 * Default spawn implementation matching the SDK's internal spawnLocalProcess().
 * Used when no custom spawnClaudeCodeProcess is configured, so we can
 * still intercept the subprocess and track its exit.
 *
 * Mirrors the SDK's spawn behavior (verified in sdk.mjs):
 * - stdio: ['pipe', 'pipe', stderr] where stderr is 'pipe' when
 *   DEBUG_CLAUDE_AGENT_SDK is set, otherwise 'ignore'
 * - windowsHide: true
 * - Same cwd, env, signal passthrough
 *
 * Node's ChildProcess structurally satisfies the SDK's SpawnedProcess
 * interface (stdin, stdout, killed, exitCode, kill, on/once/off for
 * 'exit' and 'error' events).
 *
 * SDK coupling: This mirrors the internal spawnLocalProcess() in the SDK (sdk.mjs).
 * Re-verify this implementation matches the SDK's spawn behavior on SDK upgrades —
 * mismatches in stdio/env/signal can cause subtle subprocess communication failures.
 */
function defaultSpawn(opts: SpawnOptions): SpawnedProcess {
	const debugSdk = opts.env?.DEBUG_CLAUDE_AGENT_SDK;
	const stderr = debugSdk && debugSdk !== '0' && debugSdk !== 'false' ? 'pipe' : 'ignore';
	const proc = nodeSpawn(opts.command, opts.args, {
		cwd: opts.cwd,
		env: opts.env as NodeJS.ProcessEnv,
		stdio: ['pipe', 'pipe', stderr],
		signal: opts.signal,
		windowsHide: true,
	});
	return proc as unknown as SpawnedProcess;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
/** Max time to wait for subprocess exit before retrying after startup timeout. */
const RETRY_EXIT_TIMEOUT_MS = 5000;

function getStartupTimeoutMs(): number {
	const raw = process.env.NEOKAI_SDK_STARTUP_TIMEOUT_MS;
	if (!raw) return DEFAULT_STARTUP_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

// Read once at module load — consistent with the original STARTUP_TIMEOUT_MS pattern.
// Env vars set after the process starts will not be picked up; the values displayed
// in user-facing error messages reflect these module-load-time snapshots.
const STARTUP_TIMEOUT_MS = getStartupTimeoutMs();

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
	/** Resolves when the SDK subprocess exits. Set by QueryRunner via spawnClaudeCodeProcess wrapper. */
	processExitedPromise: Promise<void> | null;
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
		const { messageQueue, logger } = this.ctx;

		if (messageQueue.isRunning()) {
			logger.warn(
				`QueryRunner.start(): messageQueue already running for session ${this.ctx.session.id}, ` +
					`skipping start (generation=${messageQueue.getGeneration()}, ` +
					`queryPromise=${this.ctx.queryPromise ? 'active' : 'null'})`
			);
			return;
		}

		logger.debug(
			`QueryRunner.start(): starting query for session ${this.ctx.session.id} ` +
				`(generation=${messageQueue.getGeneration()})`
		);
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
	 *
	 * @param queryGeneration - Generation counter to detect stale queries
	 * @param isRetry - Whether this is an automatic retry after startup timeout
	 */
	private async runQuery(queryGeneration: number, isRetry = false): Promise<void> {
		const { session, messageQueue, stateManager, errorManager, logger, optionsBuilder } = this.ctx;

		try {
			// Verify authentication for the selected provider
			const { initializeProviders } = await import('../providers/factory.js');
			const providerRegistry = initializeProviders();
			const modelId = session.config.model || 'sonnet';
			// As of PR #466, all new agent sessions store an explicit provider ID in
			// session.config.provider. The registry.get('anthropic') fallback below is a
			// temporary shim for sessions created before that change. It must NOT be
			// expanded or used as a design pattern — new code should always have an
			// explicit provider stored.
			const explicitProviderId = session.config.provider as string | undefined;
			const provider = explicitProviderId
				? providerRegistry.detectProviderForModel(modelId, explicitProviderId)
				: providerRegistry.get('anthropic');

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

			// Ensure workspace exists when the session is bound to a concrete workspace path.
			if (session.workspacePath) {
				const fs = await import('fs/promises');
				await fs.mkdir(session.workspacePath, { recursive: true });
			}

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
			// Note: PORT and NEOKAI_PORT are cleared inside applyEnvVarsToProcess() above,
			// so SDK subprocesses cannot inherit the daemon's listening port.

			// Wrap spawnClaudeCodeProcess to track subprocess exit deterministically.
			// This lets stop() await the actual process exit instead of using arbitrary delays.
			const originalSpawn = queryOptions.spawnClaudeCodeProcess;
			queryOptions.spawnClaudeCodeProcess = (opts: SpawnOptions): SpawnedProcess => {
				const proc = originalSpawn ? originalSpawn(opts) : defaultSpawn(opts);
				this.ctx.processExitedPromise = new Promise<void>((resolve) => {
					proc.once('exit', () => resolve());
				});
				return proc;
			};

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
					const isRootWorkspace = !session.worktree;
					const workspaceDesc = isRootWorkspace
						? `root workspace: ${session.workspacePath ?? 'unbound'}`
						: `worktree: ${session.worktree!.worktreePath}`;
					logger.error(
						`SDK startup timeout: SDK did not respond within ${elapsed}ms. ` +
							`Model: ${queryOptions.model}, ${workspaceDesc}` +
							(isRootWorkspace
								? ' — running on root workspace (not a worktree); check for other Claude Code sessions using this path'
								: '') +
							` (Hint: set NEOKAI_SDK_STARTUP_TIMEOUT_MS to increase timeout, currently ${STARTUP_TIMEOUT_MS}ms)`
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

					// During cleanup the database may already be closed — skip
					// state persistence to avoid cascading "closed database" errors.
					if (!this.ctx.isCleaningUp()) {
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
			}

			// Stop the queue immediately after the query ends to close the race window
			// between the for-await loop ending and the finally block calling stop().
			// Without this, ensureQueryStarted() can see isRunning()=true while no
			// generator is consuming messages, causing enqueued messages to be orphaned.
			// Guard: only stop if this is still the current query (not stale from a restart).
			if (this.ctx.getQueryGeneration() === queryGeneration) {
				messageQueue.stop();
			}

			// If startup timed out before first message, surface as timeout error
			// (after abort-driven iterator shutdown) so error state is visible.
			if (startupTimeoutReached && messageCount === 0) {
				throw new Error('SDK startup timeout - query aborted');
			}
		} catch (error) {
			logger.error('Streaming query error:', error);

			// During cleanup the database may already be closed. Skip all
			// error-recovery DB writes to avoid cascading "closed database"
			// errors that escape as unhandled rejections.
			if (this.ctx.isCleaningUp()) {
				return;
			}

			const errorMessage = error instanceof Error ? error.message : String(error);
			const isAbortError = error instanceof Error && error.name === 'AbortError';
			const isStartupTimeout = errorMessage.includes('SDK startup timeout');
			const isConversationNotFound = errorMessage.includes('No conversation found');

			// Startup timeout is transient — always keep sdkSessionId so resume works.
			// Never clear sdkSessionId on timeout: the session file is valid and the
			// conversation can be resumed once the workspace lock conflict resolves.
			// Clearing it would lose the ability to resume the conversation history.
			// "No conversation found" is permanent — clear sdkSessionId so the next
			// attempt starts fresh instead of looping on a dead conversation.
			if (isStartupTimeout && session.sdkSessionId) {
				logger.error(
					`Startup timeout with sdkSessionId (${session.sdkSessionId}). ` +
						'Keeping sdkSessionId for resume on retry.'
				);
			}
			if (isConversationNotFound && session.sdkSessionId) {
				// Clear sdkSessionId and sdkOriginPath — the conversation transcript is
				// irrecoverably gone (file not found even after cross-path migration attempts
				// in QueryLifecycleManager). Common causes: provider switch, manual deletion,
				// or workspace completely removed. Keeping it would cause every subsequent
				// attempt to fail with the same error. Clearing it lets the next message
				// start a fresh conversation automatically.
				logger.error(
					`No conversation found for sdkSessionId (${session.sdkSessionId}). ` +
						'All fallback path lookups were exhausted. ' +
						'Clearing sdkSessionId — next message will start a fresh conversation.'
				);
				session.sdkSessionId = undefined;
				session.sdkOriginPath = undefined;
				this.ctx.db.updateSession(session.id, {
					sdkSessionId: undefined,
					sdkOriginPath: undefined,
				});

				// Emit a visible system message so the user knows a new session was started.
				// This is the deterministic rotation path required by the task spec.
				try {
					await this.displayErrorAsAssistantMessage(
						'⚠️ **Conversation history could not be resumed.**\n\n' +
							'The previous session transcript was not found — this can happen after a ' +
							'provider switch, workspace path change, or external cleanup of ' +
							'`~/.claude/projects/`. Your conversation history in NeoKai is preserved; ' +
							'only the AI context window has been reset.\n\n' +
							'**Please resend your message** — a fresh AI session will start automatically.',
						{ markAsError: false }
					);
				} catch {
					// Best-effort — don't let message emission block cleanup
				}
			}

			// Auto-retry once on startup timeout — the user shouldn't have to resend.
			// This handles transient SDK startup failures (e.g., after a model switch)
			// where the second attempt succeeds reliably.
			// Skip messageQueue.clear() so the user's pending message is preserved for the retry.
			if (isStartupTimeout && !isRetry && !this.ctx.isCleaningUp()) {
				logger.warn('Auto-retrying query after startup timeout (1 retry).');
				await stateManager.setIdle();

				// Close the current queryObject BEFORE retrying to prevent the
				// "Already connected to a transport" crash. The finally{} block has not
				// yet run (we are still in the catch block), so MCP transports are still
				// open. Explicitly closing here ensures a clean slate for the retry.
				if (this.ctx.queryObject) {
					try {
						this.ctx.queryObject.close();
					} catch {
						// Ignore close errors — transport may already be in a broken state
					}
					this.ctx.queryObject = null;
				}

				// Wait for the old subprocess to fully exit before retrying.
				// close() above terminates the process, but we must wait for it to
				// release workspace locks before spawning a replacement.
				const exitPromise = this.ctx.processExitedPromise;
				if (exitPromise) {
					await Promise.race([
						exitPromise,
						new Promise((resolve) => setTimeout(resolve, RETRY_EXIT_TIMEOUT_MS)),
					]);
					this.ctx.processExitedPromise = null;
				}

				// Use `return await` so this call's finally{} runs only after the retry
				// completes. Otherwise finally{} would race the retry and can tear down
				// shared state (queue/controller/queryObject) while it is still running.
				return await this.runQuery(queryGeneration, true);
			}

			// Clear the queue on non-retryable errors so stale messages don't bleed into the next session.
			messageQueue.clear();

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
					} else if (
						errorMessage.includes('429') ||
						errorMessage.includes('rate limit') ||
						errorMessage.includes('402') ||
						errorMessage.toLowerCase().includes('no quota') ||
						errorMessage.toLowerCase().includes('quota exceeded') ||
						errorMessage.toLowerCase().includes('insufficient_quota')
					) {
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

					// For startup timeouts / conversation-not-found, provide actionable recovery hints.
					// Keep the hints distinct: NEOKAI_SDK_STARTUP_TIMEOUT_MS is irrelevant to a
					// missing/corrupt session file — the session ID was already cleared above,
					// so the next message will automatically start a fresh session.
					const startupTimeoutUserMessage = isStartupTimeout
						? `The AI session failed to start (workspace: ${session.workspacePath ?? 'unbound'}). ` +
							`Common causes: another Claude Code session is using the same workspace, ` +
							`a stale lock file in .claude/, or the workspace is under heavy load. ` +
							`Try: closing other Claude sessions on this workspace, ` +
							`then resend your message. ` +
							`You can also increase the timeout with NEOKAI_SDK_STARTUP_TIMEOUT_MS (current: ${STARTUP_TIMEOUT_MS}ms).`
						: isConversationNotFound
							? `The AI session could not be resumed (workspace: ${session.workspacePath ?? 'unbound'}). ` +
								`The previous session transcript was not found — this can happen after a provider switch, ` +
								`workspace path change, or if the ~/.claude/projects/ directory was cleaned up. ` +
								`Your message history in NeoKai is preserved; only the AI context window is reset. ` +
								`Please resend your message — a fresh session starts automatically.`
							: undefined;

					await errorManager.handleError(
						session.id,
						error as Error,
						category,
						startupTimeoutUserMessage,
						processingState,
						{
							errorMessage,
							queueSize: messageQueue.size(),
							providerId: providerId ?? 'anthropic',
							workspacePath: session.workspacePath ?? undefined,
							isRootWorkspace: !session.worktree,
							startupTimeoutMs: STARTUP_TIMEOUT_MS,
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

				// Clear process exit tracking — the subprocess has exited (or will be
				// cleaned up by close() below). Prevents a resolved promise from a
				// previous generation being observed by stop() after a restart: without
				// this clear, a future stop() call on a new query could snapshot a stale
				// resolved promise and skip the real wait for the new subprocess's exit.
				this.ctx.processExitedPromise = null;

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

			// JSON-body 4xx (standard Anthropic API errors: "402 {...}")
			const apiErrorMatch = errorMessage.match(/^(4\d{2})\s+(\{.+\})$/s);
			if (apiErrorMatch) {
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
			}

			// Plain-text 4xx (e.g. Copilot returns "402 You have no quota (Request ID: ...)")
			const plainErrorMatch = errorMessage.match(/^(4\d{2})\s+(.+)$/s);
			if (plainErrorMatch) {
				const [, statusCode, plainMessage] = plainErrorMatch;
				await this.displayErrorAsAssistantMessage(
					`**API Error (${statusCode})**: ${plainMessage.trim()}\n\nThis error occurred while processing your request.`,
					{ markAsError: true }
				);
				return true;
			}

			// JSON SSE error event (e.g. from Copilot bridge: {"type":"error","error":{"type":"api_error","message":"402 You have no quota ..."}})
			try {
				const parsed = JSON.parse(errorMessage) as {
					type?: string;
					error?: { type?: string; message?: string };
				};
				const innerMessage = parsed?.error?.message;
				if (typeof innerMessage === 'string') {
					const innerMatch = innerMessage.match(/^(4\d{2})\s+(.+)$/s);
					if (innerMatch) {
						const [, statusCode, plainMessage] = innerMatch;
						await this.displayErrorAsAssistantMessage(
							`**API Error (${statusCode})**: ${plainMessage.trim()}\n\nThis error occurred while processing your request.`,
							{ markAsError: true }
						);
						return true;
					}
				}
			} catch {
				// not JSON
			}

			return false;
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
