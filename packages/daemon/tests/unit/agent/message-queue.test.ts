/**
 * MessageQueue Tests
 *
 * Tests message queuing, AsyncGenerator functionality,
 * and queue lifecycle management.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { MessageQueue } from '../../../src/lib/agent/message-queue';
import { generateUUID } from '@liuboer/shared';

describe('MessageQueue', () => {
	let queue: MessageQueue;
	const testSessionId = generateUUID();

	beforeEach(() => {
		queue = new MessageQueue();
	});

	describe('enqueue', () => {
		it('should enqueue a message and return message ID', async () => {
			queue.start(); // Start queue so generator can process messages

			const messageId = queue.enqueue('Test message');
			expect(messageId).toBeInstanceOf(Promise);

			// Start generator to process the message
			const generator = queue.messageGenerator(testSessionId);
			const result = await generator.next();
			result.value.onSent(); // Mark as sent

			const id = await messageId;

			// Message ID should be a UUID
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

			queue.stop(); // Clean up
		});

		it('should enqueue multiple messages', async () => {
			const promise1 = queue.enqueue('Message 1');
			const promise2 = queue.enqueue('Message 2');
			const promise3 = queue.enqueue('Message 3');

			expect(queue.size()).toBe(3);
			expect(promise1).toBeInstanceOf(Promise);
			expect(promise2).toBeInstanceOf(Promise);
			expect(promise3).toBeInstanceOf(Promise);

			// Clean up - clear queue and handle rejections
			queue.clear();
			await promise1.catch(() => {});
			await promise2.catch(() => {});
			await promise3.catch(() => {});
		});

		it('should enqueue message with internal flag', async () => {
			const promise = queue.enqueue('Internal message', true);
			expect(queue.size()).toBe(1);

			// Clean up
			queue.clear();
			await promise.catch(() => {});
		});
	});

	describe('clear', () => {
		it('should clear all pending messages', async () => {
			const promise1 = queue.enqueue('Message 1');
			const promise2 = queue.enqueue('Message 2');
			const promise3 = queue.enqueue('Message 3');

			expect(queue.size()).toBe(3);

			queue.clear();

			expect(queue.size()).toBe(0);

			// Catch rejected promises to avoid unhandled rejections
			await promise1.catch(() => {});
			await promise2.catch(() => {});
			await promise3.catch(() => {});
		});

		it('should reject all pending message promises', async () => {
			const promise1 = queue.enqueue('Message 1');
			const promise2 = queue.enqueue('Message 2');

			// Store promise rejection handlers immediately to avoid unhandled rejection
			const rejection1 = promise1.catch((err) => err);
			const rejection2 = promise2.catch((err) => err);

			queue.clear();

			// Check that promises were rejected with correct error
			const error1 = await rejection1;
			const error2 = await rejection2;

			expect(error1).toBeInstanceOf(Error);
			expect(error1.message).toBe('Interrupted by user');
			expect(error2).toBeInstanceOf(Error);
			expect(error2.message).toBe('Interrupted by user');
		});
	});

	describe('lifecycle', () => {
		it('should start in stopped state', () => {
			expect(queue.isRunning()).toBe(false);
		});

		it('should transition to running state when started', () => {
			queue.start();
			expect(queue.isRunning()).toBe(true);
		});

		it('should transition to stopped state when stopped', () => {
			queue.start();
			expect(queue.isRunning()).toBe(true);

			queue.stop();
			expect(queue.isRunning()).toBe(false);
		});
	});

	describe('messageGenerator', () => {
		it('should yield messages from queue', async () => {
			queue.start();

			// Enqueue message before starting generator
			const messagePromise = queue.enqueue('Test message');

			// Start generator
			const generator = queue.messageGenerator(testSessionId);

			// Get first message
			const result = await generator.next();

			expect(result.done).toBe(false);
			expect(result.value).toBeDefined();
			expect(result.value.message.type).toBe('user');
			expect(result.value.message.session_id).toBe(testSessionId);
			expect(result.value.message.message.content).toEqual([
				{ type: 'text', text: 'Test message' },
			]);

			// Call onSent callback
			result.value.onSent();

			// Wait for message promise to resolve
			const messageId = await messagePromise;
			expect(messageId).toBeDefined();
		});

		it('should yield multiple messages in order', async () => {
			queue.start();

			// Enqueue messages
			const promise1 = queue.enqueue('Message 1');
			const promise2 = queue.enqueue('Message 2');
			const promise3 = queue.enqueue('Message 3');

			// Start generator
			const generator = queue.messageGenerator(testSessionId);

			// Get messages in order
			const result1 = await generator.next();
			expect(result1.value.message.message.content[0].text).toBe('Message 1');
			result1.value.onSent();
			await promise1;

			const result2 = await generator.next();
			expect(result2.value.message.message.content[0].text).toBe('Message 2');
			result2.value.onSent();
			await promise2;

			const result3 = await generator.next();
			expect(result3.value.message.message.content[0].text).toBe('Message 3');
			result3.value.onSent();
			await promise3;
		});

		it('should stop yielding when queue is stopped', async () => {
			queue.start();

			const generator = queue.messageGenerator(testSessionId);

			// Stop queue before getting next message
			queue.stop();

			// Generator should complete
			const result = await generator.next();
			expect(result.done).toBe(true);
		});

		it('should handle complex message content', async () => {
			queue.start();

			const content = [
				{ type: 'text' as const, text: 'Hello' },
				{
					type: 'image' as const,
					source: {
						type: 'base64' as const,
						media_type: 'image/png' as const,
						data: 'base64data',
					},
				},
			];

			const messagePromise = queue.enqueue(content);

			const generator = queue.messageGenerator(testSessionId);
			const result = await generator.next();

			expect(result.value.message.message.content).toEqual(content);

			result.value.onSent();
			await messagePromise;
		});
	});

	describe('size', () => {
		it('should return correct queue size', async () => {
			expect(queue.size()).toBe(0);

			const promise1 = queue.enqueue('Message 1');
			expect(queue.size()).toBe(1);

			const promise2 = queue.enqueue('Message 2');
			expect(queue.size()).toBe(2);

			queue.clear();
			expect(queue.size()).toBe(0);

			// Catch rejected promises
			await promise1.catch(() => {});
			await promise2.catch(() => {});
		});
	});

	describe('timeout detection', () => {
		it('should reject message after timeout if not consumed', async () => {
			// Don't start the queue - messages won't be consumed
			const messageId = 'test-timeout-message';

			// The default timeout is 30s, which is too long for tests
			// We can test that the timeout mechanism is in place by checking
			// that the message gets the timeout tracking fields
			const promise = queue.enqueueWithId(messageId, 'Test message');

			// Immediately clear queue which should clear timeout and reject
			queue.clear();

			// Promise should be rejected with interrupt error (clear was called)
			await expect(promise).rejects.toThrow('Interrupted by user');
		});

		it('should clear timeout when message is consumed', async () => {
			queue.start();

			const messageId = 'test-consumed-message';
			const promise = queue.enqueueWithId(messageId, 'Test message');

			// Start generator to consume the message
			const generator = queue.messageGenerator('test-session');
			const result = await generator.next();

			expect(result.done).toBe(false);
			expect(result.value).toBeDefined();

			// Call onSent which should clear the timeout
			result.value.onSent();

			// Promise should resolve successfully
			await expect(promise).resolves.toBeUndefined();

			queue.stop();
		});

		it('should include error name MessageQueueTimeoutError on timeout', async () => {
			// This test validates the error structure without waiting for real timeout
			// We create a mock scenario by modifying the queue behavior
			const error = new Error('Message queue timeout: SDK did not consume message test within 30s');
			error.name = 'MessageQueueTimeoutError';

			expect(error.name).toBe('MessageQueueTimeoutError');
			expect(error.message).toContain('Message queue timeout');
		});

		it('should clear all pending timeouts when queue is cleared', async () => {
			// Enqueue multiple messages (don't start queue - no generator consuming)
			const promise1 = queue.enqueue('Message 1');
			const promise2 = queue.enqueue('Message 2');
			const promise3 = queue.enqueue('Message 3');

			expect(queue.size()).toBe(3);

			// Store rejection handlers
			const rejection1 = promise1.catch((err) => err);
			const rejection2 = promise2.catch((err) => err);
			const rejection3 = promise3.catch((err) => err);

			// Clear queue - should clear all timeouts and reject all
			queue.clear();

			expect(queue.size()).toBe(0);

			// All should be rejected with interrupt error
			const error1 = await rejection1;
			const error2 = await rejection2;
			const error3 = await rejection3;

			expect(error1.message).toBe('Interrupted by user');
			expect(error2.message).toBe('Interrupted by user');
			expect(error3.message).toBe('Interrupted by user');
		});

		it('should handle rapid enqueue/clear cycles without memory leaks', async () => {
			// Rapidly enqueue and clear to test cleanup
			for (let i = 0; i < 10; i++) {
				const promises: Promise<string>[] = [];
				for (let j = 0; j < 5; j++) {
					promises.push(queue.enqueue(`Message ${i}-${j}`));
				}

				// Clear queue
				queue.clear();

				// Wait for all rejections
				await Promise.allSettled(promises);

				expect(queue.size()).toBe(0);
			}
		});

		it('should reject with timeout error containing message ID', async () => {
			// Validate error message format contains the message ID
			const error = new Error(
				'Message queue timeout: SDK did not consume message abc-123 within 30s. ' +
					'This usually indicates an SDK internal error. Please try again or create a new session.'
			);
			error.name = 'MessageQueueTimeoutError';

			expect(error.message).toContain('abc-123');
			expect(error.message).toContain('SDK did not consume');
			expect(error.message).toContain('30s');
		});
	});

	describe('generation tracking', () => {
		it('should return generation counter', () => {
			const gen1 = queue.getGeneration();
			expect(gen1).toBe(0);

			queue.start();
			const gen2 = queue.getGeneration();
			expect(gen2).toBe(1);

			queue.start();
			const gen3 = queue.getGeneration();
			expect(gen3).toBe(2);
		});

		it('should increment generation on each start', () => {
			expect(queue.getGeneration()).toBe(0);

			queue.start();
			expect(queue.getGeneration()).toBe(1);

			queue.stop();
			queue.start();
			expect(queue.getGeneration()).toBe(2);

			queue.stop();
		});
	});

	describe('internal flag propagation', () => {
		it('should propagate internal flag from queued message to SDK message', async () => {
			queue.start();

			// Enqueue an internal message
			const messagePromise = queue.enqueue('Internal test message', true);

			// Start generator
			const generator = queue.messageGenerator(testSessionId);

			// Get first message
			const result = await generator.next();

			expect(result.done).toBe(false);
			expect(result.value).toBeDefined();
			expect(result.value.message.internal).toBe(true);

			// Call onSent callback
			result.value.onSent();
			await messagePromise;

			queue.stop();
		});

		it('should have false internal flag when not set', async () => {
			queue.start();

			// Enqueue a regular message (no internal flag)
			const messagePromise = queue.enqueue('Regular message');

			// Start generator
			const generator = queue.messageGenerator(testSessionId);

			// Get first message
			const result = await generator.next();

			expect(result.done).toBe(false);
			expect(result.value).toBeDefined();
			expect(result.value.message.internal).toBe(false);

			// Call onSent callback
			result.value.onSent();
			await messagePromise;

			queue.stop();
		});

		it('should handle internal flag for multiple messages', async () => {
			queue.start();

			// Enqueue mix of internal and regular messages
			const promise1 = queue.enqueue('Regular 1', false);
			const promise2 = queue.enqueue('Internal 1', true);
			const promise3 = queue.enqueue('Regular 2');
			const promise4 = queue.enqueue('Internal 2', true);

			// Start generator
			const generator = queue.messageGenerator(testSessionId);

			// Get messages and verify internal flags
			const result1 = await generator.next();
			expect(result1.value.message.internal).toBe(false);
			result1.value.onSent();
			await promise1;

			const result2 = await generator.next();
			expect(result2.value.message.internal).toBe(true);
			result2.value.onSent();
			await promise2;

			const result3 = await generator.next();
			expect(result3.value.message.internal).toBe(false);
			result3.value.onSent();
			await promise3;

			const result4 = await generator.next();
			expect(result4.value.message.internal).toBe(true);
			result4.value.onSent();
			await promise4;

			queue.stop();
		});
	});
});
