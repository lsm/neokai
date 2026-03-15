import { describe, expect, it } from 'bun:test';
import {
	classifyError,
	detectTerminalError,
} from '../../../../src/lib/room/runtime/error-classifier';

describe('error-classifier', () => {
	describe('classifyError', () => {
		describe('terminal HTTP status codes (via "API Error: NNN")', () => {
			it('classifies HTTP 400 as terminal', () => {
				const result = classifyError('API Error: 400 {"error":{"message":"Invalid model: xyz"}}');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(400);
			});

			it('classifies HTTP 401 as terminal', () => {
				const result = classifyError('API Error: 401 Unauthorized');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(401);
			});

			it('classifies HTTP 403 as terminal', () => {
				const result = classifyError('API Error: 403 Forbidden');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(403);
			});

			it('classifies HTTP 404 as terminal', () => {
				const result = classifyError('API Error: 404 Not Found');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(404);
			});

			it('classifies HTTP 422 as terminal', () => {
				const result = classifyError('API Error: 422 Unprocessable Entity');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(422);
			});
		});

		describe('recoverable HTTP status codes', () => {
			it('classifies HTTP 500 as recoverable', () => {
				const result = classifyError('API Error: 500 Internal Server Error');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('recoverable');
				expect(result!.statusCode).toBe(500);
			});

			it('classifies HTTP 502 as recoverable', () => {
				const result = classifyError('API Error: 502 Bad Gateway');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('recoverable');
				expect(result!.statusCode).toBe(502);
			});

			it('classifies HTTP 503 as recoverable', () => {
				const result = classifyError('API Error: 503 Service Unavailable');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('recoverable');
				expect(result!.statusCode).toBe(503);
			});
		});

		describe('429 rate limit handling', () => {
			it('classifies HTTP 429 as rate_limit (not terminal)', () => {
				const result = classifyError('API Error: 429 Too Many Requests');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('rate_limit');
				expect(result!.statusCode).toBe(429);
			});

			it('classifies Anthropic usage-limit message as rate_limit with resetsAt', () => {
				const result = classifyError("You've hit your limit · resets 1pm (America/New_York)");
				expect(result).not.toBeNull();
				expect(result!.class).toBe('rate_limit');
				expect(result!.resetsAt).toBeGreaterThan(Date.now() - 1000);
			});

			it('classifies HTTP 429 without retry-after as rate_limit (resetsAt undefined)', () => {
				const result = classifyError('API Error: 429 Too Many Requests');
				expect(result!.class).toBe('rate_limit');
				// No parseable retry-after time in this message
				expect(result!.resetsAt).toBeUndefined();
			});
		});

		describe('realistic combined messages', () => {
			it('classifies full invalid-model API error as terminal with statusCode', () => {
				const msg =
					'API Error: 400 {"error":{"message":"Invalid model: claude-invalid-v99","type":"invalid_request_error"}}';
				const result = classifyError(msg);
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(400);
			});

			it('classifies bare HTTP 400 as terminal', () => {
				const result = classifyError('API Error: 400 Bad Request');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(400);
			});
		});

		describe('prose / explanatory text does NOT trigger false positives', () => {
			it('returns null for "implemented handling for invalid model errors"', () => {
				expect(
					classifyError('implemented handling for invalid model errors in provider adapter')
				).toBeNull();
			});

			it('returns null for "added support for invalid api key detection"', () => {
				expect(classifyError('added support for invalid api key detection')).toBeNull();
			});

			it('returns null for "fixed authentication failed edge case"', () => {
				expect(classifyError('fixed authentication failed edge case in login flow')).toBeNull();
			});

			it('returns null for "handle quota exceeded scenario in tests"', () => {
				expect(classifyError('handle quota exceeded scenario in tests')).toBeNull();
			});

			it('returns null for "model not found error is now logged properly"', () => {
				expect(classifyError('model not found error is now logged properly')).toBeNull();
			});

			it('returns null for generic text', () => {
				expect(classifyError('Some unrelated error')).toBeNull();
			});

			it('returns null for empty string', () => {
				expect(classifyError('')).toBeNull();
			});

			it('returns null for network errors (not "API Error: NNN" shaped)', () => {
				expect(classifyError('Network timeout')).toBeNull();
				expect(classifyError('Connection refused')).toBeNull();
			});

			it('returns null for file-system errors', () => {
				expect(classifyError('Error: ENOENT: no such file or directory')).toBeNull();
			});

			it('returns null when "API Error: NNN" appears mid-sentence (not at start of line)', () => {
				expect(
					classifyError('we now handle API Error: 400 from provider responses correctly')
				).toBeNull();
				expect(
					classifyError('Fixed the issue where API Error: 422 was not being retried properly')
				).toBeNull();
			});

			it('still classifies "API Error: NNN" when it is at the start of a line in multi-line output', () => {
				const multiLineOutput = [
					'Attempting to solve the task...',
					'Running tests...',
					'API Error: 400 {"error":{"message":"Invalid model: bad-model"}}',
					'Exiting.',
				].join('\n');
				const result = classifyError(multiLineOutput);
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(400);
			});
		});

		describe('reason field', () => {
			it('includes a non-empty reason for terminal errors', () => {
				const result = classifyError('API Error: 401 Unauthorized');
				expect(result!.reason.length).toBeGreaterThan(0);
			});

			it('truncates very long messages in reason', () => {
				const longMsg = 'API Error: 400 ' + 'x'.repeat(1000);
				const result = classifyError(longMsg);
				expect(result!.reason.length).toBeLessThan(500);
			});
		});
	});

	describe('detectTerminalError', () => {
		it('returns classification for terminal errors', () => {
			const result = detectTerminalError('API Error: 401 Unauthorized');
			expect(result).not.toBeNull();
			expect(result!.class).toBe('terminal');
		});

		it('returns null for recoverable errors', () => {
			const result = detectTerminalError('API Error: 500 Internal Server Error');
			expect(result).toBeNull();
		});

		it('returns null for unrecognized text', () => {
			const result = detectTerminalError('Some other output');
			expect(result).toBeNull();
		});

		it('returns null for rate limit messages (classified as rate_limit, not terminal)', () => {
			const result = detectTerminalError('API Error: 429 Too Many Requests');
			expect(result).toBeNull();
		});

		it('detects terminal error embedded in multi-line worker output', () => {
			const output = [
				'Attempting to solve the task...',
				'Running tests...',
				'API Error: 400 {"error":{"message":"Invalid model: bad-model"}}',
				'Exiting.',
			].join('\n');
			const result = detectTerminalError(output);
			expect(result).not.toBeNull();
			expect(result!.class).toBe('terminal');
		});

		it('does NOT trigger on explanatory prose about error handling', () => {
			const proseOutput = [
				'I have implemented handling for invalid model errors in the provider adapter.',
				'The fix ensures authentication failed scenarios are retried correctly.',
				'All tests pass.',
			].join('\n');
			expect(detectTerminalError(proseOutput)).toBeNull();
		});
	});
});
