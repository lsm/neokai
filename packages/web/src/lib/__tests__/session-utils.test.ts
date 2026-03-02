import { describe, it, expect } from 'vitest';
import { isUserSession } from '../session-utils';
import type { Session } from '@neokai/shared';

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'test-id',
		title: 'Test Session',
		workspacePath: '/tmp/test',
		status: 'active',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			totalCost: 0,
		},
		config: {
			model: 'sonnet',
		},
		...overrides,
	} as Session;
}

describe('isUserSession', () => {
	it('should return true for worker sessions', () => {
		const session = makeSession({ type: 'worker' });
		expect(isUserSession(session)).toBe(true);
	});

	it('should return true for sessions without type (legacy)', () => {
		const session = makeSession({ type: undefined });
		expect(isUserSession(session)).toBe(true);
	});

	it('should return false for planner sessions', () => {
		const session = makeSession({ type: 'planner' });
		expect(isUserSession(session)).toBe(false);
	});

	it('should return false for coder sessions', () => {
		const session = makeSession({ type: 'coder' });
		expect(isUserSession(session)).toBe(false);
	});

	it('should return false for leader sessions', () => {
		const session = makeSession({ type: 'leader' });
		expect(isUserSession(session)).toBe(false);
	});

	it('should return false for general sessions', () => {
		const session = makeSession({ type: 'general' });
		expect(isUserSession(session)).toBe(false);
	});

	it('should return false for lobby sessions', () => {
		const session = makeSession({ type: 'lobby' });
		expect(isUserSession(session)).toBe(false);
	});

	it('should return false for room_chat sessions', () => {
		const session = makeSession({ type: 'room_chat' });
		expect(isUserSession(session)).toBe(false);
	});

	it('should return false for worker sessions with roomId', () => {
		const session = makeSession({
			type: 'worker',
			context: { roomId: 'room-123' },
		});
		expect(isUserSession(session)).toBe(false);
	});

	it('should return true for worker sessions without context', () => {
		const session = makeSession({ type: 'worker', context: undefined });
		expect(isUserSession(session)).toBe(true);
	});

	it('should return true for worker sessions with empty context', () => {
		const session = makeSession({ type: 'worker', context: {} });
		expect(isUserSession(session)).toBe(true);
	});
});
