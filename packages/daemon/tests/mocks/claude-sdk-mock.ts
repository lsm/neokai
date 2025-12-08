/**
 * Mock for @anthropic-ai/claude-agent-sdk
 *
 * This mock allows testing AgentSession and related functionality
 * without requiring actual API credentials.
 */

import { mock } from 'bun:test';
import type { UUID } from 'crypto';

/**
 * Mock SDK message types (simplified versions of the real SDK types)
 */
export interface MockSDKUserMessage {
	type: 'user';
	uuid: UUID;
	session_id: string;
	parent_tool_use_id: null;
	message: {
		role: 'user';
		content: string | unknown[];
	};
}

export interface MockSDKAssistantMessage {
	type: 'assistant';
	uuid: UUID;
	session_id: string;
	message: {
		role: 'assistant';
		content: Array<{
			type: 'text';
			text: string;
		}>;
		model: string;
		stop_reason: string;
		stop_sequence: null;
		usage: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens: number;
			cache_read_input_tokens: number;
		};
	};
}

export interface MockSDKResultMessage {
	type: 'result';
	uuid: UUID;
	session_id: string;
	is_error: boolean;
	num_turns: number;
	subagent_results: unknown[];
}

export type MockSDKMessage = MockSDKUserMessage | MockSDKAssistantMessage | MockSDKResultMessage;

/**
 * Mock Query object that simulates SDK behavior
 */
export class MockQuery implements AsyncIterable<MockSDKMessage> {
	private messages: MockSDKMessage[] = [];
	private aborted = false;
	private inputGenerator: AsyncGenerator<unknown> | null = null;
	private resolvers: Array<(value: IteratorResult<MockSDKMessage>) => void> = [];

	constructor(
		private options: {
			prompt: AsyncGenerator<unknown> | string;
			options?: {
				model?: string;
				cwd?: string;
				abortController?: AbortController;
				permissionMode?: string;
				allowDangerouslySkipPermissions?: boolean;
				maxTurns?: number;
			};
		}
	) {
		// Store the input generator if it's an AsyncGenerator
		if (typeof options.prompt !== 'string' && Symbol.asyncIterator in options.prompt) {
			this.inputGenerator = options.prompt as AsyncGenerator<unknown>;
		}

		// Listen for abort signal
		if (options.options?.abortController) {
			options.options.abortController.signal.addEventListener('abort', () => {
				this.aborted = true;
				// Resolve any waiting iterators
				this.resolvers.forEach((resolve) => resolve({ value: undefined, done: true }));
				this.resolvers = [];
			});
		}
	}

	/**
	 * Simulate receiving a message from the input generator and responding
	 */
	async processNextInput(): Promise<MockSDKMessage | null> {
		if (!this.inputGenerator || this.aborted) {
			return null;
		}

		const result = await this.inputGenerator.next();
		if (result.done) {
			return null;
		}

		const userMessage = result.value as MockSDKUserMessage;
		const sessionId = userMessage.session_id;

		// Create a mock assistant response
		const assistantMessage: MockSDKAssistantMessage = {
			type: 'assistant',
			uuid: crypto.randomUUID() as UUID,
			session_id: sessionId,
			message: {
				role: 'assistant',
				content: [
					{
						type: 'text',
						text: `Mock response to: ${typeof userMessage.message.content === 'string' ? userMessage.message.content : '[complex content]'}`,
					},
				],
				model: this.options.options?.model || 'claude-sonnet-4-20250514',
				stop_reason: 'end_turn',
				stop_sequence: null,
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			},
		};

		// Create a mock result message
		const resultMessage: MockSDKResultMessage = {
			type: 'result',
			uuid: crypto.randomUUID() as UUID,
			session_id: sessionId,
			is_error: false,
			num_turns: 1,
			subagent_results: [],
		};

		// Add messages to queue
		this.messages.push(assistantMessage, resultMessage);

		return assistantMessage;
	}

	/**
	 * Emit a custom message to the stream
	 */
	emit(message: MockSDKMessage): void {
		this.messages.push(message);
		// Wake up any waiting iterators
		if (this.resolvers.length > 0 && this.messages.length > 0) {
			const resolver = this.resolvers.shift()!;
			const msg = this.messages.shift()!;
			resolver({ value: msg, done: false });
		}
	}

	/**
	 * Get slash commands (mock implementation)
	 */
	getSlashCommands(): string[] {
		return ['/help', '/clear', '/model'];
	}

	/**
	 * Abort the query
	 */
	abort(): void {
		this.aborted = true;
	}

	/**
	 * AsyncIterator implementation
	 */
	async *[Symbol.asyncIterator](): AsyncGenerator<MockSDKMessage> {
		while (!this.aborted) {
			// Check for queued messages first
			if (this.messages.length > 0) {
				yield this.messages.shift()!;
				continue;
			}

			// Try to process next input from generator
			if (this.inputGenerator) {
				const response = await this.processNextInput();
				if (response) {
					// Yield the queued messages (assistant + result)
					while (this.messages.length > 0) {
						yield this.messages.shift()!;
					}
					continue;
				}
			}

			// Wait for new messages or abort
			const result = await new Promise<IteratorResult<MockSDKMessage>>((resolve) => {
				this.resolvers.push(resolve);
				// Timeout to allow checking abort status
				setTimeout(() => {
					const idx = this.resolvers.indexOf(resolve);
					if (idx >= 0) {
						this.resolvers.splice(idx, 1);
						if (this.aborted) {
							resolve({ value: undefined, done: true });
						} else if (this.messages.length > 0) {
							resolve({ value: this.messages.shift()!, done: false });
						}
					}
				}, 100);
			});

			if (result.done) {
				return;
			}
			if (result.value) {
				yield result.value;
			}
		}
	}
}

/**
 * Mock query function that creates a MockQuery
 */
export function mockQuery(options: {
	prompt: AsyncGenerator<unknown> | string;
	options?: {
		model?: string;
		cwd?: string;
		abortController?: AbortController;
		permissionMode?: string;
		allowDangerouslySkipPermissions?: boolean;
		maxTurns?: number;
	};
}): MockQuery {
	return new MockQuery(options);
}

/**
 * Create a mock for the claude-agent-sdk module
 */
export function createClaudeSDKMock() {
	return {
		query: mock(mockQuery),
	};
}

/**
 * Install the mock - call this before importing modules that use the SDK
 */
export async function installClaudeSDKMock(): Promise<ReturnType<typeof createClaudeSDKMock>> {
	const sdkMock = createClaudeSDKMock();

	// Use Bun's module mocking
	const { mock: bunMock } = await import('bun:test');

	bunMock.module('@anthropic-ai/claude-agent-sdk', () => sdkMock);

	return sdkMock;
}

/**
 * Helper to generate a mock UUID
 */
export function mockUUID(): UUID {
	return crypto.randomUUID() as UUID;
}
