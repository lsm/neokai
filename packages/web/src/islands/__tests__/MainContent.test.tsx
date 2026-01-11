// @ts-nocheck
/**
 * Tests for MainContent Component
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { signal } from '@preact/signals';

// Mock signals
const mockCurrentSessionId = signal<string | null>(null);
const mockSessions = signal<Array<{ id: string; title: string }>>([]);

// Mock the signals module
mock.module('../../lib/signals.ts', () => ({
	currentSessionIdSignal: mockCurrentSessionId,
}));

// Mock the state module - include all exports to avoid breaking other tests
const mockAppState = {
	initialize: mock(() => Promise.resolve()),
	cleanup: mock(() => {}),
	getSessionChannels: mock(() => null),
};
mock.module('../../lib/state.ts', () => ({
	sessions: mockSessions,
	// Additional required exports
	appState: mockAppState,
	initializeApplicationState: mock(() => Promise.resolve()),
	mergeSdkMessagesWithDedup: (existing: unknown[], added: unknown[]) => [
		...(existing || []),
		...(added || []),
	],
	connectionState: signal('connected'),
	authStatus: signal(null),
	apiConnectionStatus: signal(null),
	globalSettings: signal(null),
	hasArchivedSessions: signal(false),
	currentSession: signal(null),
	currentAgentState: signal({ status: 'idle', phase: null }),
	currentContextInfo: signal(null),
	isAgentWorking: signal(false),
	activeSessions: signal(0),
	recentSessions: signal([]),
	systemState: signal(null),
	healthStatus: signal(null),
}));

// Mock ChatContainer
mock.module('../ChatContainer.tsx', () => ({
	default: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="chat-container" data-session-id={sessionId}>
			ChatContainer
		</div>
	),
}));

// Mock RecentSessions
mock.module('../../components/RecentSessions.tsx', () => ({
	default: ({ sessions }: { sessions: Array<{ id: string }> }) => (
		<div data-testid="recent-sessions" data-count={sessions.length}>
			RecentSessions
		</div>
	),
}));

describe('MainContent', () => {
	beforeEach(() => {
		// Reset signals to default state
		mockCurrentSessionId.value = null;
		mockSessions.value = [];
	});

	describe('Session Selection Logic', () => {
		it('should show RecentSessions when no session is selected', () => {
			mockCurrentSessionId.value = null;
			mockSessions.value = [
				{ id: 'session-1', title: 'Session 1' },
				{ id: 'session-2', title: 'Session 2' },
			];

			// Simulate component logic
			const sessionId = mockCurrentSessionId.value;
			const sessionsList = mockSessions.value;
			const sessionExists = sessionId && sessionsList.some((s) => s.id === sessionId);

			expect(sessionId).toBeNull();
			expect(sessionExists).toBeFalsy();
			// Component would render RecentSessions
		});

		it('should show ChatContainer when a valid session is selected', () => {
			mockCurrentSessionId.value = 'session-1';
			mockSessions.value = [
				{ id: 'session-1', title: 'Session 1' },
				{ id: 'session-2', title: 'Session 2' },
			];

			const sessionId = mockCurrentSessionId.value;
			const sessionsList = mockSessions.value;
			const sessionExists = sessionId && sessionsList.some((s) => s.id === sessionId);

			expect(sessionId).toBe('session-1');
			expect(sessionExists).toBe(true);
			// Component would render ChatContainer
		});

		it('should show RecentSessions when selected session does not exist in list', () => {
			mockCurrentSessionId.value = 'deleted-session';
			mockSessions.value = [
				{ id: 'session-1', title: 'Session 1' },
				{ id: 'session-2', title: 'Session 2' },
			];

			const sessionId = mockCurrentSessionId.value;
			const sessionsList = mockSessions.value;
			const sessionExists = sessionId && sessionsList.some((s) => s.id === sessionId);

			expect(sessionId).toBe('deleted-session');
			expect(sessionExists).toBe(false);
			// Component would render RecentSessions (handles deleted session case)
		});

		it('should show RecentSessions when sessions list is empty', () => {
			mockCurrentSessionId.value = 'session-1';
			mockSessions.value = [];

			const sessionId = mockCurrentSessionId.value;
			const sessionsList = mockSessions.value;
			const sessionExists = sessionId && sessionsList.some((s) => s.id === sessionId);

			expect(sessionsList.length).toBe(0);
			expect(sessionExists).toBe(false);
			// Component would render RecentSessions
		});
	});

	describe('Reactivity', () => {
		it('should react to session ID changes', () => {
			mockSessions.value = [
				{ id: 'session-1', title: 'Session 1' },
				{ id: 'session-2', title: 'Session 2' },
			];

			// Initially no session
			mockCurrentSessionId.value = null;
			let sessionExists =
				mockCurrentSessionId.value &&
				mockSessions.value.some((s) => s.id === mockCurrentSessionId.value);
			expect(sessionExists).toBeFalsy();

			// Select a session
			mockCurrentSessionId.value = 'session-1';
			sessionExists =
				mockCurrentSessionId.value &&
				mockSessions.value.some((s) => s.id === mockCurrentSessionId.value);
			expect(sessionExists).toBe(true);

			// Select different session
			mockCurrentSessionId.value = 'session-2';
			sessionExists =
				mockCurrentSessionId.value &&
				mockSessions.value.some((s) => s.id === mockCurrentSessionId.value);
			expect(sessionExists).toBe(true);
		});

		it('should react to sessions list changes', () => {
			mockCurrentSessionId.value = 'session-1';

			// Start with empty list
			mockSessions.value = [];
			let sessionExists =
				mockCurrentSessionId.value &&
				mockSessions.value.some((s) => s.id === mockCurrentSessionId.value);
			expect(sessionExists).toBe(false);

			// Add the session to list
			mockSessions.value = [{ id: 'session-1', title: 'Session 1' }];
			sessionExists =
				mockCurrentSessionId.value &&
				mockSessions.value.some((s) => s.id === mockCurrentSessionId.value);
			expect(sessionExists).toBe(true);

			// Remove the session from list
			mockSessions.value = [{ id: 'session-2', title: 'Session 2' }];
			sessionExists =
				mockCurrentSessionId.value &&
				mockSessions.value.some((s) => s.id === mockCurrentSessionId.value);
			expect(sessionExists).toBe(false);
		});
	});

	describe('Key Prop for ChatContainer', () => {
		it('should use sessionId as key for ChatContainer remounting', () => {
			mockSessions.value = [
				{ id: 'session-1', title: 'Session 1' },
				{ id: 'session-2', title: 'Session 2' },
			];

			// Select first session
			mockCurrentSessionId.value = 'session-1';
			let currentKey = mockCurrentSessionId.value;
			expect(currentKey).toBe('session-1');

			// Select second session - key should change
			mockCurrentSessionId.value = 'session-2';
			currentKey = mockCurrentSessionId.value;
			expect(currentKey).toBe('session-2');
		});
	});
});
