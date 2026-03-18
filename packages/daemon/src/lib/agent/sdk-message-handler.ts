/**
 * SDKMessageHandler - Process incoming SDK messages
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Message persistence to DB
 * - Broadcasting to clients via MessageHub
 * - Metadata updates (tokens, costs, tool calls)
 * - Compaction event detection and emission
 * - Title generation trigger
 * - Automatic phase detection for state tracking
 * - Circuit breaker trip handling (error loop detection)
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'crypto';
import type { MessageHub, Session } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import {
	isSDKAPIRetryMessage,
	isSDKAssistantMessage,
	isSDKCompactBoundary,
	isSDKResultSuccess,
	isSDKStatusMessage,
	isSDKSystemInit,
	isSDKSystemMessage,
	isSDKUserMessage,
	isToolUseBlock,
} from '@neokai/shared/sdk/type-guards';
import type { Database } from '../../storage/database';
import { Logger } from '../logger';
import { ErrorCategory, type ErrorManager } from '../error-manager';
import type { ProcessingStateManager } from './processing-state-manager';
import type { ContextTracker } from './context-tracker';
import { ContextFetcher } from './context-fetcher';
import { ApiErrorCircuitBreaker } from './api-error-circuit-breaker';
import type { MessageQueue } from './message-queue';
import type { QueryLifecycleManager } from './query-lifecycle-manager';

/**
 * Context interface - what SDKMessageHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface SDKMessageHandlerContext {
	readonly session: Session;
	readonly db: Database;
	readonly messageHub: MessageHub;
	readonly daemonHub: DaemonHub;
	readonly stateManager: ProcessingStateManager;
	readonly contextTracker: ContextTracker;
	readonly messageQueue: MessageQueue;

	// Dependencies for circuit breaker trip handling
	readonly errorManager: ErrorManager;
	readonly lifecycleManager: QueryLifecycleManager;

	// Mutable query state (needed to check if query is running)
	queryObject: Query | null;
	queryPromise: Promise<void> | null;

	// Whether to auto-queue /context after each turn (default: true)
	contextAutoQueueEnabled: boolean;

	// Called when the SDK init message provides the full slash commands list
	onInitSlashCommands: (commands: string[]) => Promise<void>;
}

export class SDKMessageHandler {
	private sdkMessageDeltaVersion: number = 0;
	private logger: Logger;
	private contextFetcher: ContextFetcher;
	private circuitBreaker: ApiErrorCircuitBreaker;
	private acknowledgedPersistedUserThisTurn: boolean = false;

	// Track whether we just processed a context response to prevent infinite loop
	// When true, we skip queuing /context for the next result message
	private lastMessageWasContextResponse: boolean = false;

	// Track UUIDs of internal /context commands to skip their result messages
	private internalContextCommandIds: Set<string> = new Set();

	/**
	 * Check if this message is the replay response for an internally queued /context command.
	 *
	 * This is ID-based (not content-based) so loop prevention still works if SDK output format changes.
	 */
	private isInternalContextResponse(message: SDKMessage): boolean {
		if (message.type !== 'user') return false;
		const userMessage = message as { uuid?: string };
		return !!userMessage.uuid && this.internalContextCommandIds.has(userMessage.uuid);
	}

	/**
	 * Check if a successful result consumed zero tokens.
	 * Internal slash-command turns (like /context) typically produce this shape.
	 */
	private isZeroTokenResult(message: SDKMessage): boolean {
		if (!isSDKResultSuccess(message)) return false;
		const usage = message.usage;
		return (
			usage.input_tokens === 0 &&
			usage.output_tokens === 0 &&
			usage.cache_read_input_tokens === 0 &&
			usage.cache_creation_input_tokens === 0
		);
	}

	constructor(private ctx: SDKMessageHandlerContext) {
		const { session } = ctx;
		this.logger = new Logger(`SDKMessageHandler ${session.id}`);
		this.contextFetcher = new ContextFetcher(session.id);
		this.circuitBreaker = new ApiErrorCircuitBreaker(session.id);

		// Set up circuit breaker callback - fully internalized
		this.circuitBreaker.setOnTripCallback(async (reason, _errorCount) => {
			const userMessage = this.circuitBreaker.getTripMessage();
			await this.handleCircuitBreakerTrip(reason, userMessage);
		});

		// Set up message yield callback - fires when generator yields to SDK
		// This is the CORRECT moment to broadcast steered messages to UI
		// and update their DB timestamp (T_consumed, not T_end)
		ctx.messageQueue.onMessageYielded = (messageId: string, sentAt: number) => {
			this.handleMessageYielded(messageId, sentAt);
		};
	}

	/**
	 * Reset the circuit breaker (after manual reset or successful recovery)
	 */
	resetCircuitBreaker(): void {
		this.circuitBreaker.reset();
	}

	/**
	 * Mark successful API interaction (resets error tracking)
	 */
	markApiSuccess(): void {
		this.circuitBreaker.markSuccess();
	}

	/**
	 * Handle circuit breaker trip (error loop detected)
	 *
	 * This is called when the circuit breaker detects repeated API errors.
	 * It stops the session and displays an error message to the user.
	 * Unlike normal reset, this does NOT:
	 * - Preserve cost tracking
	 * - Restart the query
	 * - Publish session.reset notification
	 */
	private async handleCircuitBreakerTrip(reason: string, userMessage: string): Promise<void> {
		const { session, stateManager, messageQueue, daemonHub, errorManager, lifecycleManager } =
			this.ctx;

		try {
			// Clear state before stopping
			messageQueue.clear();
			this.resetCircuitBreaker();
			await daemonHub.emit('session.errorClear', {
				sessionId: session.id,
			});

			// Stop the query (if running)
			if (this.ctx.queryObject || this.ctx.queryPromise) {
				await lifecycleManager.stop({ catchQueryErrors: true });
			}

			// Reset to idle state
			await stateManager.setIdle();

			// Display error message as assistant message
			await this.displayErrorAsAssistantMessage(
				`⚠️ **Session Stopped: Error Loop Detected**\n\n${userMessage}\n\n` +
					`The agent has been automatically stopped to prevent further errors.`
			);

			// Report to error manager
			await errorManager.handleError(
				session.id,
				new Error(`Circuit breaker tripped: ${reason}`),
				ErrorCategory.SYSTEM,
				userMessage,
				stateManager.getState(),
				{ circuitBreakerReason: reason }
			);
		} catch (error) {
			this.logger.error('Error handling circuit breaker trip:', error);
			await stateManager.setIdle();
		}
	}

	/**
	 * Display error as synthetic assistant message
	 *
	 * Creates and persists an assistant message to show errors in the chat UI.
	 */
	private async displayErrorAsAssistantMessage(text: string): Promise<void> {
		const { session, db, messageHub } = this.ctx;

		const assistantMessage: SDKMessage = {
			type: 'assistant' as const,
			uuid: generateUUID() as UUID,
			session_id: session.id,
			parent_tool_use_id: null,
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

	/**
	 * Acknowledge a persisted user message when SDK replays it.
	 *
	 * For user messages already persisted in sdk_messages with send_status
	 * (queued/saved), we should:
	 * 1) transition send_status -> sent
	 * 2) publish the user message to transcript
	 * 3) avoid inserting a duplicate SDK message row
	 */
	private async acknowledgePersistedUserMessage(message: SDKMessage): Promise<boolean> {
		const { session, db, daemonHub, messageHub } = this.ctx;
		if (message.type !== 'user' || !message.uuid) {
			return false;
		}

		const queuedMessage = db
			.getMessagesByStatus(session.id, 'queued')
			.find((queued) => queued.uuid === message.uuid);
		if (queuedMessage) {
			db.updateMessageStatus([queuedMessage.dbId], 'sent');
			// Update DB timestamp to now so the message's position in the DB matches
			// where the SDK placed it in the conversation (after already-streamed
			// assistant messages), not when the user originally typed it.
			db.updateMessageTimestamp(queuedMessage.dbId);
			await daemonHub.emit('messages.statusChanged', {
				sessionId: session.id,
				messageIds: [queuedMessage.dbId],
				status: 'sent',
			});
			this.acknowledgedPersistedUserThisTurn = true;

			messageHub.event(
				'state.sdkMessages.delta',
				{
					added: [message],
					timestamp: Date.now(),
					version: ++this.sdkMessageDeltaVersion,
				},
				{ channel: `session:${session.id}` }
			);

			// Emit on DaemonHub for server-side listeners (e.g. group message mirroring)
			// so pre-persisted user messages appear in the group timeline.
			await daemonHub.emit('sdk.message', {
				sessionId: session.id,
				message,
			});

			return true;
		}

		const savedMessage = db
			.getMessagesByStatus(session.id, 'saved')
			.find((saved) => saved.uuid === message.uuid);
		if (savedMessage) {
			db.updateMessageStatus([savedMessage.dbId], 'sent');
			db.updateMessageTimestamp(savedMessage.dbId);
			await daemonHub.emit('messages.statusChanged', {
				sessionId: session.id,
				messageIds: [savedMessage.dbId],
				status: 'sent',
			});
			this.acknowledgedPersistedUserThisTurn = true;

			messageHub.event(
				'state.sdkMessages.delta',
				{
					added: [message],
					timestamp: Date.now(),
					version: ++this.sdkMessageDeltaVersion,
				},
				{ channel: `session:${session.id}` }
			);

			// Emit on DaemonHub for server-side listeners (e.g. group message mirroring)
			await daemonHub.emit('sdk.message', {
				sessionId: session.id,
				message,
			});

			return true;
		}

		const sentMessage = db
			.getMessagesByStatus(session.id, 'sent')
			.find((sent) => sent.uuid === message.uuid);
		if (sentMessage) {
			this.acknowledgedPersistedUserThisTurn = true;
			return true;
		}

		return false;
	}

	/**
	 * Fallback acknowledgment when SDK doesn't replay user messages.
	 * Marks ALL remaining queued user messages as sent at turn end.
	 *
	 * This is a safety net — ideally handleMessageYielded already handled
	 * these at yield time. But if the generator didn't fire the callback
	 * (e.g., internal messages, edge cases), this ensures messages don't
	 * stay stuck in 'queued' status forever.
	 */
	private async acknowledgeOldestQueuedUserOnTurnEnd(): Promise<void> {
		const { session, db, daemonHub, messageHub } = this.ctx;
		const queuedUsers = db
			.getMessagesByStatus(session.id, 'queued')
			.filter((queued) => isSDKUserMessage(queued));

		for (const queuedUser of queuedUsers) {
			db.updateMessageStatus([queuedUser.dbId], 'sent');
			// Don't update timestamp here — keep the original T1 timestamp
			// since we don't know the exact T_consumed for these edge cases.
			// The original timestamp (when user sent it) is a better approximation
			// than turn-end time.
			await daemonHub.emit('messages.statusChanged', {
				sessionId: session.id,
				messageIds: [queuedUser.dbId],
				status: 'sent',
			});

			const { dbId: _dbId, timestamp, ...sdkUserMessage } = queuedUser;
			messageHub.event(
				'state.sdkMessages.delta',
				{
					added: [{ ...sdkUserMessage, timestamp }],
					timestamp: Date.now(),
					version: ++this.sdkMessageDeltaVersion,
				},
				{ channel: `session:${session.id}` }
			);
		}
	}

	/**
	 * Handle message yielded by the generator to the SDK.
	 *
	 * This fires at the EXACT moment the SDK receives a queued user message
	 * (T_consumed). We update the DB and broadcast to UI here, so the message
	 * appears at the correct position in the conversation — after any assistant
	 * messages that were already streamed, and before the assistant's response
	 * to the steering.
	 */
	private handleMessageYielded(messageId: string, sentAt: number): void {
		const { session, db, daemonHub, messageHub } = this.ctx;

		// Find the queued message in DB by UUID
		const queuedMessage = db
			.getMessagesByStatus(session.id, 'queued')
			.find((queued) => queued.uuid === messageId);
		if (!queuedMessage) {
			// Could be a 'saved' message being replayed
			const savedMessage = db
				.getMessagesByStatus(session.id, 'saved')
				.find((saved) => saved.uuid === messageId);
			if (!savedMessage) {
				return; // Not a persisted user message (e.g., already sent)
			}
			// Handle saved message the same way
			db.updateMessageStatus([savedMessage.dbId], 'sent');
			db.updateMessageTimestamp(savedMessage.dbId, sentAt);
			daemonHub
				.emit('messages.statusChanged', {
					sessionId: session.id,
					messageIds: [savedMessage.dbId],
					status: 'sent',
				})
				.catch(() => {});
			this.acknowledgedPersistedUserThisTurn = true;

			const { dbId: _dbId, timestamp: _timestamp, ...sdkMessage } = savedMessage;
			messageHub.event(
				'state.sdkMessages.delta',
				{
					added: [{ ...sdkMessage, timestamp: sentAt }],
					timestamp: sentAt,
					version: ++this.sdkMessageDeltaVersion,
				},
				{ channel: `session:${session.id}` }
			);
			daemonHub
				.emit('sdk.message', {
					sessionId: session.id,
					message: { ...sdkMessage, timestamp: sentAt },
				})
				.catch(() => {});
			return;
		}

		// Update status and timestamp in DB
		db.updateMessageStatus([queuedMessage.dbId], 'sent');
		db.updateMessageTimestamp(queuedMessage.dbId, sentAt);

		// Emit status change event (for queue overlay polling)
		daemonHub
			.emit('messages.statusChanged', {
				sessionId: session.id,
				messageIds: [queuedMessage.dbId],
				status: 'sent',
			})
			.catch(() => {});

		// Mark as acknowledged so fallback path doesn't fire again
		this.acknowledgedPersistedUserThisTurn = true;

		// Broadcast to UI with the correct timestamp
		// Strip DB-only fields before broadcasting
		const { dbId: _dbId, timestamp: _timestamp, ...sdkMessage } = queuedMessage;
		messageHub.event(
			'state.sdkMessages.delta',
			{
				added: [{ ...sdkMessage, timestamp: sentAt }],
				timestamp: sentAt,
				version: ++this.sdkMessageDeltaVersion,
			},
			{ channel: `session:${session.id}` }
		);

		// Emit on DaemonHub for server-side listeners (e.g. group message mirroring)
		// so injected user messages (like leader envelope) appear in the group timeline.
		daemonHub
			.emit('sdk.message', {
				sessionId: session.id,
				message: { ...sdkMessage, timestamp: sentAt },
			})
			.catch(() => {});
	}

	/**
	 * Main entry point - handle incoming SDK message
	 *
	 * NOTE: Stream events removed - the SDK's query() with AsyncGenerator yields
	 * complete messages, not incremental stream_event tokens.
	 */
	async handleMessage(message: SDKMessage): Promise<void> {
		const { session, db, messageHub, stateManager } = this.ctx;

		// Check for API error patterns that indicate an infinite loop
		// This MUST happen BEFORE any other processing to catch errors early
		const circuitBreakerTripped = await this.circuitBreaker.checkMessage(message);
		if (circuitBreakerTripped) {
			// Circuit breaker tripped - skip normal processing
			// The callback will handle stopping the query and notifying the user
			return;
		}

		// Suppress API retry messages: log at daemon level but do not save to DB or broadcast.
		// These carry operational metadata (attempt count, delay, error) that is useful for
		// debugging but should not appear in the transcript or accumulate in the database.
		if (isSDKAPIRetryMessage(message)) {
			this.logger.warn(
				`API retry: attempt ${message.attempt}/${message.max_retries}, ` +
					`delay ${message.retry_delay_ms}ms, status ${message.error_status ?? 'n/a'}, ` +
					`error ${message.error}`
			);
			return;
		}

		// Automatically update phase based on message type
		await stateManager.detectPhaseFromMessage(message);

		// First, correlate internal /context replay by message UUID.
		// This avoids relying on brittle content markers that may change across SDK versions.
		if (this.isInternalContextResponse(message)) {
			// UUID matches an internally queued /context command.
			// Try to parse the context data from this message.
			//
			// NEW SDK behaviour (claude binary >= ~1.0.53): the user replay message
			// contains only the original '/context' text (not the output). The actual
			// context output arrives as a SEPARATE assistant message via sc8(). In that
			// case parseContextResponse returns null here and the content-based check
			// below catches the assistant message on the next iteration.
			//
			// OLD SDK behaviour: the user replay message itself contains the context
			// output wrapped in <local-command-stdout> tags.
			const parsed = await this.handleContextResponseIfParseable(message);

			if (parsed) {
				// Successfully parsed: this message IS the context output.
				this.lastMessageWasContextResponse = true;
				const userMsg = message as { uuid?: string };
				if (userMsg.uuid) {
					this.internalContextCommandIds.delete(userMsg.uuid);
				}
			}
			// Whether parsed or not, suppress saving/broadcasting this internal message
			return;
		}

		// Check if this is a /context response BEFORE saving/emitting.
		// Handles both:
		//   - Old format: user message with isReplay=true + <local-command-stdout>
		//   - New format: assistant message (from sc8()) with raw markdown content
		// /context responses should be processed for context tracking but NOT saved to DB or shown in UI
		const isContextResponse = this.contextFetcher.isContextResponse(message);
		if (isContextResponse) {
			const parsed = await this.handleContextResponseIfParseable(message);
			if (!parsed) {
				// Content-based detection said it looks like context data, but parsing
				// failed — log a warning so the failure is visible.
				this.logger.warn('Failed to parse /context response');
			}
			// Set flag to skip:
			// 1. Queuing another /context for the next result
			// 2. Saving the result message that follows this context response
			this.lastMessageWasContextResponse = true;

			// Clean up the tracked ID if this message carries the same UUID
			// (only possible in old format where the replay IS the output)
			const msg = message as { uuid?: string };
			if (msg.uuid && this.internalContextCommandIds.has(msg.uuid)) {
				this.internalContextCommandIds.delete(msg.uuid);
			}

			// IMPORTANT: Return early to skip saving and emitting this message
			// It's already been processed for context tracking
			return;
		}

		// Fallback guard: if an internal /context command is pending and we get a
		// zero-token result, treat it as the paired internal result even when replay
		// correlation failed (SDK format/UUID drift). This prevents re-queue loops.
		if (this.isZeroTokenResult(message) && this.internalContextCommandIds.size > 0) {
			this.internalContextCommandIds.clear();
			this.lastMessageWasContextResponse = false;
			return;
		}

		// Check if this is a result message immediately following a /context response
		// Skip saving/broadcasting these result messages
		if (message.type === 'result' && this.lastMessageWasContextResponse) {
			// Reset the flag - we've now handled both the context response AND its result
			this.lastMessageWasContextResponse = false;
			// Clear any pending internal context command IDs. In the new SDK format the
			// assistant message that carries context data does NOT match the enqueued UUID,
			// so the UUID stays in the set after the user-replay is processed. Without this
			// clear the stale UUID would prevent auto-queuing /context on subsequent turns.
			this.internalContextCommandIds.clear();
			// Return early - don't save or broadcast this result
			return;
		}

		// For persisted user messages, mark sent + publish now and skip duplicate DB inserts.
		if (await this.acknowledgePersistedUserMessage(message)) {
			return;
		}

		// Mark unmatched SDK user messages as synthetic.
		if (message.type === 'user') {
			(message as SDKUserMessage & { isSynthetic: boolean }).isSynthetic = true;
		}

		// Save to DB FIRST before broadcasting to clients
		// This ensures we only broadcast messages that are successfully persisted
		const savedSuccessfully = db.saveSDKMessage(session.id, message);

		if (!savedSuccessfully) {
			// Log warning but continue - message is already in SDK's memory
			this.logger.warn(`Failed to save message to DB (type: ${message.type})`);
			// Don't broadcast to clients if DB save failed
			return;
		}

		// Broadcast SDK message delta to frontend clients
		messageHub.event(
			'state.sdkMessages.delta',
			{
				added: [message],
				timestamp: Date.now(),
				version: ++this.sdkMessageDeltaVersion,
			},
			{ channel: `session:${session.id}` }
		);

		// Emit on DaemonHub for server-side listeners (e.g. conversation session mirroring)
		await this.ctx.daemonHub.emit('sdk.message', {
			sessionId: session.id,
			message,
		});

		// Handle specific message types
		if (isSDKSystemMessage(message)) {
			await this.handleSystemMessage(message);
		}

		if (isSDKResultSuccess(message)) {
			await this.handleResultMessage(message);
		}

		if (isSDKAssistantMessage(message)) {
			await this.handleAssistantMessage(message);
		}

		if (isSDKStatusMessage(message)) {
			await this.handleStatusMessage(message);
		}

		if (isSDKCompactBoundary(message)) {
			await this.handleCompactBoundary(message);
		}
	}

	/**
	 * Handle system message (capture SDK session ID and slash commands)
	 */
	private async handleSystemMessage(message: SDKMessage): Promise<void> {
		const { session, db, daemonHub } = this.ctx;

		if (!isSDKSystemMessage(message)) return;

		// Capture SDK's internal session ID if we don't have it yet
		// This enables session resumption after daemon restart
		// Guard on isSDKSystemInit so that other system subtypes (api_retry, status, etc.)
		// that also carry session_id cannot accidentally overwrite this field.
		if (isSDKSystemInit(message) && !session.sdkSessionId && message.session_id) {
			// Update in-memory session
			session.sdkSessionId = message.session_id;

			// Persist to database
			db.updateSession(session.id, {
				sdkSessionId: message.session_id,
			});

			// Emit session.updated event so StateManager broadcasts the change
			// Include data for decoupled state management
			await daemonHub.emit('session.updated', {
				sessionId: session.id,
				source: 'sdk-session',
				session: { sdkSessionId: message.session_id },
			});
		}

		// Capture the full slash commands list from the init message.
		// This is the authoritative source — it includes all SDK built-ins plus
		// any custom skills, and fires immediately when a query starts.
		// Use isSDKSystemInit which narrows specifically to SDKSystemMessage (subtype: 'init').
		if (isSDKSystemInit(message) && message.slash_commands?.length > 0) {
			await this.ctx.onInitSlashCommands(message.slash_commands);
		}
	}

	/**
	 * Handle result message (end of turn)
	 */
	private async handleResultMessage(message: SDKMessage): Promise<void> {
		const { session, db, daemonHub, stateManager, messageQueue } = this.ctx;

		// Type guard to ensure this is a successful result
		if (!isSDKResultSuccess(message)) return;

		// Update session metadata with token usage and costs
		const usage = message.usage;
		const totalTokens = usage.input_tokens + usage.output_tokens;

		// SDK's total_cost_usd is CUMULATIVE within a single run, but RESETS when agent restarts
		// (e.g., after errors or manual reset). We detect resets by comparing to lastSdkCost.
		// Example sequence: 0.42 -> 0.73 -> 1.1 (cumulative) -> RESET -> 0.25 -> 0.50 (cumulative again)
		const sdkCost = message.total_cost_usd || 0;
		const lastSdkCost = session.metadata?.lastSdkCost || 0;
		const costBaseline = session.metadata?.costBaseline || 0;

		// Detect SDK reset: if current cost < last cost, SDK was restarted
		// Save previous cumulative cost as new baseline
		let newCostBaseline = costBaseline;
		if (sdkCost < lastSdkCost && lastSdkCost > 0) {
			// SDK reset detected - add previous SDK cost to baseline
			newCostBaseline = costBaseline + lastSdkCost;
		}

		// Total cost = baseline (from previous runs) + current SDK cost (cumulative within this run)
		const totalCost = newCostBaseline + sdkCost;

		session.lastActiveAt = new Date().toISOString();
		session.metadata = {
			...session.metadata,
			messageCount: (session.metadata?.messageCount || 0) + 1,
			totalTokens: (session.metadata?.totalTokens || 0) + totalTokens,
			inputTokens: (session.metadata?.inputTokens || 0) + usage.input_tokens,
			outputTokens: (session.metadata?.outputTokens || 0) + usage.output_tokens,
			// Total cost across all runs (baseline + current SDK cumulative)
			totalCost,
			toolCallCount: session.metadata?.toolCallCount || 0,
			// Track SDK state for reset detection
			lastSdkCost: sdkCost,
			costBaseline: newCostBaseline,
		};

		db.updateSession(session.id, {
			lastActiveAt: session.lastActiveAt,
			metadata: session.metadata,
		});

		// Emit session.updated event so StateManager broadcasts the change
		// Include data for decoupled state management
		await daemonHub.emit('session.updated', {
			sessionId: session.id,
			source: 'metadata',
			session: {
				lastActiveAt: session.lastActiveAt,
				metadata: session.metadata,
			},
		});

		// Queue /context command to get detailed breakdown (unless we just got one)
		// CRITICAL: Check flag to prevent infinite loop!
		// /context produces its own result message, so we must skip queuing another
		// Note: flag is reset when we process the result message (see early return above)
		const isZeroTokenResult = this.isZeroTokenResult(message);
		if (
			!this.lastMessageWasContextResponse &&
			!isZeroTokenResult &&
			this.internalContextCommandIds.size === 0 &&
			this.ctx.contextAutoQueueEnabled
		) {
			// Fire-and-forget: don't await the enqueue. Awaiting blocks
			// handleResultMessage (and the for-await SDK output loop) until the
			// SDK consumes /context from the prompt generator. If other user
			// messages are ahead in the queue, they must be processed first,
			// which can exceed the 30s MESSAGE_QUEUE_TIMEOUT and cause those
			// messages to be dropped + reset.
			const contextMessageId = generateUUID();
			this.internalContextCommandIds.add(contextMessageId);
			messageQueue.enqueueWithId(contextMessageId, '/context', true).catch((error) => {
				this.internalContextCommandIds.delete(contextMessageId);
				this.logger.warn('Failed to queue /context:', error);
			});
		}

		// Mark successful API interaction - resets circuit breaker error tracking
		// Only reset when actual tokens were consumed (indicating a real API call)
		// Zero-token results happen when SDK processes synthetic error messages without
		// making an API call - these should NOT reset the circuit breaker
		if (usage.input_tokens > 0 || usage.output_tokens > 0) {
			this.circuitBreaker.markSuccess();
		}

		// If SDK didn't replay the queued user message this turn, acknowledge one
		// queued user message at turn end to keep status and transcript in sync.
		if (!this.acknowledgedPersistedUserThisTurn) {
			await this.acknowledgeOldestQueuedUserOnTurnEnd();
		}
		this.acknowledgedPersistedUserThisTurn = false;

		// Clear any session errors since we successfully completed a turn
		// This resolves persistent error banners that weren't being cleared
		await daemonHub.emit('session.errorClear', {
			sessionId: session.id,
		});

		// Set state back to idle
		// Note: Title generation now handled by TitleGenerationQueue (decoupled via EventBus)
		await stateManager.setIdle();

		// Auto-dispatch saved messages in immediate mode (next-turn queue replay)
		if (session.config.queryMode !== 'manual') {
			try {
				await daemonHub.emit('query.trigger', { sessionId: session.id });
			} catch (error) {
				this.logger.warn('Failed to dispatch saved messages on turn end:', error);
			}
		}
	}

	/**
	 * Handle assistant message (track tool calls)
	 *
	 * NOTE: AskUserQuestion is now handled via the canUseTool callback in
	 * AskUserQuestionHandler, not here. The SDK intercepts it BEFORE execution.
	 */
	private async handleAssistantMessage(message: SDKMessage): Promise<void> {
		const { session, db, daemonHub } = this.ctx;

		if (!isSDKAssistantMessage(message)) return;

		const toolCalls = message.message.content.filter(isToolUseBlock);
		if (toolCalls.length > 0) {
			session.metadata = {
				...session.metadata,
				toolCallCount: (session.metadata?.toolCallCount || 0) + toolCalls.length,
			};
			db.updateSession(session.id, {
				metadata: session.metadata,
			});

			// Emit session.updated event so StateManager broadcasts the change
			// Include data for decoupled state management
			await daemonHub.emit('session.updated', {
				sessionId: session.id,
				source: 'metadata',
				session: { metadata: session.metadata },
			});
		}
	}

	/**
	 * Handle status message (detect compaction start)
	 */
	private async handleStatusMessage(message: SDKMessage): Promise<void> {
		const { stateManager } = this.ctx;

		if (!isSDKStatusMessage(message)) return;

		const statusMsg = message as { status: string | null };
		if (statusMsg.status === 'compacting') {
			// Set isCompacting flag on processing state (flows through state.session)
			await stateManager.setCompacting(true);
		}
	}

	/**
	 * Handle compact boundary message (compaction completed)
	 */
	private async handleCompactBoundary(message: SDKMessage): Promise<void> {
		const { stateManager } = this.ctx;

		if (!isSDKCompactBoundary(message)) return;

		// Clear isCompacting flag on processing state (flows through state.session)
		await stateManager.setCompacting(false);
	}

	/**
	 * Attempt to parse and handle a /context response.
	 *
	 * Returns true if the message was successfully parsed as context data.
	 * Returns false if the message did not contain parseable context data
	 * (e.g. it is a plain user acknowledgment of the /context command rather
	 * than the actual output — which happens in the new SDK format where a
	 * user replay carries the original '/context' text, not the output).
	 */
	private async handleContextResponseIfParseable(message: SDKMessage): Promise<boolean> {
		const { session, daemonHub, contextTracker } = this.ctx;

		const parsedContext = this.contextFetcher.parseContextResponse(message);
		if (!parsedContext) {
			return false;
		}

		const contextInfo = this.contextFetcher.toContextInfo(parsedContext);

		// Persist to session metadata
		contextTracker.updateWithDetailedBreakdown(contextInfo);

		// Emit context update event via DaemonHub
		// StateManager will broadcast this via state.session channel
		await daemonHub.emit('context.updated', {
			sessionId: session.id,
			contextInfo,
		});
		return true;
	}
}
