import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ApiErrorCircuitBreaker } from '../api-error-circuit-breaker';

describe('ApiErrorCircuitBreaker', () => {
	let circuitBreaker: ApiErrorCircuitBreaker;

	beforeEach(() => {
		circuitBreaker = new ApiErrorCircuitBreaker('test-session-123');
	});

	describe('error pattern detection', () => {
		it('should detect prompt too long errors', async () => {
			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>',
				},
			};

			const tripped = await circuitBreaker.checkMessage(message);
			expect(tripped).toBe(false); // First error doesn't trip
		});

		it('should trip after threshold errors', async () => {
			const onTripMock = mock(async () => {});
			circuitBreaker.setOnTripCallback(onTripMock);

			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>',
				},
			};

			// First two errors don't trip
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			expect(circuitBreaker.isTripped()).toBe(false);

			// Third error trips
			const tripped = await circuitBreaker.checkMessage(message);
			expect(tripped).toBe(true);
			expect(circuitBreaker.isTripped()).toBe(true);
			expect(onTripMock).toHaveBeenCalled();
		});

		it('should not trip on non-error messages', async () => {
			const message = {
				type: 'user',
				message: {
					content: 'Hello, how are you?',
				},
			};

			const tripped = await circuitBreaker.checkMessage(message);
			expect(tripped).toBe(false);
			expect(circuitBreaker.isTripped()).toBe(false);
		});

		it('should not trip on assistant messages', async () => {
			const message = {
				type: 'assistant',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}</local-command-stderr>',
				},
			};

			const tripped = await circuitBreaker.checkMessage(message);
			expect(tripped).toBe(false);
		});

		it('should detect 400 API errors', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: 400 {"type":"error"}</local-command-stderr>',
				},
			};

			// Send 3 errors to trip
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
		});

		it('should detect 429 rate limit errors', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: 429 {"type":"error"}</local-command-stderr>',
				},
			};

			// Send 3 errors to trip
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			const tripped = await circuitBreaker.checkMessage(message);

			expect(tripped).toBe(true);
		});
	});

	describe('reset behavior', () => {
		it('should reset error count after reset()', async () => {
			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 100 tokens > 50 maximum"}}</local-command-stderr>',
				},
			};

			// Accumulate some errors
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			// Reset
			circuitBreaker.reset();

			// Should need 3 new errors to trip
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			expect(circuitBreaker.isTripped()).toBe(false);

			await circuitBreaker.checkMessage(message);
			expect(circuitBreaker.isTripped()).toBe(true);
		});

		it('should clear error count on markSuccess()', async () => {
			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 100 tokens > 50 maximum"}}</local-command-stderr>',
				},
			};

			// Accumulate some errors
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			// Mark success
			circuitBreaker.markSuccess();

			// Should need 3 new errors to trip
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			expect(circuitBreaker.isTripped()).toBe(false);
		});
	});

	describe('trip message', () => {
		it('should provide helpful message for prompt too long', async () => {
			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>',
				},
			};

			// Trip the breaker
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			const tripMessage = circuitBreaker.getTripMessage();
			expect(tripMessage).toContain('Context limit exceeded');
			expect(tripMessage).toContain('200000');
		});

		it('should provide helpful message for rate limit', async () => {
			const message = {
				type: 'user',
				message: {
					content: '<local-command-stderr>Error: 429 {"type":"error"}</local-command-stderr>',
				},
			};

			// Trip the breaker
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			const tripMessage = circuitBreaker.getTripMessage();
			expect(tripMessage).toContain('Rate limit');
		});
	});

	describe('state management', () => {
		it('should track trip count', async () => {
			const message = {
				type: 'user',
				message: {
					content:
						'<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}</local-command-stderr>',
				},
			};

			// First trip
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			const state1 = circuitBreaker.getState();
			expect(state1.tripCount).toBe(1);

			// Reset and trip again
			circuitBreaker.reset();
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);
			await circuitBreaker.checkMessage(message);

			const state2 = circuitBreaker.getState();
			expect(state2.tripCount).toBe(2);
		});
	});
});
