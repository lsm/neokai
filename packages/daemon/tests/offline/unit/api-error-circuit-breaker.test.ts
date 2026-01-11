/**
 * Tests for ApiErrorCircuitBreaker
 *
 * Coverage for:
 * - extractErrorPattern: Detecting various error patterns
 * - checkMessage: Processing messages and tracking errors
 * - trip: Circuit breaker tripping logic
 * - reset: Resetting the circuit breaker
 * - isTripped: Auto-reset after cooldown
 * - getTripMessage: Human-readable error messages
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { ApiErrorCircuitBreaker } from '../../../src/lib/agent/api-error-circuit-breaker';

describe('ApiErrorCircuitBreaker', () => {
	let circuitBreaker: ApiErrorCircuitBreaker;

	beforeEach(() => {
		circuitBreaker = new ApiErrorCircuitBreaker('test-session', {
			errorThreshold: 3,
			timeWindowMs: 30000,
			cooldownMs: 60000,
		});
	});

	describe('checkMessage', () => {
		test('ignores non-user messages', async () => {
			const message = {
				type: 'assistant',
				message: { content: 'Hello' },
			};

			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(false);
		});

		test('ignores messages without content', async () => {
			const message = {
				type: 'user',
				message: {},
			};

			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(false);
		});

		test('ignores messages without error patterns', async () => {
			const message = {
				type: 'user',
				message: { content: 'Hello, how are you?' },
			};

			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(false);
		});

		test('detects prompt too long error pattern', async () => {
			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: prompt is too long: 250000 tokens > 200000 maximum</local-command-stderr>',
				},
			};

			// First two should not trip
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			// Third should trip
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
			expect(circuitBreaker.isTripped()).toBe(true);
		});

		test('detects invalid_request_error pattern', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
		});

		test('detects connection error pattern', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: Connection error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
		});

		test('detects 400 API error pattern', async () => {
			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"error": "bad request"}</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
		});

		test('detects 429 rate limit error pattern', async () => {
			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 429 {"error": "rate limit exceeded"}</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
		});

		test('handles array content blocks', async () => {
			const message = {
				type: 'user',
				message: {
					content: [
						{
							type: 'text',
							text: '<local-command-stderr>Error: prompt is too long: 250000 tokens > 200000 maximum</local-command-stderr>',
						},
					],
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
		});

		test('handles tool_result content blocks', async () => {
			const message = {
				type: 'user',
				message: {
					content: [
						{
							type: 'tool_result',
							content:
								'<local-command-stderr>Error: prompt is too long: 250000 tokens > 200000 maximum</local-command-stderr>',
						},
					],
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
		});

		test('cleans up old errors outside time window', async () => {
			const cb = new ApiErrorCircuitBreaker('test', {
				errorThreshold: 3,
				timeWindowMs: 10, // Very short window
				cooldownMs: 60000,
			});

			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await cb.checkMessage(message);
			await cb.checkMessage(message);

			// Wait for time window to expire
			await new Promise((resolve) => setTimeout(resolve, 20));

			// This should not trip because old errors are cleaned up
			const tripped = await cb.checkMessage(message);

			expect(tripped).toBe(false);
		});
	});

	describe('onTrip callback', () => {
		test('executes callback when circuit trips', async () => {
			let callbackExecuted = false;
			let callbackReason = '';
			let callbackErrorCount = 0;

			circuitBreaker.setOnTripCallback(async (reason, errorCount) => {
				callbackExecuted = true;
				callbackReason = reason;
				callbackErrorCount = errorCount;
			});

			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			expect(callbackExecuted).toBe(true);
			expect(callbackReason).toBe('invalid_request_error');
			expect(callbackErrorCount).toBe(3);
		});

		test('handles callback errors gracefully', async () => {
			circuitBreaker.setOnTripCallback(async () => {
				throw new Error('Callback error');
			});

			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			// Should not throw
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			expect(circuitBreaker.isTripped()).toBe(true);
		});
	});

	describe('reset', () => {
		test('resets tripped state', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			expect(circuitBreaker.isTripped()).toBe(true);

			circuitBreaker.reset();

			expect(circuitBreaker.isTripped()).toBe(false);
		});

		test('clears recent errors', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			circuitBreaker.reset();

			// Should need 3 more errors to trip again
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(false);
		});
	});

	describe('markSuccess', () => {
		test('clears recent errors', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			circuitBreaker.markSuccess();

			// Should need 3 more errors to trip
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(false);
		});
	});

	describe('isTripped', () => {
		test('auto-resets after cooldown period', async () => {
			const cb = new ApiErrorCircuitBreaker('test', {
				errorThreshold: 3,
				timeWindowMs: 30000,
				cooldownMs: 10, // Very short cooldown
			});

			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await cb.checkMessage(message);
			await cb.checkMessage(message);
			await cb.checkMessage(message);

			expect(cb.isTripped()).toBe(true);

			// Wait for cooldown
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Should auto-reset
			expect(cb.isTripped()).toBe(false);
		});
	});

	describe('getState', () => {
		test('returns current state', async () => {
			const state = circuitBreaker.getState();

			expect(state.isTripped).toBe(false);
			expect(state.tripReason).toBeNull();
			expect(state.tripCount).toBe(0);
			expect(state.lastTripTime).toBeNull();
		});

		test('returns tripped state', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			const state = circuitBreaker.getState();

			expect(state.isTripped).toBe(true);
			expect(state.tripReason).toBe('invalid_request_error');
			expect(state.tripCount).toBe(1);
			expect(state.lastTripTime).not.toBeNull();
		});

		test('returns copy of state', async () => {
			const state1 = circuitBreaker.getState();
			state1.isTripped = true;

			const state2 = circuitBreaker.getState();

			expect(state2.isTripped).toBe(false);
		});
	});

	describe('getTripMessage', () => {
		test('returns unknown error when not tripped', () => {
			const message = circuitBreaker.getTripMessage();

			expect(message).toBe('Unknown error');
		});

		test('returns prompt too long message', async () => {
			const errorMessage = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: prompt is too long: 250000 tokens > 200000 maximum</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);

			const message = circuitBreaker.getTripMessage();

			expect(message).toContain('Context limit exceeded');
			expect(message).toContain('200000 tokens maximum');
		});

		test('returns invalid request error message', async () => {
			const errorMessage = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);

			const message = circuitBreaker.getTripMessage();

			expect(message).toContain('API rejected the request');
		});

		test('returns connection error message', async () => {
			const errorMessage = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: Connection error</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);

			const message = circuitBreaker.getTripMessage();

			expect(message).toContain('Connection error');
		});

		test('returns rate limit message for 429', async () => {
			const errorMessage = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 429 {"error": "rate limited"}</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);

			const message = circuitBreaker.getTripMessage();

			expect(message).toContain('Rate limit exceeded');
		});

		test('returns API error message for 400', async () => {
			const errorMessage = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"error": "bad request"}</local-command-stderr>',
				},
			};

			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);

			const message = circuitBreaker.getTripMessage();

			expect(message).toContain('API error');
			expect(message).toContain('400');
		});
	});

	describe('edge cases', () => {
		test('handles empty content array', async () => {
			const message = {
				type: 'user',
				message: { content: [] },
			};

			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(false);
		});

		test('handles content array with unknown block types', async () => {
			const message = {
				type: 'user',
				message: {
					content: [{ type: 'unknown', data: 'something' }],
				},
			};

			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(false);
		});

		test('increments trip count on multiple trips', async () => {
			const errorMessage = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: invalid_request_error</local-command-stderr>',
				},
			};

			// First trip
			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);

			expect(circuitBreaker.getState().tripCount).toBe(1);

			// Reset and trip again
			circuitBreaker.reset();

			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);
			await circuitBreaker.checkMessage(errorMessage);

			expect(circuitBreaker.getState().tripCount).toBe(2);
		});

		test('handles null content blocks', async () => {
			const message = {
				type: 'user',
				message: {
					content: [null, { type: 'text', text: 'hello' }],
				},
			};

			// Should not throw
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(false);
		});

		test('uses default config when not provided', () => {
			const cb = new ApiErrorCircuitBreaker('test');
			const state = cb.getState();

			expect(state.isTripped).toBe(false);
		});
	});
});
