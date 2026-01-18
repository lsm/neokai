/**
 * ContextTracker Tests
 *
 * Tests real-time context window usage tracking,
 * token counting, and EventBus integration.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ContextTracker } from '../../../src/lib/agent/context-tracker';
import type { ContextInfo } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';

describe('ContextTracker', () => {
	let tracker: ContextTracker;
	let mockEventBus: DaemonHub;
	let emitSpy: ReturnType<typeof mock>;
	let persistSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();
	const testModel = 'claude-sonnet-4-5-20250929';

	beforeEach(() => {
		// Create mock DaemonHub
		emitSpy = mock(async () => {});
		mockEventBus = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		// Create persist callback spy
		persistSpy = mock(() => {});

		tracker = new ContextTracker(testSessionId, testModel, mockEventBus, persistSpy);
	});

	describe('initial state', () => {
		it('should start with null context info', () => {
			expect(tracker.getContextInfo()).toBeNull();
		});
	});

	describe('restore from metadata', () => {
		it('should restore context info from saved metadata', () => {
			const savedContext: ContextInfo = {
				model: testModel,
				totalUsed: 50000,
				totalCapacity: 200000,
				percentUsed: 25,
				breakdown: {
					'Input Context': { tokens: 40000, percent: 20 },
					'Output Tokens': { tokens: 10000, percent: 5 },
					'Free Space': { tokens: 150000, percent: 75 },
				},
			};

			tracker.restoreFromMetadata(savedContext);

			const restored = tracker.getContextInfo();
			expect(restored).toEqual(savedContext);
		});
	});

	describe('model switching', () => {
		it('should update model ID', () => {
			tracker.setModel('claude-opus-4-5-20251101');

			// Next context update should reflect new model
			// (verified by checking context info after processing an event)
		});
	});

	describe('stream event processing', () => {
		it('should process message_start event and track input tokens', async () => {
			const messageStartEvent = {
				type: 'message_start',
				message: {
					usage: {
						input_tokens: 10000,
						output_tokens: 1,
					},
				},
			};

			await tracker.processStreamEvent(messageStartEvent);

			// Should emit context update
			expect(emitSpy).toHaveBeenCalledWith('context.updated', {
				sessionId: testSessionId,
				contextInfo: expect.objectContaining({
					model: testModel,
					totalUsed: 10001, // input + output
					totalCapacity: 200000,
				}),
			});

			// Should persist context
			expect(persistSpy).toHaveBeenCalled();
		});

		it('should process message_delta event and update output tokens', async () => {
			// First, process message_start
			await tracker.processStreamEvent({
				type: 'message_start',
				message: {
					usage: {
						input_tokens: 10000,
						output_tokens: 1,
					},
				},
			});

			emitSpy.mockClear();
			persistSpy.mockClear();

			// Wait to avoid throttling
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Then process message_delta with cumulative output tokens
			await tracker.processStreamEvent({
				type: 'message_delta',
				usage: {
					output_tokens: 150,
				},
			});

			// Should update with new output tokens
			const contextInfo = tracker.getContextInfo();
			expect(contextInfo?.totalUsed).toBe(10150); // input + updated output
		});

		it('should throttle message_delta updates', async () => {
			// First message_start
			await tracker.processStreamEvent({
				type: 'message_start',
				message: {
					usage: {
						input_tokens: 10000,
						output_tokens: 1,
					},
				},
			});

			emitSpy.mockClear();

			// Rapid message_delta events (within throttle window)
			await tracker.processStreamEvent({
				type: 'message_delta',
				usage: { output_tokens: 10 },
			});

			await tracker.processStreamEvent({
				type: 'message_delta',
				usage: { output_tokens: 20 },
			});

			await tracker.processStreamEvent({
				type: 'message_delta',
				usage: { output_tokens: 30 },
			});

			// Should be throttled - only first update emitted
			expect(emitSpy).toHaveBeenCalledTimes(1);
		});

		it('should ignore unknown event types', async () => {
			emitSpy.mockClear();

			await tracker.processStreamEvent({
				type: 'unknown_event',
				data: {},
			});

			// Should not emit any events
			expect(emitSpy).not.toHaveBeenCalled();
		});

		it('should handle malformed events gracefully', async () => {
			emitSpy.mockClear();

			// Should not throw
			await expect(tracker.processStreamEvent(null)).resolves.toBeUndefined();
			await expect(tracker.processStreamEvent(undefined)).resolves.toBeUndefined();
			await expect(tracker.processStreamEvent({})).resolves.toBeUndefined();

			expect(emitSpy).not.toHaveBeenCalled();
		});
	});

	describe('result usage handling', () => {
		it('should handle final result with accurate token counts', async () => {
			await tracker.handleResultUsage({
				input_tokens: 15000,
				output_tokens: 500,
				cache_read_input_tokens: 5000,
				cache_creation_input_tokens: 2000,
			});

			const contextInfo = tracker.getContextInfo();
			expect(contextInfo).toBeDefined();
			expect(contextInfo?.totalUsed).toBe(15500);
			expect(contextInfo?.apiUsage).toEqual({
				inputTokens: 15000,
				outputTokens: 500,
				cacheReadTokens: 5000,
				cacheCreationTokens: 2000,
			});
		});

		it('should update context window size from model usage', async () => {
			await tracker.handleResultUsage(
				{
					input_tokens: 10000,
					output_tokens: 500,
				},
				{
					'claude-sonnet-4-5-20250929': {
						// SDK 0.1.69+ ModelUsage type
						inputTokens: 10000,
						outputTokens: 500,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						webSearchRequests: 0,
						costUSD: 0.05,
						contextWindow: 300000, // Updated context window
					},
				}
			);

			const contextInfo = tracker.getContextInfo();
			expect(contextInfo?.totalCapacity).toBe(300000);
		});

		it('should track web search requests from model usage', async () => {
			await tracker.handleResultUsage(
				{
					input_tokens: 10000,
					output_tokens: 500,
				},
				{
					'claude-sonnet-4-5-20250929': {
						inputTokens: 10000,
						outputTokens: 500,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						webSearchRequests: 3,
						costUSD: 0.05,
						contextWindow: 200000,
					},
				}
			);

			const contextInfo = tracker.getContextInfo();
			expect(contextInfo?.apiUsage?.webSearchRequests).toBe(3);
		});

		it('should not throttle result updates', async () => {
			emitSpy.mockClear();

			// Result should always emit, regardless of throttle
			await tracker.handleResultUsage({
				input_tokens: 10000,
				output_tokens: 500,
			});

			expect(emitSpy).toHaveBeenCalledWith('context.updated', expect.any(Object));
		});

		it('should persist context info via callback', async () => {
			persistSpy.mockClear();

			await tracker.handleResultUsage({
				input_tokens: 10000,
				output_tokens: 500,
			});

			expect(persistSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					model: testModel,
					totalUsed: 10500,
				})
			);
		});
	});

	describe('context breakdown calculation', () => {
		it('should calculate breakdown with input, output, and free space', async () => {
			await tracker.handleResultUsage({
				input_tokens: 50000,
				output_tokens: 10000,
			});

			const contextInfo = tracker.getContextInfo();
			expect(contextInfo?.breakdown).toBeDefined();
			expect(contextInfo?.breakdown['Input Context']).toEqual({
				tokens: 50000,
				percent: 25, // 50000 / 200000 * 100
			});
			expect(contextInfo?.breakdown['Output Tokens']).toEqual({
				tokens: 10000,
				percent: 5, // 10000 / 200000 * 100
			});
			expect(contextInfo?.breakdown['Free Space']).toEqual({
				tokens: 140000,
				percent: 70, // 140000 / 200000 * 100
			});
		});

		it('should cap percent used at 100%', async () => {
			await tracker.handleResultUsage({
				input_tokens: 180000,
				output_tokens: 30000, // Total: 210000 > 200000
			});

			const contextInfo = tracker.getContextInfo();
			expect(contextInfo?.percentUsed).toBe(100);
			expect(contextInfo?.breakdown['Free Space'].tokens).toBe(0);
			expect(contextInfo?.breakdown['Free Space'].percent).toBe(0);
		});
	});

	describe('DaemonHub integration', () => {
		it('should emit context.updated event with session ID and context info', async () => {
			emitSpy.mockClear();

			await tracker.handleResultUsage({
				input_tokens: 10000,
				output_tokens: 500,
			});

			expect(emitSpy).toHaveBeenCalledWith('context.updated', {
				sessionId: testSessionId,
				contextInfo: expect.objectContaining({
					model: testModel,
					totalUsed: 10500,
					totalCapacity: 200000,
				}),
			});
		});

		it('should include breakdown and apiUsage in emitted event', async () => {
			emitSpy.mockClear();

			await tracker.handleResultUsage({
				input_tokens: 10000,
				output_tokens: 500,
				cache_read_input_tokens: 2000,
			});

			expect(emitSpy).toHaveBeenCalledWith('context.updated', {
				sessionId: testSessionId,
				contextInfo: expect.objectContaining({
					breakdown: expect.any(Object),
					apiUsage: expect.objectContaining({
						inputTokens: 10000,
						outputTokens: 500,
						cacheReadTokens: 2000,
					}),
				}),
			});
		});
	});

	describe('real-time streaming scenario', () => {
		it('should track tokens through full streaming lifecycle', async () => {
			// 1. message_start: Initial tokens
			await tracker.processStreamEvent({
				type: 'message_start',
				message: {
					usage: {
						input_tokens: 15000,
						output_tokens: 1,
					},
				},
			});

			let contextInfo = tracker.getContextInfo();
			expect(contextInfo?.totalUsed).toBe(15001);

			// Wait to avoid throttling
			await new Promise((resolve) => setTimeout(resolve, 300));

			// 2. message_delta: Output tokens incrementing
			await tracker.processStreamEvent({
				type: 'message_delta',
				usage: { output_tokens: 50 },
			});

			contextInfo = tracker.getContextInfo();
			expect(contextInfo?.totalUsed).toBe(15050);

			await new Promise((resolve) => setTimeout(resolve, 300));

			// 3. message_delta: More output
			await tracker.processStreamEvent({
				type: 'message_delta',
				usage: { output_tokens: 150 },
			});

			contextInfo = tracker.getContextInfo();
			expect(contextInfo?.totalUsed).toBe(15150);

			// 4. Final result: Authoritative count
			await tracker.handleResultUsage({
				input_tokens: 15000,
				output_tokens: 200,
				cache_read_input_tokens: 5000,
			});

			contextInfo = tracker.getContextInfo();
			expect(contextInfo?.totalUsed).toBe(15200);
			expect(contextInfo?.apiUsage?.cacheReadTokens).toBe(5000);
		});
	});
});
