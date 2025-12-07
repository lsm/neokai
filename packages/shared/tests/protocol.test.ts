import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
	MessageType,
	isSubscriptionResponseMessage,
	createSubscribedMessage,
	createUnsubscribedMessage,
	isValidMessage,
	validateMethod,
	PROTOCOL_VERSION,
	type HubMessage,
} from '../src/message-hub/protocol.ts';

describe('Protocol - Type Guards', () => {
	test('isSubscriptionResponseMessage returns true for SUBSCRIBED', () => {
		const message: HubMessage = {
			id: '123',
			type: MessageType.SUBSCRIBED,
			sessionId: 'session-1',
			method: 'test.event',
			requestId: 'req-1',
			timestamp: new Date().toISOString(),
		};
		expect(isSubscriptionResponseMessage(message)).toBe(true);
	});

	test('isSubscriptionResponseMessage returns true for UNSUBSCRIBED', () => {
		const message: HubMessage = {
			id: '123',
			type: MessageType.UNSUBSCRIBED,
			sessionId: 'session-1',
			method: 'test.event',
			requestId: 'req-1',
			timestamp: new Date().toISOString(),
		};
		expect(isSubscriptionResponseMessage(message)).toBe(true);
	});

	test('isSubscriptionResponseMessage returns false for other types', () => {
		const message: HubMessage = {
			id: '123',
			type: MessageType.CALL,
			sessionId: 'session-1',
			method: 'test.method',
			timestamp: new Date().toISOString(),
		};
		expect(isSubscriptionResponseMessage(message)).toBe(false);
	});
});

describe('Protocol - Message Creators', () => {
	test('createSubscribedMessage creates valid SUBSCRIBED message', () => {
		const message = createSubscribedMessage({
			method: 'test.event',
			sessionId: 'session-1',
			requestId: 'req-123',
		});

		expect(message.type).toBe(MessageType.SUBSCRIBED);
		expect(message.method).toBe('test.event');
		expect(message.sessionId).toBe('session-1');
		expect(message.requestId).toBe('req-123');
		expect(message.data).toEqual({
			subscribed: true,
			method: 'test.event',
			sessionId: 'session-1',
		});
		expect(message.id).toBeTruthy();
		expect(message.timestamp).toBeTruthy();
		expect(message.version).toBe(PROTOCOL_VERSION);
	});

	test('createSubscribedMessage accepts custom id', () => {
		const message = createSubscribedMessage({
			method: 'test.event',
			sessionId: 'session-1',
			requestId: 'req-123',
			id: 'custom-id',
		});

		expect(message.id).toBe('custom-id');
	});

	test('createUnsubscribedMessage creates valid UNSUBSCRIBED message', () => {
		const message = createUnsubscribedMessage({
			method: 'test.event',
			sessionId: 'session-1',
			requestId: 'req-123',
		});

		expect(message.type).toBe(MessageType.UNSUBSCRIBED);
		expect(message.method).toBe('test.event');
		expect(message.sessionId).toBe('session-1');
		expect(message.requestId).toBe('req-123');
		expect(message.data).toEqual({
			unsubscribed: true,
			method: 'test.event',
			sessionId: 'session-1',
		});
		expect(message.id).toBeTruthy();
		expect(message.timestamp).toBeTruthy();
		expect(message.version).toBe(PROTOCOL_VERSION);
	});

	test('createUnsubscribedMessage accepts custom id', () => {
		const message = createUnsubscribedMessage({
			method: 'test.event',
			sessionId: 'session-1',
			requestId: 'req-123',
			id: 'custom-id',
		});

		expect(message.id).toBe('custom-id');
	});
});

describe('Protocol - Validation', () => {
	describe('validateMethod', () => {
		test('validates correct method format', () => {
			expect(validateMethod('session.create')).toBe(true);
			expect(validateMethod('user.update')).toBe(true);
			expect(validateMethod('system.health.check')).toBe(true);
			expect(validateMethod('test_method.action-name')).toBe(true);
		});

		test('rejects method without dot', () => {
			expect(validateMethod('invalid')).toBe(false);
		});

		test('rejects method starting with dot', () => {
			expect(validateMethod('.invalid.method')).toBe(false);
		});

		test('rejects method ending with dot', () => {
			expect(validateMethod('invalid.method.')).toBe(false);
		});

		test('rejects method with colon (reserved)', () => {
			expect(validateMethod('invalid:method')).toBe(false);
			expect(validateMethod('session:123:method')).toBe(false);
		});

		test('rejects method with invalid characters', () => {
			expect(validateMethod('invalid method')).toBe(false); // space
			expect(validateMethod('invalid@method')).toBe(false); // @
			expect(validateMethod('invalid#method')).toBe(false); // #
			expect(validateMethod('invalid/method')).toBe(false); // /
		});

		test('accepts alphanumeric, dots, underscores, hyphens', () => {
			expect(validateMethod('valid_method.with-hyphen123')).toBe(true);
			expect(validateMethod('method.123.action')).toBe(true);
		});
	});

	describe('isValidMessage', () => {
		let originalWarn: typeof console.warn;

		beforeEach(() => {
			originalWarn = console.warn;
			console.warn = () => {}; // Suppress warnings during tests
		});

		afterEach(() => {
			console.warn = originalWarn;
		});

		test('validates complete valid message', () => {
			const message: HubMessage = {
				id: 'msg-123',
				type: MessageType.CALL,
				sessionId: 'session-1',
				method: 'test.method',
				timestamp: new Date().toISOString(),
				version: PROTOCOL_VERSION,
			};
			expect(isValidMessage(message)).toBe(true);
		});

		test('rejects non-object', () => {
			expect(isValidMessage(null)).toBe(false);
			expect(isValidMessage(undefined)).toBe(false);
			expect(isValidMessage('string')).toBe(false);
			expect(isValidMessage(123)).toBe(false);
		});

		test('rejects message without id', () => {
			const message = {
				type: MessageType.CALL,
				sessionId: 'session-1',
				method: 'test.method',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects message with empty id', () => {
			const message = {
				id: '',
				type: MessageType.CALL,
				sessionId: 'session-1',
				method: 'test.method',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects message with invalid type', () => {
			const message = {
				id: 'msg-123',
				type: 'INVALID_TYPE',
				sessionId: 'session-1',
				method: 'test.method',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects message without sessionId', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.CALL,
				method: 'test.method',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects message with empty sessionId', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.CALL,
				sessionId: '',
				method: 'test.method',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects message without method', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.CALL,
				sessionId: 'session-1',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects message with empty method', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.CALL,
				sessionId: 'session-1',
				method: '',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects message without timestamp', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.CALL,
				sessionId: 'session-1',
				method: 'test.method',
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects message with non-string version', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.CALL,
				sessionId: 'session-1',
				method: 'test.method',
				timestamp: new Date().toISOString(),
				version: 123, // Should be string
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('warns on version mismatch but allows message', () => {
			const warnSpy: string[] = [];
			console.warn = (...args: unknown[]) => {
				warnSpy.push(args.join(' '));
			};

			const message: HubMessage = {
				id: 'msg-123',
				type: MessageType.CALL,
				sessionId: 'session-1',
				method: 'test.method',
				timestamp: new Date().toISOString(),
				version: '2.0.0', // Different version
			};

			expect(isValidMessage(message)).toBe(true);
			expect(warnSpy.length).toBeGreaterThan(0);
			expect(warnSpy[0]).toContain('Version mismatch');
		});

		test('validates PING/PONG without method validation', () => {
			const pingMessage: HubMessage = {
				id: 'msg-123',
				type: MessageType.PING,
				sessionId: 'session-1',
				method: 'heartbeat', // PING/PONG can have any method
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(pingMessage)).toBe(true);

			const pongMessage: HubMessage = {
				id: 'msg-123',
				type: MessageType.PONG,
				sessionId: 'session-1',
				method: 'heartbeat',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(pongMessage)).toBe(true);
		});

		test('validates method format for non-PING/PONG messages', () => {
			const invalidMethod = {
				id: 'msg-123',
				type: MessageType.CALL,
				sessionId: 'session-1',
				method: 'invalid', // No dot
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(invalidMethod)).toBe(false);
		});

		test('rejects RESULT without requestId', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.RESULT,
				sessionId: 'session-1',
				method: 'test.method',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects ERROR without requestId', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.ERROR,
				sessionId: 'session-1',
				method: 'test.method',
				error: 'Error message',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('rejects ERROR without error field', () => {
			const message = {
				id: 'msg-123',
				type: MessageType.ERROR,
				sessionId: 'session-1',
				method: 'test.method',
				requestId: 'req-123',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(false);
		});

		test('accepts RESULT with requestId', () => {
			const message: HubMessage = {
				id: 'msg-123',
				type: MessageType.RESULT,
				sessionId: 'session-1',
				method: 'test.method',
				requestId: 'req-123',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(true);
		});

		test('accepts ERROR with requestId and error', () => {
			const message: HubMessage = {
				id: 'msg-123',
				type: MessageType.ERROR,
				sessionId: 'session-1',
				method: 'test.method',
				requestId: 'req-123',
				error: 'Error message',
				timestamp: new Date().toISOString(),
			};
			expect(isValidMessage(message)).toBe(true);
		});
	});
});
