/**
 * Tests for Connection Error Types
 */

import { describe, it, expect } from 'bun:test';
import {
	ConnectionError,
	ConnectionNotReadyError,
	ConnectionTimeoutError,
	RPCTimeoutError,
	MaxReconnectAttemptsError,
	isConnectionError,
	isRecoverableConnectionError,
} from '../errors';

describe('ConnectionError', () => {
	it('should create a basic ConnectionError', () => {
		const error = new ConnectionError('test error');
		expect(error.message).toBe('test error');
		expect(error.name).toBe('ConnectionError');
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(ConnectionError);
	});

	it('should have proper stack trace', () => {
		const error = new ConnectionError('test');
		expect(error.stack).toBeDefined();
		expect(error.stack).toContain('ConnectionError');
	});
});

describe('ConnectionNotReadyError', () => {
	it('should create with default message', () => {
		const error = new ConnectionNotReadyError();
		expect(error.message).toBe('Connection not ready');
		expect(error.name).toBe('ConnectionNotReadyError');
	});

	it('should create with custom message', () => {
		const error = new ConnectionNotReadyError('Custom message');
		expect(error.message).toBe('Custom message');
	});

	it('should be instanceof ConnectionError', () => {
		const error = new ConnectionNotReadyError();
		expect(error).toBeInstanceOf(ConnectionError);
	});
});

describe('ConnectionTimeoutError', () => {
	it('should create with timeout value', () => {
		const error = new ConnectionTimeoutError(5000);
		expect(error.message).toBe('Connection timed out after 5000ms');
		expect(error.name).toBe('ConnectionTimeoutError');
		expect(error.timeoutMs).toBe(5000);
	});

	it('should create with custom message', () => {
		const error = new ConnectionTimeoutError(5000, 'Custom timeout message');
		expect(error.message).toBe('Custom timeout message');
		expect(error.timeoutMs).toBe(5000);
	});

	it('should be instanceof ConnectionError', () => {
		const error = new ConnectionTimeoutError(5000);
		expect(error).toBeInstanceOf(ConnectionError);
	});
});

describe('RPCTimeoutError', () => {
	it('should create with method and timeout', () => {
		const error = new RPCTimeoutError('session.create', 10000);
		expect(error.message).toBe('RPC call "session.create" timed out after 10000ms');
		expect(error.name).toBe('RPCTimeoutError');
		expect(error.method).toBe('session.create');
		expect(error.timeoutMs).toBe(10000);
	});

	it('should be instanceof ConnectionError', () => {
		const error = new RPCTimeoutError('test', 1000);
		expect(error).toBeInstanceOf(ConnectionError);
	});
});

describe('MaxReconnectAttemptsError', () => {
	it('should create with attempts count', () => {
		const error = new MaxReconnectAttemptsError(5);
		expect(error.message).toBe('Max reconnection attempts (5) exceeded');
		expect(error.name).toBe('MaxReconnectAttemptsError');
		expect(error.attempts).toBe(5);
	});

	it('should be instanceof ConnectionError', () => {
		const error = new MaxReconnectAttemptsError(3);
		expect(error).toBeInstanceOf(ConnectionError);
	});
});

describe('isConnectionError', () => {
	it('should return true for ConnectionError instances', () => {
		expect(isConnectionError(new ConnectionError('test'))).toBe(true);
		expect(isConnectionError(new ConnectionNotReadyError())).toBe(true);
		expect(isConnectionError(new ConnectionTimeoutError(1000))).toBe(true);
		expect(isConnectionError(new RPCTimeoutError('test', 1000))).toBe(true);
		expect(isConnectionError(new MaxReconnectAttemptsError(5))).toBe(true);
	});

	it('should return false for non-ConnectionError', () => {
		expect(isConnectionError(new Error('test'))).toBe(false);
		expect(isConnectionError('string error')).toBe(false);
		expect(isConnectionError(null)).toBe(false);
		expect(isConnectionError(undefined)).toBe(false);
		expect(isConnectionError({ message: 'fake error' })).toBe(false);
	});
});

describe('isRecoverableConnectionError', () => {
	it('should return true for recoverable errors', () => {
		expect(isRecoverableConnectionError(new ConnectionNotReadyError())).toBe(true);
		expect(isRecoverableConnectionError(new ConnectionTimeoutError(1000))).toBe(true);
		expect(isRecoverableConnectionError(new RPCTimeoutError('test', 1000))).toBe(true);
	});

	it('should return false for non-recoverable errors', () => {
		expect(isRecoverableConnectionError(new MaxReconnectAttemptsError(5))).toBe(false);
	});

	it('should return false for non-ConnectionError', () => {
		expect(isRecoverableConnectionError(new Error('test'))).toBe(false);
		expect(isRecoverableConnectionError('string')).toBe(false);
		expect(isRecoverableConnectionError(null)).toBe(false);
	});

	it('should return true for generic ConnectionError', () => {
		expect(isRecoverableConnectionError(new ConnectionError('test'))).toBe(true);
	});
});
