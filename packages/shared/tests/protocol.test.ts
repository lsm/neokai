import { describe, test, expect } from 'bun:test';
import {
	MessageType,
	GLOBAL_SESSION_ID,
	createCallMessage,
	createResultMessage,
	createErrorMessage,
	createEventMessage,
	createSubscribeMessage,
	createUnsubscribeMessage,
	isValidMessage,
	isCallMessage,
	isResultMessage,
	isErrorMessage,
	isEventMessage,
	isSubscribeMessage,
	isUnsubscribeMessage,
	isResponseMessage,
	validateMethod,
} from '../src/message-hub/protocol.ts';

describe('MessageHub Protocol', () => {
	describe('Message Type Constants', () => {
		test('should define all message types', () => {
			expect(MessageType.CALL).toBe(MessageType.CALL);
			expect(MessageType.RESULT).toBe(MessageType.RESULT);
			expect(MessageType.ERROR).toBe(MessageType.ERROR);
			expect(MessageType.EVENT).toBe(MessageType.EVENT);
			expect(MessageType.SUBSCRIBE).toBe(MessageType.SUBSCRIBE);
			expect(MessageType.UNSUBSCRIBE).toBe(MessageType.UNSUBSCRIBE);
			expect(MessageType.PING).toBe(MessageType.PING);
			expect(MessageType.PONG).toBe(MessageType.PONG);
		});

		test('should define global session ID', () => {
			expect(GLOBAL_SESSION_ID).toBe('global');
		});
	});

	describe('Message Creators', () => {
		test('createCallMessage should create valid CALL message', () => {
			const msg = createCallMessage({
				method: 'test.method',
				data: { foo: 'bar' },
				sessionId: 'session1',
				id: 'msg123',
			});

			expect(msg.type).toBe(MessageType.CALL);
			expect(msg.sessionId).toBe('session1');
			expect(msg.method).toBe('test.method');
			expect(msg.data).toEqual({ foo: 'bar' });
			expect(msg.id).toBe('msg123');
			expect(msg.timestamp).toBeTruthy();
		});

		test('createResultMessage should create valid RESULT message', () => {
			const msg = createResultMessage({
				method: 'test.method',
				data: { result: 'success' },
				sessionId: 'session1',
				requestId: 'req123',
				id: 'msg456',
			});

			expect(msg.type).toBe(MessageType.RESULT);
			expect(msg.requestId).toBe('req123');
			expect(msg.sessionId).toBe('session1');
			expect(msg.method).toBe('test.method');
			expect(msg.data).toEqual({ result: 'success' });
		});

		test('createErrorMessage should create valid ERROR message', () => {
			const msg = createErrorMessage({
				method: 'test.method',
				error: {
					code: 'TEST_ERROR',
					message: 'Something went wrong',
				},
				sessionId: 'session1',
				requestId: 'req123',
				id: 'msg789',
			});

			expect(msg.type).toBe(MessageType.ERROR);
			expect(msg.requestId).toBe('req123');
			expect(msg.sessionId).toBe('session1');
			expect(msg.method).toBe('test.method');
			expect(msg.error).toBe('Something went wrong');
			expect(msg.errorCode).toBe('TEST_ERROR');
		});

		test('createEventMessage should create valid EVENT message', () => {
			const msg = createEventMessage({
				method: 'user.created',
				data: { userId: 123 },
				sessionId: 'session1',
				id: 'evt123',
			});

			expect(msg.type).toBe(MessageType.EVENT);
			expect(msg.sessionId).toBe('session1');
			expect(msg.method).toBe('user.created');
			expect(msg.data).toEqual({ userId: 123 });
		});

		test('createSubscribeMessage should create valid SUBSCRIBE message', () => {
			const msg = createSubscribeMessage({
				method: 'user.*',
				sessionId: 'session1',
				id: 'sub123',
			});

			expect(msg.type).toBe(MessageType.SUBSCRIBE);
			expect(msg.sessionId).toBe('session1');
			expect(msg.method).toBe('user.*');
		});

		test('createUnsubscribeMessage should create valid UNSUBSCRIBE message', () => {
			const msg = createUnsubscribeMessage({
				method: 'user.*',
				sessionId: 'session1',
				id: 'unsub123',
			});

			expect(msg.type).toBe(MessageType.UNSUBSCRIBE);
			expect(msg.sessionId).toBe('session1');
			expect(msg.method).toBe('user.*');
		});
	});

	describe('Message Validators', () => {
		test('isValidMessage should validate message structure', () => {
			const validMsg = createCallMessage({
				method: 'test.method',
				data: {},
				sessionId: 'session1',
				id: 'msg1',
			});
			expect(isValidMessage(validMsg)).toBe(true);

			// Missing required fields
			expect(isValidMessage({})).toBe(false);
			expect(isValidMessage({ id: '123' })).toBe(false);
			expect(isValidMessage({ id: '123', type: 'CALL' })).toBe(false);
			expect(isValidMessage({ id: '123', type: 'CALL', sessionId: 's1' })).toBe(false);
		});

		test('isCallMessage should identify CALL messages', () => {
			const callMsg = createCallMessage({ method: 'test', data: {}, sessionId: 's1', id: 'msg1' });
			const resultMsg = createResultMessage({
				method: 'test',
				data: {},
				sessionId: 's1',
				requestId: 'req1',
				id: 'msg2',
			});

			expect(isCallMessage(callMsg)).toBe(true);
			expect(isCallMessage(resultMsg)).toBe(false);
		});

		test('isResultMessage should identify RESULT messages', () => {
			const resultMsg = createResultMessage({
				method: 'test',
				data: {},
				sessionId: 's1',
				requestId: 'req1',
				id: 'msg1',
			});
			const callMsg = createCallMessage({ method: 'test', data: {}, sessionId: 's1', id: 'msg2' });

			expect(isResultMessage(resultMsg)).toBe(true);
			expect(isResultMessage(callMsg)).toBe(false);
		});

		test('isErrorMessage should identify ERROR messages', () => {
			const errorMsg = createErrorMessage({
				method: 'test',
				error: 'fail',
				sessionId: 's1',
				requestId: 'req1',
				id: 'msg1',
			});
			const callMsg = createCallMessage({ method: 'test', data: {}, sessionId: 's1', id: 'msg2' });

			expect(isErrorMessage(errorMsg)).toBe(true);
			expect(isErrorMessage(callMsg)).toBe(false);
		});

		test('isEventMessage should identify EVENT messages', () => {
			const eventMsg = createEventMessage({
				method: 'event',
				data: {},
				sessionId: 's1',
				id: 'msg1',
			});
			const callMsg = createCallMessage({ method: 'event', data: {}, sessionId: 's1', id: 'msg2' });

			expect(isEventMessage(eventMsg)).toBe(true);
			expect(isEventMessage(callMsg)).toBe(false);
		});

		test('isSubscribeMessage should identify SUBSCRIBE messages', () => {
			const subMsg = createSubscribeMessage({ method: 'pattern', sessionId: 's1', id: 'msg1' });
			const unsubMsg = createUnsubscribeMessage({ method: 'pattern', sessionId: 's1', id: 'msg2' });

			expect(isSubscribeMessage(subMsg)).toBe(true);
			expect(isSubscribeMessage(unsubMsg)).toBe(false);
		});

		test('isUnsubscribeMessage should identify UNSUBSCRIBE messages', () => {
			const unsubMsg = createUnsubscribeMessage({ method: 'pattern', sessionId: 's1', id: 'msg1' });
			const subMsg = createSubscribeMessage({ method: 'pattern', sessionId: 's1', id: 'msg2' });

			expect(isUnsubscribeMessage(unsubMsg)).toBe(true);
			expect(isUnsubscribeMessage(subMsg)).toBe(false);
		});

		test('isResponseMessage should identify RESULT and ERROR messages', () => {
			const resultMsg = createResultMessage({
				method: 'test',
				data: {},
				sessionId: 's1',
				requestId: 'req1',
				id: 'msg1',
			});
			const errorMsg = createErrorMessage({
				method: 'test',
				error: 'fail',
				sessionId: 's1',
				requestId: 'req1',
				id: 'msg2',
			});
			const callMsg = createCallMessage({ method: 'test', data: {}, sessionId: 's1', id: 'msg3' });

			expect(isResponseMessage(resultMsg)).toBe(true);
			expect(isResponseMessage(errorMsg)).toBe(true);
			expect(isResponseMessage(callMsg)).toBe(false);
		});
	});

	describe('Method Validation', () => {
		test('should accept valid method names', () => {
			expect(validateMethod('session.create')).toBe(true);
			expect(validateMethod('user.updated')).toBe(true);
			expect(validateMethod('client.getViewportInfo')).toBe(true);
			expect(validateMethod('deeply.nested.method.name')).toBe(true);
			expect(validateMethod('method_with_underscore.test')).toBe(true);
			expect(validateMethod('method-with-dash.test')).toBe(true);
		});

		test('should reject invalid method names', () => {
			expect(validateMethod('no-dot')).toBe(false);
			expect(validateMethod('.starts-with-dot')).toBe(false);
			expect(validateMethod('ends-with-dot.')).toBe(false);
			expect(validateMethod('has space.method')).toBe(false);
			expect(validateMethod('has@symbol.method')).toBe(false);
			expect(validateMethod('')).toBe(false);
		});
	});

	describe('Message IDs', () => {
		test('should use provided message ID', () => {
			const msg1 = createCallMessage({
				method: 'test',
				data: {},
				sessionId: 's1',
				id: 'custom-id-1',
			});
			const msg2 = createCallMessage({
				method: 'test',
				data: {},
				sessionId: 's1',
				id: 'custom-id-2',
			});

			expect(msg1.id).toBe('custom-id-1');
			expect(msg2.id).toBe('custom-id-2');
			expect(msg1.id).not.toBe(msg2.id);
		});

		test('should include timestamp in all messages', () => {
			const msg = createCallMessage({ method: 'test', data: {}, sessionId: 's1', id: 'msg1' });
			const timestamp = new Date(msg.timestamp);

			expect(timestamp.getTime()).toBeGreaterThan(Date.now() - 1000);
			expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
		});
	});
});
