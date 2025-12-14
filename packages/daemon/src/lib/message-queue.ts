/**
 * MessageQueue - Async message queue for SDK streaming input
 *
 * Provides AsyncGenerator interface for Claude SDK's streaming input mode.
 * Messages are queued and yielded to the SDK as they arrive.
 */

import type { UUID } from 'crypto';
import type { MessageContent } from '@liuboer/shared';
import type { SDKUserMessage } from '@liuboer/shared/sdk';
import { generateUUID } from '@liuboer/shared';

/**
 * Queued message waiting to be sent to Claude
 */
interface QueuedMessage {
	id: string;
	content: string | MessageContent[];
	timestamp: string;
	resolve: (messageId: string) => void;
	reject: (error: Error) => void;
	internal?: boolean; // If true, don't save to DB or emit to client
}

export class MessageQueue {
	private queue: QueuedMessage[] = [];
	private waiters: Array<() => void> = [];
	private running: boolean = false;

	/**
	 * Enqueue a message to be sent to Claude via the streaming query
	 */
	async enqueue(content: string | MessageContent[], internal: boolean = false): Promise<string> {
		const messageId = generateUUID();
		await this.enqueueWithId(messageId, content, internal);
		return messageId;
	}

	/**
	 * Enqueue a message with a pre-generated ID
	 * Used when caller needs the ID before the message is processed (e.g., for state tracking)
	 */
	async enqueueWithId(
		messageId: string,
		content: string | MessageContent[],
		internal: boolean = false
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const queuedMessage: QueuedMessage = {
				id: messageId,
				content,
				timestamp: new Date().toISOString(),
				resolve: () => resolve(),
				reject,
				internal,
			};

			this.queue.push(queuedMessage);

			// Wake up any waiting message generators
			this.waiters.forEach((waiter) => waiter());
			this.waiters = [];
		});
	}

	/**
	 * Clear all pending messages (used during interrupt)
	 */
	clear(): void {
		// Reject all pending messages
		for (const msg of this.queue) {
			msg.reject(new Error('Interrupted by user'));
		}
		this.queue = [];
	}

	/**
	 * Get queue size (for monitoring)
	 */
	size(): number {
		return this.queue.length;
	}

	/**
	 * Start the message queue (allows messages to be yielded)
	 */
	start(): void {
		this.running = true;
	}

	/**
	 * Stop the message queue (prevents new messages from being yielded)
	 */
	stop(): void {
		this.running = false;
		// Wake up any waiting generators so they can exit
		this.waiters.forEach((waiter) => waiter());
		this.waiters = [];
	}

	/**
	 * Check if queue is running
	 */
	isRunning(): boolean {
		return this.running;
	}

	/**
	 * AsyncGenerator that yields messages continuously from the queue
	 * This is the heart of streaming input mode!
	 *
	 * Returns an object with the message and a callback to mark it as sent.
	 * The callback resolves the promise returned by enqueue().
	 */
	async *messageGenerator(
		sessionId: string
	): AsyncGenerator<{ message: SDKUserMessage; onSent: () => void }> {
		while (this.running) {
			const queuedMessage = await this.waitForNextMessage();

			if (!queuedMessage) {
				break;
			}

			// Prepare the SDK user message
			const sdkUserMessage: SDKUserMessage & { internal?: boolean } = {
				type: 'user' as const,
				uuid: queuedMessage.id as UUID,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					role: 'user' as const,
					content:
						typeof queuedMessage.content === 'string'
							? [{ type: 'text' as const, text: queuedMessage.content }]
							: queuedMessage.content,
				},
				internal: queuedMessage.internal,
			};

			// Yield message with callback
			yield {
				message: sdkUserMessage,
				onSent: () => queuedMessage.resolve(queuedMessage.id),
			};
		}
	}

	/**
	 * Wait for the next message to be enqueued
	 */
	private async waitForNextMessage(): Promise<QueuedMessage | null> {
		while (this.running && this.queue.length === 0) {
			// Wait for message to be enqueued
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
				// Also wake up after timeout to check running status
				setTimeout(resolve, 1000);
			});

			if (!this.running) return null;
		}

		return this.queue.shift() || null;
	}
}
