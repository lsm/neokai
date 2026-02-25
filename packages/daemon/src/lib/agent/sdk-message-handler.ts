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

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { UUID } from 'crypto';
import type { Session, MessageHub } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import {
	isSDKResultSuccess,
	isSDKAssistantMessage,
	isToolUseBlock,
	isSDKStatusMessage,
	isSDKCompactBoundary,
	isSDKSystemMessage,
	isSDKSystemInit,
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

	// Called when the SDK init message provides the full slash commands list
	onInitSlashCommands: (commands: string[]) => Promise<void>;
}

export class SDKMessageHandler {
	private sdkMessageDeltaVersion: number = 0;
	private logger: Logger;
	private contextFetcher: ContextFetcher;
	private circuitBreaker: ApiErrorCircuitBreaker;

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
			await daemonHub.emit('session.errorClear', { sessionId: session.id });

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

		// Automatically update phase based on message type
		await stateManager.detectPhaseFromMessage(message);

		// First, correlate internal /context replay by message UUID.
		// This avoids relying on brittle content markers that may change across SDK versions.
		if (this.isInternalContextResponse(message)) {
			await this.handleContextResponse(message);
			// Skip:
			// 1. Queuing another /context for the paired result
			// 2. Saving/broadcasting this internal replay message
			this.lastMessageWasContextResponse = true;

			const userMsg = message as { uuid?: string };
			if (userMsg.uuid) {
				this.internalContextCommandIds.delete(userMsg.uuid);
			}
			return;
		}

		// Check if this is a /context response BEFORE saving/emitting
		// /context responses should be processed for context tracking but NOT saved to DB or shown in UI
		const isContextResponse = this.contextFetcher.isContextResponse(message);
		if (isContextResponse) {
			await this.handleContextResponse(message);
			// Set flag to skip:
			// 1. Queuing another /context for the next result
			// 2. Saving the result message that follows this context response
			this.lastMessageWasContextResponse = true;

			// Clean up the tracked ID if this is the response
			const userMsg = message as { uuid?: string };
			if (userMsg.uuid && this.internalContextCommandIds.has(userMsg.uuid)) {
				this.internalContextCommandIds.delete(userMsg.uuid);
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
			// Return early - don't save or broadcast this result
			return;
		}

		// Mark all user messages from SDK as synthetic
		// Real user messages are saved in the message generator, not here
		// SDK only emits user messages for synthetic purposes (compaction, subagent context, etc.)
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

		// Broadcast SDK message delta (only channel - sdk.message removed as redundant)
		messageHub.event(
			'state.sdkMessages.delta',
			{
				added: [message],
				timestamp: Date.now(),
				version: ++this.sdkMessageDeltaVersion,
			},
			{ channel: `session:${session.id}` }
		);

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
		if (!session.sdkSessionId && message.session_id) {
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
		const { session, db, daemonHub, contextTracker, stateManager, messageQueue } = this.ctx;

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
			this.internalContextCommandIds.size === 0
		) {
			try {
				// Queue as internal message (won't be saved to DB or broadcast as user message)
				const messageId = await messageQueue.enqueue('/context', true);
				// Track this ID so we can skip the result message
				this.internalContextCommandIds.add(messageId);
			} catch (error) {
				// Non-critical - just log the error
				this.logger.warn('Failed to queue /context:', error);
			}
		}

		// Mark successful API interaction - resets circuit breaker error tracking
		// Only reset when actual tokens were consumed (indicating a real API call)
		// Zero-token results happen when SDK processes synthetic error messages without
		// making an API call - these should NOT reset the circuit breaker
		if (usage.input_tokens > 0 || usage.output_tokens > 0) {
			this.circuitBreaker.markSuccess();
		}

		// Clear any session errors since we successfully completed a turn
		// This resolves persistent error banners that weren't being cleared
		await daemonHub.emit('session.errorClear', {
			sessionId: session.id,
		});

		// Set state back to idle
		// Note: Title generation now handled by TitleGenerationQueue (decoupled via EventBus)
		await stateManager.setIdle();
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
	 * Handle /context response
	 * Parse the detailed breakdown and update context tracker
	 */
	private async handleContextResponse(message: SDKMessage): Promise<void> {
		const { session, daemonHub, contextTracker } = this.ctx;

		const parsedContext = this.contextFetcher.parseContextResponse(message);
		if (!parsedContext) {
			this.logger.warn('Failed to parse /context response');
			return;
		}

		const contextInfo = this.contextFetcher.toContextInfo(parsedContext);

		// Update ContextTracker - persists to session metadata
		contextTracker.updateWithDetailedBreakdown(contextInfo);

		// Emit context update event via DaemonHub
		// StateManager will broadcast this via state.session channel
		await daemonHub.emit('context.updated', {
			sessionId: session.id,
			contextInfo,
		});
	}
}
