import { describe, expect, it } from 'bun:test';
import {
	classifyError,
	detectTerminalError,
} from '../../../../src/lib/room/runtime/error-classifier';

describe('error-classifier', () => {
	describe('classifyError', () => {
		describe('terminal HTTP status codes', () => {
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

		describe('terminal text patterns', () => {
			it('classifies "Invalid model" as terminal', () => {
				const result = classifyError('Invalid model: claude-fake-model');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBeUndefined();
			});

			it('classifies "invalid api key" as terminal (case-insensitive)', () => {
				const result = classifyError('Invalid API Key provided');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
			});

			it('classifies "authentication failed" as terminal', () => {
				const result = classifyError('Authentication failed: bad credentials');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
			});

			it('classifies "quota exceeded" as terminal', () => {
				const result = classifyError('quota exceeded for this account');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
			});

			it('classifies "account suspended" as terminal', () => {
				const result = classifyError('Account suspended due to policy violation');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
			});

			it('classifies "model does not exist" as terminal', () => {
				const result = classifyError('The model does not exist: gpt-99');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
			});

			it('classifies "model not found" as terminal', () => {
				const result = classifyError('model not found in registry');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
			});

			it('classifies "no such model" as terminal', () => {
				const result = classifyError('No such model: my-custom-model');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
			});

			it('is case-insensitive for text patterns', () => {
				expect(classifyError('INVALID MODEL')!.class).toBe('terminal');
				expect(classifyError('Quota Exceeded')!.class).toBe('terminal');
			});
		});

		describe('realistic combined messages', () => {
			it('classifies full invalid-model API error as terminal with statusCode', () => {
				const msg =
					'API Error: 400 {"error":{"message":"Invalid model: claude-invalid-v99","type":"invalid_request_error"}}';
				const result = classifyError(msg);
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				// HTTP status check fires first, so statusCode is set
				expect(result!.statusCode).toBe(400);
			});

			it('classifies bare HTTP 400 with no text pattern as terminal', () => {
				const result = classifyError('API Error: 400 Bad Request');
				expect(result).not.toBeNull();
				expect(result!.class).toBe('terminal');
				expect(result!.statusCode).toBe(400);
			});
		});

		describe('unrecognized messages return null', () => {
			it('returns null for generic text', () => {
				expect(classifyError('Some unrelated error')).toBeNull();
			});

			it('returns null for empty string', () => {
				expect(classifyError('')).toBeNull();
			});

			it('returns null for network errors (not API errors)', () => {
				expect(classifyError('Network timeout')).toBeNull();
				expect(classifyError('Connection refused')).toBeNull();
			});

			it('returns null for file-system errors', () => {
				expect(classifyError('Error: ENOENT: no such file or directory')).toBeNull();
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
	});
});
