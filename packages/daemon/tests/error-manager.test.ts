/**
 * ErrorManager Tests
 *
 * Tests error categorization, user-friendly message generation,
 * and error broadcasting functionality.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ErrorManager, ErrorCategory } from '../src/lib/error-manager';
import { MessageHub } from '@liuboer/shared';

describe('ErrorManager', () => {
	let errorManager: ErrorManager;
	let mockMessageHub: MessageHub;
	let publishSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		// Create mock MessageHub
		publishSpy = mock(async () => {});
		mockMessageHub = {
			publish: publishSpy,
		} as unknown as MessageHub;

		errorManager = new ErrorManager(mockMessageHub);
	});

	describe('createError', () => {
		it('should create structured error from Error object', () => {
			const error = new Error('Test error');
			const structured = errorManager.createError(error, ErrorCategory.SYSTEM);

			expect(structured).toMatchObject({
				category: ErrorCategory.SYSTEM,
				message: 'Test error',
				recoverable: true,
			});
			expect(structured.timestamp).toBeDefined();
			expect(structured.userMessage).toBeDefined();
		});

		it('should create structured error from string', () => {
			const structured = errorManager.createError('String error', ErrorCategory.MESSAGE);

			expect(structured).toMatchObject({
				category: ErrorCategory.MESSAGE,
				message: 'String error',
			});
		});

		it('should use custom user message when provided', () => {
			const customMessage = 'Custom user-friendly message';
			const structured = errorManager.createError(
				'Technical error',
				ErrorCategory.SYSTEM,
				customMessage
			);

			expect(structured.userMessage).toBe(customMessage);
		});
	});

	describe('error code extraction', () => {
		it('should extract UNAUTHORIZED code', () => {
			const structured = errorManager.createError(
				new Error('401 unauthorized'),
				ErrorCategory.AUTHENTICATION
			);
			expect(structured.code).toBe('UNAUTHORIZED');
		});

		it('should extract FORBIDDEN code', () => {
			const structured = errorManager.createError(
				new Error('403 forbidden'),
				ErrorCategory.AUTHENTICATION
			);
			expect(structured.code).toBe('FORBIDDEN');
		});

		it('should extract NOT_FOUND code', () => {
			const structured = errorManager.createError(
				new Error('404 not found'),
				ErrorCategory.SESSION
			);
			expect(structured.code).toBe('NOT_FOUND');
		});

		it('should extract RATE_LIMITED code', () => {
			const structured = errorManager.createError(
				new Error('429 rate limit exceeded'),
				ErrorCategory.RATE_LIMIT
			);
			expect(structured.code).toBe('RATE_LIMITED');
		});

		it('should extract TIMEOUT code', () => {
			const structured = errorManager.createError(
				new Error('Request timeout'),
				ErrorCategory.TIMEOUT
			);
			expect(structured.code).toBe('TIMEOUT');
		});

		it('should extract CONNECTION_REFUSED code', () => {
			const structured = errorManager.createError(
				new Error('ECONNREFUSED'),
				ErrorCategory.CONNECTION
			);
			expect(structured.code).toBe('CONNECTION_REFUSED');
		});

		it('should extract HOST_UNREACHABLE code', () => {
			const structured = errorManager.createError(new Error('ENOTFOUND'), ErrorCategory.CONNECTION);
			expect(structured.code).toBe('HOST_UNREACHABLE');
		});

		it('should extract INVALID_API_KEY code', () => {
			const structured = errorManager.createError(
				new Error('invalid_api_key'),
				ErrorCategory.AUTHENTICATION
			);
			expect(structured.code).toBe('INVALID_API_KEY');
		});

		it('should extract MODEL_NOT_FOUND code', () => {
			const structured = errorManager.createError(
				new Error('model_not_found'),
				ErrorCategory.MODEL
			);
			expect(structured.code).toBe('MODEL_NOT_FOUND');
		});

		it('should extract QUOTA_EXCEEDED code', () => {
			const structured = errorManager.createError(
				new Error('insufficient_quota'),
				ErrorCategory.RATE_LIMIT
			);
			expect(structured.code).toBe('QUOTA_EXCEEDED');
		});

		it('should default to UNKNOWN for unrecognized errors', () => {
			const structured = errorManager.createError(
				new Error('Some random error'),
				ErrorCategory.SYSTEM
			);
			expect(structured.code).toBe('UNKNOWN');
		});
	});

	describe('user-friendly messages', () => {
		it('should provide friendly message for authentication errors', () => {
			const structured = errorManager.createError(
				new Error('invalid_api_key'),
				ErrorCategory.AUTHENTICATION
			);
			expect(structured.userMessage).toBe('Invalid API key. Please check your configuration.');
		});

		it('should provide friendly message for connection errors', () => {
			const structured = errorManager.createError(
				new Error('ECONNREFUSED'),
				ErrorCategory.CONNECTION
			);
			expect(structured.userMessage).toBe(
				'Unable to connect to the server. Please check if the service is running.'
			);
		});

		it('should provide friendly message for session not found', () => {
			const structured = errorManager.createError(
				new Error('Session not found'),
				ErrorCategory.SESSION
			);
			expect(structured.userMessage).toBe(
				'Session not found. It may have been deleted or expired.'
			);
		});

		it('should provide friendly message for rate limit errors', () => {
			const structured = errorManager.createError(
				new Error('429 rate limit'),
				ErrorCategory.RATE_LIMIT
			);
			expect(structured.userMessage).toBe(
				'Rate limit exceeded. Please wait a moment before trying again.'
			);
		});

		it('should provide friendly message for model errors', () => {
			const structured = errorManager.createError(
				new Error('model_not_found'),
				ErrorCategory.MODEL
			);
			expect(structured.userMessage).toBe(
				'The requested model is not available. Please choose a different model.'
			);
		});

		it('should provide friendly message for timeout errors', () => {
			const structured = errorManager.createError(new Error('timeout'), ErrorCategory.TIMEOUT);
			expect(structured.userMessage).toBe('Request timed out. Please try again.');
		});

		it('should provide friendly message for validation errors', () => {
			const structured = errorManager.createError(
				new Error('validation failed'),
				ErrorCategory.VALIDATION
			);
			expect(structured.userMessage).toBe(
				'Invalid request. Please check your input and try again.'
			);
		});

		it('should provide friendly message for permission errors', () => {
			const structured = errorManager.createError(
				new Error('permission denied'),
				ErrorCategory.PERMISSION
			);
			expect(structured.userMessage).toBe(
				"Permission denied. You don't have access to this resource."
			);
		});

		it('should handle disk space errors', () => {
			const structured = errorManager.createError(new Error('ENOSPC'), ErrorCategory.SYSTEM);
			expect(structured.userMessage).toBe(
				'Disk space full. Please free up some space and try again.'
			);
		});

		it('should handle memory errors', () => {
			const structured = errorManager.createError(new Error('ENOMEM'), ErrorCategory.SYSTEM);
			expect(structured.userMessage).toBe(
				'Out of memory. Please close some applications and try again.'
			);
		});
	});

	describe('recoverability', () => {
		it('should mark invalid API key as non-recoverable', () => {
			const structured = errorManager.createError(
				new Error('invalid_api_key'),
				ErrorCategory.AUTHENTICATION
			);
			expect(structured.recoverable).toBe(false);
		});

		it('should mark permission errors as non-recoverable', () => {
			const structured = errorManager.createError(
				new Error('permission denied'),
				ErrorCategory.PERMISSION
			);
			expect(structured.recoverable).toBe(false);
		});

		it('should mark quota exceeded as non-recoverable', () => {
			const structured = errorManager.createError(
				new Error('quota exceeded'),
				ErrorCategory.RATE_LIMIT
			);
			expect(structured.recoverable).toBe(false);
		});

		it('should mark timeout errors as recoverable', () => {
			const structured = errorManager.createError(new Error('timeout'), ErrorCategory.TIMEOUT);
			expect(structured.recoverable).toBe(true);
		});

		it('should mark connection errors as recoverable', () => {
			const structured = errorManager.createError(
				new Error('ECONNREFUSED'),
				ErrorCategory.CONNECTION
			);
			expect(structured.recoverable).toBe(true);
		});

		it('should mark most errors as recoverable by default', () => {
			const structured = errorManager.createError(new Error('unknown'), ErrorCategory.SYSTEM);
			expect(structured.recoverable).toBe(true);
		});
	});

	describe('broadcastError', () => {
		it('should publish error to MessageHub with correct format', async () => {
			const sessionId = 'test-session-123';
			const error = errorManager.createError(new Error('test'), ErrorCategory.SYSTEM);

			await errorManager.broadcastError(sessionId, error);

			expect(publishSpy).toHaveBeenCalledTimes(1);
			expect(publishSpy).toHaveBeenCalledWith(
				'session.error',
				{
					error: error.userMessage,
					errorDetails: error,
				},
				{ sessionId }
			);
		});
	});

	describe('handleError', () => {
		it('should create error and broadcast it', async () => {
			const sessionId = 'test-session-456';
			const errorMessage = 'Test error message';

			const result = await errorManager.handleError(
				sessionId,
				new Error(errorMessage),
				ErrorCategory.MESSAGE
			);

			expect(result.message).toBe(errorMessage);
			expect(result.category).toBe(ErrorCategory.MESSAGE);
			expect(publishSpy).toHaveBeenCalledTimes(1);
		});

		it('should use custom user message when provided', async () => {
			const sessionId = 'test-session-789';
			const customMessage = 'Custom error message';

			const result = await errorManager.handleError(
				sessionId,
				new Error('Technical error'),
				ErrorCategory.SYSTEM,
				customMessage
			);

			expect(result.userMessage).toBe(customMessage);
		});

		it('should handle string errors', async () => {
			const sessionId = 'test-session-abc';
			const result = await errorManager.handleError(
				sessionId,
				'String error',
				ErrorCategory.SYSTEM
			);

			expect(result.message).toBe('String error');
			expect(publishSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('error categories', () => {
		it('should handle all error categories', () => {
			const categories = [
				ErrorCategory.AUTHENTICATION,
				ErrorCategory.CONNECTION,
				ErrorCategory.SESSION,
				ErrorCategory.MESSAGE,
				ErrorCategory.MODEL,
				ErrorCategory.SYSTEM,
				ErrorCategory.VALIDATION,
				ErrorCategory.TIMEOUT,
				ErrorCategory.PERMISSION,
				ErrorCategory.RATE_LIMIT,
			];

			categories.forEach((category) => {
				const structured = errorManager.createError(new Error('test'), category);
				expect(structured.category).toBe(category);
				expect(structured.userMessage).toBeDefined();
				expect(structured.userMessage.length).toBeGreaterThan(0);
			});
		});
	});
});
