/**
 * ContextTracker - Real-time context window usage tracking
 *
 * Tracks token usage during streaming by processing:
 * - message_start events (input tokens = total context being sent to Claude)
 * - message_delta events (cumulative output tokens during streaming)
 * - result messages (final authoritative usage with cache information)
 *
 * KEY INSIGHT: At message_start, input_tokens represents the TOTAL tokens
 * being sent to Claude for this turn. This includes:
 * - System prompt
 * - Tool definitions
 * - Complete conversation history
 * - Current user input
 *
 * This is exactly what we need to calculate context window usage!
 */

import type {
	ContextInfo,
	ContextCategoryBreakdown,
	ContextAPIUsage,
	EventBus,
} from '@liuboer/shared';
import type { ModelUsage } from '@liuboer/shared/sdk';
import { Logger } from '../logger';

interface UsageData {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

export class ContextTracker {
	/**
	 * Current context info - the latest snapshot of context window usage
	 * Updated in real-time during streaming for live UI updates
	 */
	private currentContextInfo: ContextInfo | null = null;

	/**
	 * Context window size for the current model (in tokens)
	 * Set from SDK's modelUsage when available, defaults to 200K
	 */
	private contextWindowSize: number = 200000;

	/**
	 * Current turn's input tokens (from message_start)
	 * This represents TOTAL context being sent to Claude for this turn
	 */
	private currentTurnInputTokens: number = 0;

	/**
	 * Current turn's output tokens (from message_delta, cumulative)
	 * Updated during streaming
	 */
	private currentTurnOutputTokens: number = 0;

	/**
	 * Throttle interval for context updates during streaming (ms)
	 * Prevents flooding clients with updates
	 */
	private contextUpdateThrottleMs: number = 250;
	private lastContextUpdateTime: number = 0;

	private logger: Logger;

	constructor(
		private sessionId: string,
		private model: string,
		private eventBus: EventBus,
		private persistContext: (info: ContextInfo) => void
	) {
		this.logger = new Logger(`ContextTracker ${sessionId}`);
	}

	/**
	 * Get current context info
	 */
	getContextInfo(): ContextInfo | null {
		return this.currentContextInfo;
	}

	/**
	 * Restore context info from session metadata (on session load)
	 */
	restoreFromMetadata(savedContext: ContextInfo): void {
		this.currentContextInfo = savedContext;
		this.logger.log('Restored context info from session metadata');
	}

	/**
	 * Update context info with detailed breakdown from /context command
	 * This replaces the stream-based tracking with more detailed data from SDK
	 */
	updateWithDetailedBreakdown(contextInfo: ContextInfo): void {
		this.currentContextInfo = contextInfo;
		this.persistContext(contextInfo);
		this.logger.log(
			`Updated context with detailed breakdown: ${contextInfo.totalUsed}/${contextInfo.totalCapacity} tokens ` +
				`(${contextInfo.percentUsed}%) with ${Object.keys(contextInfo.breakdown).length} categories`
		);
	}

	/**
	 * Update model (when model is switched)
	 */
	setModel(model: string): void {
		this.model = model;
		// Context window size will be updated from next SDK response
	}

	/**
	 * Process stream events for context tracking
	 * Extracts usage from RawMessageStreamEvent
	 */
	async processStreamEvent(event: unknown): Promise<void> {
		// Type guard for the event structure
		const streamEvent = event as {
			type: string;
			message?: {
				usage?: { input_tokens: number; output_tokens: number };
			};
			usage?: { output_tokens: number };
		};

		try {
			// message_start: Contains initial input_tokens (total context)
			if (streamEvent.type === 'message_start' && streamEvent.message?.usage) {
				await this.handleMessageStartUsage(streamEvent.message.usage);
			}

			// message_delta: Contains cumulative output_tokens
			if (streamEvent.type === 'message_delta' && streamEvent.usage) {
				await this.handleMessageDeltaUsage(streamEvent.usage);
			}
		} catch (error) {
			// Don't let context tracking errors break the main flow
			this.logger.warn('Error processing stream event for context:', error);
		}
	}

	/**
	 * Handle final result with complete token usage
	 * This is the authoritative source - use it to update our tracking
	 */
	async handleResultUsage(
		usage: UsageData,
		modelUsage?: Record<string, ModelUsage>
	): Promise<void> {
		// Track web search requests from SDK (SDK 0.1.69+)
		let webSearchRequests: number | undefined;

		// Update context window size if SDK provides it
		if (modelUsage) {
			const modelName = Object.keys(modelUsage)[0];
			if (modelName) {
				const modelData = modelUsage[modelName];
				if (modelData?.contextWindow) {
					this.contextWindowSize = modelData.contextWindow;
					this.logger.log(`Updated context window size from SDK: ${this.contextWindowSize}`);
				}
				// SDK 0.1.69+ provides webSearchRequests
				if (typeof modelData?.webSearchRequests === 'number') {
					webSearchRequests = modelData.webSearchRequests;
				}
			}
		}

		// Store accurate final values for this turn
		this.currentTurnInputTokens = usage.input_tokens;
		this.currentTurnOutputTokens = usage.output_tokens;

		// Build context info with cache information
		const apiUsage: ContextAPIUsage = {
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: usage.cache_read_input_tokens || 0,
			cacheCreationTokens: usage.cache_creation_input_tokens || 0,
			webSearchRequests,
		};

		// Force broadcast (not throttled) since this is the final accurate data
		await this.buildAndBroadcastContextInfo('result', false, apiUsage);
	}

	/**
	 * Handle message_start stream event
	 * This contains the TOTAL input tokens for this turn
	 */
	private async handleMessageStartUsage(usage: {
		input_tokens: number;
		output_tokens: number;
	}): Promise<void> {
		this.currentTurnInputTokens = usage.input_tokens;
		this.currentTurnOutputTokens = usage.output_tokens; // Usually 1 at start

		// Build and broadcast initial context info for this turn
		await this.buildAndBroadcastContextInfo('message_start');
	}

	/**
	 * Handle message_delta stream event
	 * This contains the cumulative output tokens for this turn
	 */
	private async handleMessageDeltaUsage(usage: { output_tokens: number }): Promise<void> {
		this.currentTurnOutputTokens = usage.output_tokens; // Cumulative

		// Throttled broadcast to avoid flooding
		await this.buildAndBroadcastContextInfo('message_delta', true);
	}

	/**
	 * Build ContextInfo and broadcast to clients
	 *
	 * PERSISTENCE: Context info is saved to session metadata so it survives:
	 * - Page refreshes
	 * - Session reconnects
	 * - Server restarts
	 */
	private async buildAndBroadcastContextInfo(
		source: 'message_start' | 'message_delta' | 'result',
		throttle: boolean = false,
		apiUsage?: ContextAPIUsage
	): Promise<void> {
		// Throttle check
		if (throttle) {
			const now = Date.now();
			if (now - this.lastContextUpdateTime < this.contextUpdateThrottleMs) {
				return; // Skip this update, too soon
			}
			this.lastContextUpdateTime = now;
		}

		// Calculate total tokens in use
		const totalUsed = this.currentTurnInputTokens + this.currentTurnOutputTokens;
		const percentUsed = (totalUsed / this.contextWindowSize) * 100;

		// Build breakdown
		const breakdown = this.calculateBreakdown(totalUsed);

		// Create context info
		this.currentContextInfo = {
			model: this.model,
			totalUsed,
			totalCapacity: this.contextWindowSize,
			percentUsed: Math.min(percentUsed, 100), // Cap at 100%
			breakdown,
			apiUsage,
		};

		// Persist to session metadata (callback provided by AgentSession)
		this.persistContext(this.currentContextInfo);

		// Emit context update event via EventBus
		// StateManager will broadcast this via state.session channel
		await this.eventBus.emit('context:updated', {
			sessionId: this.sessionId,
			contextInfo: this.currentContextInfo,
		});

		// Log for debugging (only on result or significant changes)
		if (source === 'result' || (source === 'message_start' && this.currentTurnInputTokens > 0)) {
			this.logger.log(
				`Context updated (${source}): ${totalUsed}/${this.contextWindowSize} tokens (${percentUsed.toFixed(1)}%)`
			);
		}
	}

	/**
	 * Calculate category breakdown for context usage
	 *
	 * Uses ONLY accurate data from SDK - no estimates:
	 * - Input: Total tokens sent to Claude (system + tools + conversation)
	 * - Output: Tokens generated by Claude
	 * - Free Space: Remaining context window
	 */
	private calculateBreakdown(totalUsed: number): Record<string, ContextCategoryBreakdown> {
		const freeSpace = this.contextWindowSize - totalUsed;

		// Calculate percentages relative to capacity
		const calcPercent = (tokens: number) => (tokens / this.contextWindowSize) * 100;

		return {
			'Input Context': {
				tokens: this.currentTurnInputTokens,
				percent: calcPercent(this.currentTurnInputTokens),
			},
			'Output Tokens': {
				tokens: this.currentTurnOutputTokens,
				percent: calcPercent(this.currentTurnOutputTokens),
			},
			'Free Space': {
				tokens: Math.max(0, freeSpace),
				percent: Math.max(0, calcPercent(freeSpace)),
			},
		};
	}
}
