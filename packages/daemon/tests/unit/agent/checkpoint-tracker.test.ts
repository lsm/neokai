/**
 * CheckpointTracker Tests
 *
 * Tests checkpoint tracking from user messages with UUIDs,
 * checkpoint retrieval, and rewind operations.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { CheckpointTracker } from '../../../src/lib/agent/checkpoint-tracker';
import { generateUUID } from '@liuboer/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { SDKMessage } from '@liuboer/shared/sdk';

describe('CheckpointTracker', () => {
	let tracker: CheckpointTracker;
	let mockDaemonHub: DaemonHub;
	let emitSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();

	beforeEach(() => {
		// Create mock DaemonHub
		emitSpy = mock(async () => {});
		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		tracker = new CheckpointTracker(testSessionId, mockDaemonHub);
	});

	describe('initial state', () => {
		it('should start with empty checkpoints', () => {
			expect(tracker.getCheckpoints()).toEqual([]);
		});

		it('should start with turn number 0', () => {
			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(0);
		});
	});

	describe('processMessage - user message with UUID', () => {
		it('should create checkpoint from user message with UUID', () => {
			const userMessage: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Hello, how are you?' }],
				},
			} as SDKMessage;

			tracker.processMessage(userMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(1);
			expect(checkpoints[0].id).toBe(userMessage.uuid);
			expect(checkpoints[0].messagePreview).toBe('Hello, how are you?');
			expect(checkpoints[0].sessionId).toBe(testSessionId);
			expect(checkpoints[0].turnNumber).toBe(1);
		});

		it('should emit checkpoint.created event', () => {
			const userMessage: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Test message' }],
				},
			} as SDKMessage;

			tracker.processMessage(userMessage);

			expect(emitSpy).toHaveBeenCalledWith('checkpoint.created', {
				sessionId: testSessionId,
				checkpoint: expect.objectContaining({
					id: userMessage.uuid,
					messagePreview: 'Test message',
					turnNumber: 1,
				}),
			});
		});

		it('should increment turn number for each user message', () => {
			const message1: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'First message' }],
				},
			} as SDKMessage;

			const message2: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Second message' }],
				},
			} as SDKMessage;

			tracker.processMessage(message1);
			tracker.processMessage(message2);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(2);
			expect(checkpoints[0].turnNumber).toBe(2); // Sorted descending (newest first)
			expect(checkpoints[1].turnNumber).toBe(1);
		});

		it('should handle user message with multiline content', () => {
			const userMessage: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Line 1\nLine 2\nLine 3' }],
				},
			} as SDKMessage;

			tracker.processMessage(userMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints[0].messagePreview).toBe('Line 1\nLine 2\nLine 3');
		});

		it('should handle user message with empty content', () => {
			const userMessage: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: '' }],
				},
			} as SDKMessage;

			tracker.processMessage(userMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints[0].messagePreview).toBe('');
		});

		it('should use current timestamp for checkpoint', () => {
			const beforeTime = Date.now();
			const userMessage: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Test' }],
				},
			} as SDKMessage;

			tracker.processMessage(userMessage);

			const afterTime = Date.now();
			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
			expect(checkpoints[0].timestamp).toBeLessThanOrEqual(afterTime);
		});
	});

	describe('processMessage - user message replay', () => {
		it('should create checkpoint from user message replay with UUID', () => {
			const userMessageReplay: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				isReplay: true,
				message: {
					content: [{ type: 'text', text: 'Replayed message' }],
				},
			} as SDKMessage;

			tracker.processMessage(userMessageReplay);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(1);
			expect(checkpoints[0].id).toBe(userMessageReplay.uuid);
			expect(checkpoints[0].messagePreview).toBe('Replayed message');
		});
	});

	describe('processMessage - non-user messages', () => {
		it('should ignore assistant messages', () => {
			const assistantMessage: SDKMessage = {
				uuid: generateUUID(),
				type: 'assistant',
				message: {
					content: [{ type: 'text', text: 'Assistant response' }],
				},
			} as SDKMessage;

			tracker.processMessage(assistantMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(0);
			expect(emitSpy).not.toHaveBeenCalled();
		});

		it('should ignore system messages', () => {
			const systemMessage: SDKMessage = {
				type: 'system',
				message: {
					content: 'System info',
				},
			} as SDKMessage;

			tracker.processMessage(systemMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(0);
			expect(emitSpy).not.toHaveBeenCalled();
		});

		it('should ignore error messages', () => {
			const errorMessage: SDKMessage = {
				type: 'error',
				message: {
					content: 'Error occurred',
				},
			} as SDKMessage;

			tracker.processMessage(errorMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(0);
			expect(emitSpy).not.toHaveBeenCalled();
		});
	});

	describe('processMessage - user message without UUID', () => {
		it('should ignore user messages without UUID', () => {
			const userMessage: SDKMessage = {
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'No UUID message' }],
				},
			} as SDKMessage;

			tracker.processMessage(userMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(0);
			expect(emitSpy).not.toHaveBeenCalled();
		});
	});

	describe('processMessage - user message without message.content', () => {
		it('should create checkpoint with empty preview when message has no content', () => {
			const userMessage: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
			} as SDKMessage;

			tracker.processMessage(userMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(1);
			expect(checkpoints[0].messagePreview).toBe('');
		});
	});

	describe('rewindTo', () => {
		it('should remove checkpoints after specified checkpoint', () => {
			const message1: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Message 1' }],
				},
			} as SDKMessage;

			const message2: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Message 2' }],
				},
			} as SDKMessage;

			const message3: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Message 3' }],
				},
			} as SDKMessage;

			tracker.processMessage(message1);
			tracker.processMessage(message2);
			tracker.processMessage(message3);

			// Rewind to message2 (turn 2)
			const removedCount = tracker.rewindTo(message2.uuid);

			expect(removedCount).toBe(1); // Only message3 should be removed

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(2);
			expect(checkpoints[0].id).toBe(message2.uuid); // Newest is now message2
			expect(checkpoints[1].id).toBe(message1.uuid);
		});

		it('should return 0 when checkpoint not found', () => {
			const message: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Test' }],
				},
			} as SDKMessage;

			tracker.processMessage(message);

			const removedCount = tracker.rewindTo('non-existent-uuid');
			expect(removedCount).toBe(0);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(1); // No changes
		});

		it('should handle rewind to first checkpoint', () => {
			const message1: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Message 1' }],
				},
			} as SDKMessage;

			const message2: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Message 2' }],
				},
			} as SDKMessage;

			tracker.processMessage(message1);
			tracker.processMessage(message2);

			const removedCount = tracker.rewindTo(message1.uuid);

			expect(removedCount).toBe(1); // message2 removed

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(1);
			expect(checkpoints[0].id).toBe(message1.uuid);
		});

		it('should handle rewind to last checkpoint', () => {
			const message1: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Message 1' }],
				},
			} as SDKMessage;

			const message2: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Message 2' }],
				},
			} as SDKMessage;

			tracker.processMessage(message1);
			tracker.processMessage(message2);

			const removedCount = tracker.rewindTo(message2.uuid);

			expect(removedCount).toBe(0); // Nothing to remove

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(2); // No changes
		});

		it('should reset turn numbers after rewind', () => {
			const message1: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'M1' }],
				},
			} as SDKMessage;

			const message2: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'M2' }],
				},
			} as SDKMessage;

			const message3: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'M3' }],
				},
			} as SDKMessage;

			tracker.processMessage(message1);
			tracker.processMessage(message2);
			tracker.processMessage(message3);

			// Rewind to message1
			tracker.rewindTo(message1.uuid);

			// Add new message - should get turn number 2
			const newMessage: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'New message' }],
				},
			} as SDKMessage;

			tracker.processMessage(newMessage);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(2);

			// Find the new message checkpoint
			const newCheckpoint = checkpoints.find((c) => c.id === newMessage.uuid);
			expect(newCheckpoint?.turnNumber).toBe(2);
		});
	});

	describe('getCheckpoints', () => {
		it('should return checkpoints sorted by turn number descending (newest first)', () => {
			const message1: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'First' }],
				},
			} as SDKMessage;

			const message2: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Second' }],
				},
			} as SDKMessage;

			const message3: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Third' }],
				},
			} as SDKMessage;

			tracker.processMessage(message1);
			tracker.processMessage(message2);
			tracker.processMessage(message3);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(3);
			expect(checkpoints[0].turnNumber).toBe(3);
			expect(checkpoints[1].turnNumber).toBe(2);
			expect(checkpoints[2].turnNumber).toBe(1);
		});

		it('should return empty array when no checkpoints', () => {
			expect(tracker.getCheckpoints()).toEqual([]);
		});

		it('should return checkpoints with all required fields', () => {
			const testUuid = generateUUID();
			const userMessage: SDKMessage = {
				uuid: testUuid,
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Test message' }],
				},
			} as SDKMessage;

			tracker.processMessage(userMessage);

			const checkpoints = tracker.getCheckpoints();
			const checkpoint = checkpoints[0];

			expect(checkpoint).toMatchObject({
				id: testUuid,
				messagePreview: 'Test message',
				turnNumber: 1,
				sessionId: testSessionId,
			});
			expect(checkpoint.timestamp).toBeGreaterThan(0);
		});
	});

	describe('helper methods', () => {
		it('getCheckpoint should return checkpoint by ID', () => {
			const message: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Test' }],
				},
			} as SDKMessage;

			tracker.processMessage(message);

			const checkpoint = tracker.getCheckpoint(message.uuid);
			expect(checkpoint).toBeDefined();
			expect(checkpoint?.id).toBe(message.uuid);
		});

		it('getCheckpoint should return undefined for non-existent checkpoint', () => {
			const checkpoint = tracker.getCheckpoint('non-existent');
			expect(checkpoint).toBeUndefined();
		});

		it('getLatestCheckpoint should return most recent checkpoint', () => {
			const message1: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'First' }],
				},
			} as SDKMessage;

			const message2: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Second' }],
				},
			} as SDKMessage;

			tracker.processMessage(message1);
			tracker.processMessage(message2);

			const latest = tracker.getLatestCheckpoint();
			expect(latest?.id).toBe(message2.uuid);
			expect(latest?.turnNumber).toBe(2);
		});

		it('getFirstCheckpoint should return initial checkpoint', () => {
			const message1: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'First' }],
				},
			} as SDKMessage;

			const message2: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Second' }],
				},
			} as SDKMessage;

			tracker.processMessage(message1);
			tracker.processMessage(message2);

			const first = tracker.getFirstCheckpoint();
			expect(first?.id).toBe(message1.uuid);
			expect(first?.turnNumber).toBe(1);
		});

		it('clear should remove all checkpoints', () => {
			const message: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Test' }],
				},
			} as SDKMessage;

			tracker.processMessage(message);
			expect(tracker.getCheckpoints()).toHaveLength(1);

			tracker.clear();
			expect(tracker.getCheckpoints()).toHaveLength(0);
		});

		it('size should return number of checkpoints', () => {
			expect(tracker.size).toBe(0);

			const message: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Test' }],
				},
			} as SDKMessage;

			tracker.processMessage(message);
			expect(tracker.size).toBe(1);
		});

		it('has should check if checkpoint exists', () => {
			const message: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: 'Test' }],
				},
			} as SDKMessage;

			tracker.processMessage(message);

			expect(tracker.has(message.uuid)).toBe(true);
			expect(tracker.has('non-existent')).toBe(false);
		});
	});

	describe('message content with various types', () => {
		it('should extract text from first text block in content array', () => {
			const messageWithMultipleBlocks: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [
						{ type: 'text', text: 'First text block' },
						{ type: 'text', text: 'Second text block' },
					],
				},
			} as SDKMessage;

			tracker.processMessage(messageWithMultipleBlocks);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints[0].messagePreview).toBe('First text block');
		});

		it('should handle string content', () => {
			const messageWithStringContent: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: 'String content here',
				},
			} as SDKMessage;

			tracker.processMessage(messageWithStringContent);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints[0].messagePreview).toBe('String content here');
		});

		it('should truncate long content to 100 characters', () => {
			const longText = 'a'.repeat(150);
			const message: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'text', text: longText }],
				},
			} as SDKMessage;

			tracker.processMessage(message);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints[0].messagePreview).toHaveLength(100);
			expect(checkpoints[0].messagePreview).toBe('a'.repeat(100));
		});

		it('should return empty preview for content without text blocks', () => {
			const messageWithToolUse: SDKMessage = {
				uuid: generateUUID(),
				type: 'user',
				message: {
					content: [{ type: 'tool_use', id: '123', name: 'test', input: {} }],
				},
			} as SDKMessage;

			tracker.processMessage(messageWithToolUse);

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints[0].messagePreview).toBe('');
		});
	});

	describe('large number of checkpoints', () => {
		it('should handle many checkpoints efficiently', () => {
			const messageCount = 100;
			const messages: SDKMessage[] = [];

			for (let i = 0; i < messageCount; i++) {
				const message: SDKMessage = {
					uuid: generateUUID(),
					type: 'user',
					message: {
						content: [{ type: 'text', text: `Message ${i + 1}` }],
					},
				} as SDKMessage;
				messages.push(message);
				tracker.processMessage(message);
			}

			const checkpoints = tracker.getCheckpoints();
			expect(checkpoints).toHaveLength(messageCount);
			expect(checkpoints[0].turnNumber).toBe(messageCount);
			expect(checkpoints[messageCount - 1].turnNumber).toBe(1);

			// Rewind to middle checkpoint
			const middleIndex = Math.floor(messageCount / 2);
			const removedCount = tracker.rewindTo(messages[middleIndex].uuid);

			expect(removedCount).toBe(messageCount - middleIndex - 1);
		});
	});
});
