import { describe, expect, it } from 'bun:test';
import { isWorkerSessionId } from '../../../src/lib/room/session-utils';

describe('isWorkerSessionId', () => {
	it('returns true for plain worker session IDs', () => {
		expect(isWorkerSessionId('session-abc123')).toBe(true);
		expect(isWorkerSessionId('worker-1')).toBe(true);
		expect(isWorkerSessionId('abc')).toBe(true);
	});

	it('returns false for room:chat: sessions', () => {
		expect(isWorkerSessionId('room:chat:room-1')).toBe(false);
	});

	it('returns false for room:self: sessions', () => {
		expect(isWorkerSessionId('room:self:room-1')).toBe(false);
	});

	it('returns false for room:craft: sessions', () => {
		expect(isWorkerSessionId('room:craft:room-1')).toBe(false);
	});

	it('returns false for room:lead: sessions', () => {
		expect(isWorkerSessionId('room:lead:room-1')).toBe(false);
	});

	it('returns true for IDs that contain but do not start with an internal prefix', () => {
		// e.g. a session whose ID happens to contain "room:chat:" mid-string
		expect(isWorkerSessionId('prefix-room:chat:room-1')).toBe(true);
	});
});
