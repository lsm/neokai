/**
 * ErrorManager - Centralized error handling and categorization
 *
 * Provides structured error handling with proper user-facing messages
 * and error categorization for better debugging and user experience.
 */

import type { MessageHub } from '@liuboer/shared';

export enum ErrorCategory {
	AUTHENTICATION = 'authentication',
	CONNECTION = 'connection',
	SESSION = 'session',
	MESSAGE = 'message',
	MODEL = 'model',
	SYSTEM = 'system',
	VALIDATION = 'validation',
	TIMEOUT = 'timeout',
	PERMISSION = 'permission',
	RATE_LIMIT = 'rate_limit',
}

export interface StructuredError {
	category: ErrorCategory;
	code: string;
	message: string;
	userMessage: string;
	details?: any;
	recoverable: boolean;
	timestamp: string;
}

export class ErrorManager {
	constructor(private messageHub: MessageHub) {}

	/**
	 * Create a structured error from various error types
	 */
	createError(
		error: Error | string,
		category: ErrorCategory = ErrorCategory.SYSTEM,
		userMessage?: string
	): StructuredError {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const errorCode = this.extractErrorCode(errorMessage);

		return {
			category,
			code: errorCode,
			message: errorMessage,
			userMessage: userMessage || this.getUserFriendlyMessage(category, errorCode, errorMessage),
			recoverable: this.isRecoverable(category, errorCode),
			timestamp: new Date().toISOString(),
		};
	}

	/**
	 * Extract error code from error message
	 */
	private extractErrorCode(message: string): string {
		// Check for common error patterns
		if (message.includes('401') || message.includes('unauthorized')) {
			return 'UNAUTHORIZED';
		}
		if (message.includes('403') || message.includes('forbidden')) {
			return 'FORBIDDEN';
		}
		if (message.includes('404') || message.includes('not found')) {
			return 'NOT_FOUND';
		}
		if (message.includes('429') || message.includes('rate limit')) {
			return 'RATE_LIMITED';
		}
		if (message.includes('timeout')) {
			return 'TIMEOUT';
		}
		if (message.includes('ECONNREFUSED') || message.includes('connection refused')) {
			return 'CONNECTION_REFUSED';
		}
		if (message.includes('ENOTFOUND') || message.includes('EHOSTUNREACH')) {
			return 'HOST_UNREACHABLE';
		}
		if (message.includes('insufficient_quota') || message.includes('quota exceeded')) {
			return 'QUOTA_EXCEEDED';
		}
		if (message.includes('invalid_api_key')) {
			return 'INVALID_API_KEY';
		}
		if (message.includes('model_not_found')) {
			return 'MODEL_NOT_FOUND';
		}

		return 'UNKNOWN';
	}

	/**
	 * Generate user-friendly error message
	 */
	private getUserFriendlyMessage(
		category: ErrorCategory,
		code: string,
		originalMessage: string
	): string {
		// Category-specific messages
		switch (category) {
			case ErrorCategory.AUTHENTICATION:
				switch (code) {
					case 'INVALID_API_KEY':
						return 'Invalid API key. Please check your configuration.';
					case 'UNAUTHORIZED':
						return 'Authentication failed. Please verify your credentials.';
					case 'FORBIDDEN':
						return "Access denied. You don't have permission to perform this action.";
					default:
						return 'Authentication error. Please check your credentials.';
				}

			case ErrorCategory.CONNECTION:
				switch (code) {
					case 'CONNECTION_REFUSED':
						return 'Unable to connect to the server. Please check if the service is running.';
					case 'HOST_UNREACHABLE':
						return 'Cannot reach the server. Please check your network connection.';
					case 'TIMEOUT':
						return 'Connection timed out. The server may be experiencing high load.';
					default:
						return 'Connection error. Please check your network and try again.';
				}

			case ErrorCategory.SESSION:
				switch (code) {
					case 'NOT_FOUND':
						return 'Session not found. It may have been deleted or expired.';
					default:
						return 'Session error. Please try creating a new session.';
				}

			case ErrorCategory.MESSAGE:
				if (originalMessage.includes('context length')) {
					return 'Message exceeds context limit. Consider starting a new conversation.';
				}
				return 'Failed to process message. Please try again.';

			case ErrorCategory.MODEL:
				switch (code) {
					case 'MODEL_NOT_FOUND':
						return 'The requested model is not available. Please choose a different model.';
					default:
						return 'Model error. Please try a different model.';
				}

			case ErrorCategory.RATE_LIMIT:
				switch (code) {
					case 'RATE_LIMITED':
						return 'Rate limit exceeded. Please wait a moment before trying again.';
					case 'QUOTA_EXCEEDED':
						return 'API quota exceeded. Please check your usage limits.';
					default:
						return 'Request limit reached. Please slow down and try again.';
				}

			case ErrorCategory.TIMEOUT:
				return 'Request timed out. Please try again.';

			case ErrorCategory.VALIDATION:
				return 'Invalid request. Please check your input and try again.';

			case ErrorCategory.PERMISSION:
				return "Permission denied. You don't have access to this resource.";

			case ErrorCategory.SYSTEM:
			default:
				if (originalMessage.includes('ENOSPC')) {
					return 'Disk space full. Please free up some space and try again.';
				}
				if (originalMessage.includes('ENOMEM')) {
					return 'Out of memory. Please close some applications and try again.';
				}
				return 'An unexpected error occurred. Please try again or contact support if the issue persists.';
		}
	}

	/**
	 * Determine if error is recoverable
	 */
	private isRecoverable(category: ErrorCategory, code: string): boolean {
		// Non-recoverable errors
		if (category === ErrorCategory.AUTHENTICATION && code === 'INVALID_API_KEY') {
			return false;
		}
		if (category === ErrorCategory.PERMISSION) {
			return false;
		}
		if (code === 'QUOTA_EXCEEDED') {
			return false;
		}

		// Most other errors are recoverable (can retry)
		return true;
	}

	/**
	 * Broadcast error to clients
	 */
	async broadcastError(sessionId: string, error: StructuredError): Promise<void> {
		await this.messageHub.publish(
			'session.error',
			{
				error: error.userMessage,
				errorDetails: error,
			},
			{ sessionId }
		);
	}

	/**
	 * Handle and broadcast error
	 */
	async handleError(
		sessionId: string,
		error: Error | string,
		category: ErrorCategory = ErrorCategory.SYSTEM,
		userMessage?: string
	): Promise<StructuredError> {
		const structuredError = this.createError(error, category, userMessage);

		// Log for debugging
		console.error(`[ErrorManager] ${category}:`, {
			code: structuredError.code,
			message: structuredError.message,
			sessionId,
		});

		// Broadcast to client
		await this.broadcastError(sessionId, structuredError);

		return structuredError;
	}
}
