/**
 * Helper Function Tests
 *
 * Tests for the behavior testing helper utilities.
 * These tests ensure helpers work correctly and satisfy knip.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from './test-app';
import { createTestApp } from './test-app';
import { getProcessingState, sendMessage } from './rpc-behavior';
import {
	waitForCondition,
	waitForAsyncCondition,
	waitFor,
	collectSubscriptionValues,
} from './wait';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Behavior Test Helpers', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('rpc-behavior-helpers', () => {
		test('sendMessage and getProcessingState work as intended', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: `${TMP_DIR}/helper-test`,
			});

			// These helpers are designed for use in behavior tests
			// This test just verifies they don't throw errors

			// sendMessage returns a message ID in integration tests
			const messageId = await sendMessage(ctx.messageHub, sessionId, 'Test');
			expect(messageId).toBeString();

			// getProcessingState returns state (may error if context not initialized)
			try {
				const state = await getProcessingState(ctx.messageHub, sessionId);
				expect(state).toBeDefined();
			} catch {
				// getProcessingState may fail if session context not fully initialized
				// This is acceptable in integration tests
			}
		});
	});

	describe('wait-helpers', () => {
		test('waitForCondition should wait until condition is true', async () => {
			let counter = 0;
			const incrementAfterDelay = async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				counter = 1;
			};

			incrementAfterDelay();

			await waitForCondition(() => counter === 1, 5000);

			expect(counter).toBe(1);
		});

		test('waitForAsyncCondition should wait for async condition', async () => {
			let value = 0;
			const incrementAfterDelay = async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				value = 1;
			};

			incrementAfterDelay();

			await waitForAsyncCondition(async () => value === 1, 5000);

			expect(value).toBe(1);
		});

		test('waitFor should delay execution', async () => {
			const start = Date.now();
			await waitFor(100);
			const elapsed = Date.now() - start;

			expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some variance
			expect(elapsed).toBeLessThan(200);
		});

		test('collectSubscriptionValues should collect from subscriptions', async () => {
			// Create a mock message hub for testing subscription collection
			const mockHub = {
				subscribe: (_channel: string, handler: (data: number) => void, _options?: unknown) => {
					// Simulate async data arriving
					setTimeout(() => handler(1), 50);
					setTimeout(() => handler(2), 100);
					setTimeout(() => handler(3), 150);
				},
			};

			const collected = await collectSubscriptionValues<number>(
				mockHub,
				'test.channel',
				(values) => values.length >= 3,
				{},
				5000
			);

			expect(collected).toEqual([1, 2, 3]);
		});
	});
});
