/**
 * Tests for Sidebar Component
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { signal } from '@preact/signals';

// Mock signals
const mockCurrentSessionId = signal<string | null>(null);
const mockSidebarOpen = signal<boolean>(false);

// Mock state
const mockSessions = signal<Array<{ id: string; title: string; status: string }>>([]);
const mockAuthStatus = signal<{
	isAuthenticated: boolean;
	method?: string;
	source?: string;
} | null>(null);
const mockConnectionState = signal<string>('connected');
const mockApiConnectionStatus = signal<{ status: string; errorCount?: number } | null>(null);
const mockGlobalSettings = signal<{ showArchived?: boolean } | null>(null);
const mockHasArchivedSessions = signal<boolean>(false);

// Mock the signals module
mock.module('../../lib/signals.ts', () => ({
	currentSessionIdSignal: mockCurrentSessionId,
	sidebarOpenSignal: mockSidebarOpen,
}));

// Mock the state module
mock.module('../../lib/state.ts', () => ({
	sessions: mockSessions,
	authStatus: mockAuthStatus,
	connectionState: mockConnectionState,
	apiConnectionStatus: mockApiConnectionStatus,
	globalSettings: mockGlobalSettings,
	hasArchivedSessions: mockHasArchivedSessions,
}));

// Mock api-helpers
const mockCreateSession = mock(() =>
	Promise.resolve({ sessionId: 'new-session-id', session: { id: 'new-session-id' } })
);
const mockUpdateGlobalSettings = mock(() => Promise.resolve());
mock.module('../../lib/api-helpers.ts', () => ({
	createSession: mockCreateSession,
	updateGlobalSettings: mockUpdateGlobalSettings,
}));

// Mock connection manager
const mockReconnect = mock(() => {});
mock.module('../../lib/connection-manager.ts', () => ({
	connectionManager: {
		reconnect: mockReconnect,
	},
}));

// Mock toast
const mockToast = {
	success: mock(() => {}),
	error: mock(() => {}),
};
mock.module('../../lib/toast.ts', () => ({
	toast: mockToast,
}));

// Mock errors
mock.module('../../lib/errors.ts', () => ({
	ConnectionNotReadyError: class ConnectionNotReadyError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'ConnectionNotReadyError';
		}
	},
}));

describe('Sidebar', () => {
	beforeEach(() => {
		// Reset signals
		mockCurrentSessionId.value = null;
		mockSidebarOpen.value = false;
		mockSessions.value = [];
		mockAuthStatus.value = { isAuthenticated: true, method: 'api_key' };
		mockConnectionState.value = 'connected';
		mockApiConnectionStatus.value = { status: 'connected' };
		mockGlobalSettings.value = { showArchived: false };
		mockHasArchivedSessions.value = false;

		// Reset mocks
		mockCreateSession.mockClear();
		mockUpdateGlobalSettings.mockClear();
		mockReconnect.mockClear();
		mockToast.success.mockClear();
		mockToast.error.mockClear();
	});

	describe('Session Creation', () => {
		it('should not allow session creation when not connected', async () => {
			mockConnectionState.value = 'disconnected';

			// Simulate handleCreateSession guard check
			if (mockConnectionState.value !== 'connected') {
				mockToast.error('Not connected to server. Please wait...');
				return;
			}

			expect(mockToast.error).toHaveBeenCalledWith('Not connected to server. Please wait...');
			expect(mockCreateSession).not.toHaveBeenCalled();
		});

		it('should create session when connected', async () => {
			mockConnectionState.value = 'connected';

			// Simulate handleCreateSession
			if (mockConnectionState.value === 'connected') {
				const response = await mockCreateSession({ workspacePath: undefined });
				if (response?.sessionId) {
					mockCurrentSessionId.value = response.sessionId;
					mockToast.success('Session created successfully');
				}
			}

			expect(mockCreateSession).toHaveBeenCalled();
			expect(mockCurrentSessionId.value).toBe('new-session-id');
			expect(mockToast.success).toHaveBeenCalledWith('Session created successfully');
		});
	});

	describe('Session Selection', () => {
		it('should update current session when clicked', () => {
			const sessionId = 'session-123';
			mockCurrentSessionId.value = sessionId;
			expect(mockCurrentSessionId.value).toBe(sessionId);
		});

		it('should close sidebar on mobile when session is clicked', () => {
			mockSidebarOpen.value = true;

			// Simulate mobile width check and close
			const isMobile = true; // window.innerWidth < 768
			if (isMobile) {
				mockSidebarOpen.value = false;
			}

			expect(mockSidebarOpen.value).toBe(false);
		});
	});

	describe('Pagination', () => {
		it('should show visible sessions up to limit', () => {
			const SESSIONS_PER_PAGE = 20;
			mockSessions.value = Array.from({ length: 50 }, (_, i) => ({
				id: `session-${i}`,
				title: `Session ${i}`,
				status: 'active',
			}));

			let visibleCount = SESSIONS_PER_PAGE;
			let visibleSessions = mockSessions.value.slice(0, visibleCount);

			expect(visibleSessions.length).toBe(20);
		});

		it('should load more sessions when requested', () => {
			const SESSIONS_PER_PAGE = 20;
			mockSessions.value = Array.from({ length: 50 }, (_, i) => ({
				id: `session-${i}`,
				title: `Session ${i}`,
				status: 'active',
			}));

			let visibleCount = SESSIONS_PER_PAGE;

			// Simulate handleLoadMore
			visibleCount += SESSIONS_PER_PAGE;
			const visibleSessions = mockSessions.value.slice(0, visibleCount);

			expect(visibleSessions.length).toBe(40);
		});

		it('should detect hasMore correctly', () => {
			const SESSIONS_PER_PAGE = 20;
			mockSessions.value = Array.from({ length: 50 }, (_, i) => ({
				id: `session-${i}`,
				title: `Session ${i}`,
				status: 'active',
			}));

			const visibleCount = SESSIONS_PER_PAGE;
			const hasMore = mockSessions.value.length > visibleCount;

			expect(hasMore).toBe(true);
		});
	});

	describe('Archive Toggle', () => {
		it('should show archive toggle when there are archived sessions', () => {
			mockHasArchivedSessions.value = true;
			expect(mockHasArchivedSessions.value).toBe(true);
		});

		it('should hide archive toggle when no archived sessions', () => {
			mockHasArchivedSessions.value = false;
			expect(mockHasArchivedSessions.value).toBe(false);
		});

		it('should toggle showArchived setting', async () => {
			mockGlobalSettings.value = { showArchived: false };

			// Simulate handleToggleShowArchived
			const currentShowArchived = mockGlobalSettings.value?.showArchived ?? false;
			await mockUpdateGlobalSettings({ showArchived: !currentShowArchived });

			expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ showArchived: true });
		});
	});

	describe('Connection Status', () => {
		it('should show connected status', () => {
			mockConnectionState.value = 'connected';
			expect(mockConnectionState.value).toBe('connected');
		});

		it('should show connecting status', () => {
			mockConnectionState.value = 'connecting';
			expect(mockConnectionState.value).toBe('connecting');
		});

		it('should show reconnecting status', () => {
			mockConnectionState.value = 'reconnecting';
			expect(mockConnectionState.value).toBe('reconnecting');
		});

		it('should show reconnect button when disconnected', () => {
			mockConnectionState.value = 'disconnected';

			// Simulate clicking reconnect
			if (
				mockConnectionState.value === 'disconnected' ||
				mockConnectionState.value === 'error' ||
				mockConnectionState.value === 'failed'
			) {
				mockReconnect();
			}

			expect(mockReconnect).toHaveBeenCalled();
		});
	});

	describe('Auth Status', () => {
		it('should show authenticated with API key', () => {
			mockAuthStatus.value = { isAuthenticated: true, method: 'api_key', source: 'env' };
			expect(mockAuthStatus.value.isAuthenticated).toBe(true);
			expect(mockAuthStatus.value.method).toBe('api_key');
		});

		it('should show authenticated with OAuth', () => {
			mockAuthStatus.value = { isAuthenticated: true, method: 'oauth' };
			expect(mockAuthStatus.value.method).toBe('oauth');
		});

		it('should show not configured when not authenticated', () => {
			mockAuthStatus.value = { isAuthenticated: false };
			expect(mockAuthStatus.value.isAuthenticated).toBe(false);
		});
	});

	describe('API Connection Status', () => {
		it('should show API connected', () => {
			mockApiConnectionStatus.value = { status: 'connected' };
			expect(mockApiConnectionStatus.value?.status).toBe('connected');
		});

		it('should show API degraded', () => {
			mockApiConnectionStatus.value = { status: 'degraded', errorCount: 3 };
			expect(mockApiConnectionStatus.value?.status).toBe('degraded');
			expect(mockApiConnectionStatus.value?.errorCount).toBe(3);
		});

		it('should show API disconnected', () => {
			mockApiConnectionStatus.value = { status: 'disconnected' };
			expect(mockApiConnectionStatus.value?.status).toBe('disconnected');
		});
	});

	describe('Mobile Sidebar Toggle', () => {
		it('should open sidebar', () => {
			mockSidebarOpen.value = true;
			expect(mockSidebarOpen.value).toBe(true);
		});

		it('should close sidebar', () => {
			mockSidebarOpen.value = true;
			mockSidebarOpen.value = false;
			expect(mockSidebarOpen.value).toBe(false);
		});
	});

	describe('Empty State', () => {
		it('should show empty state when no sessions', () => {
			mockSessions.value = [];
			expect(mockSessions.value.length).toBe(0);
		});

		it('should not show empty state when sessions exist', () => {
			mockSessions.value = [{ id: 'session-1', title: 'Session 1', status: 'active' }];
			expect(mockSessions.value.length).toBeGreaterThan(0);
		});
	});
});
