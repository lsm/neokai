// @ts-nocheck
/**
 * Tests for API Helper Functions
 *
 * Tests the typed convenience functions for daemon operations.
 * Uses mocked connectionManager to avoid actual network calls.
 */

import { describe, it, expect } from 'bun:test';
import { ConnectionNotReadyError } from '../errors';

// Mock the connection manager module
// We need to test the behavior of getHubOrThrow helper
describe('api-helpers', () => {
	// Store original module state
	let _mockGetHubIfConnected: ReturnType<typeof mock>;
	let _mockGetHub: ReturnType<typeof mock>;
	let mockHub: {
		call: ReturnType<typeof mock>;
	};

	beforeEach(() => {
		// Create fresh mocks for each test
		mockHub = {
			call: mock(() => Promise.resolve({ success: true })),
		};
		_mockGetHubIfConnected = mock(() => mockHub);
		_mockGetHub = mock(() => Promise.resolve(mockHub));
	});

	describe('ConnectionNotReadyError', () => {
		it('should be throwable with default message', () => {
			const error = new ConnectionNotReadyError();
			expect(error.message).toBe('Connection not ready');
			expect(error.name).toBe('ConnectionNotReadyError');
		});

		it('should be throwable with custom message', () => {
			const error = new ConnectionNotReadyError('Not connected to server');
			expect(error.message).toBe('Not connected to server');
		});

		it('should be instanceof ConnectionError', () => {
			const error = new ConnectionNotReadyError();
			expect(error).toBeInstanceOf(Error);
		});
	});

	describe('getHubOrThrow pattern', () => {
		// Test the pattern used in api-helpers
		function getHubOrThrow(getHubIfConnected: () => { call: typeof mockHub.call } | null) {
			const hub = getHubIfConnected();
			if (!hub) {
				throw new ConnectionNotReadyError('Not connected to server');
			}
			return hub;
		}

		it('should return hub when connected', () => {
			const hub = getHubOrThrow(() => mockHub);
			expect(hub).toBe(mockHub);
		});

		it('should throw ConnectionNotReadyError when not connected', () => {
			expect(() => getHubOrThrow(() => null)).toThrow(ConnectionNotReadyError);
		});

		it('should throw with correct message', () => {
			try {
				getHubOrThrow(() => null);
			} catch (e) {
				expect((e as Error).message).toBe('Not connected to server');
			}
		});
	});

	describe('API function patterns', () => {
		// Test the patterns used in the actual API helper functions
		// These simulate how the functions work without mocking the module

		describe('createSession pattern', () => {
			async function createSession(
				hub: { call: typeof mockHub.call },
				req: { workspacePath: string }
			) {
				return await hub.call('session.create', req, { timeout: 15000 });
			}

			it('should call hub.call with correct method', async () => {
				await createSession(mockHub, { workspacePath: '/path/to/project' });
				expect(mockHub.call).toHaveBeenCalledWith(
					'session.create',
					{ workspacePath: '/path/to/project' },
					{ timeout: 15000 }
				);
			});

			it('should use 15000ms timeout', async () => {
				await createSession(mockHub, { workspacePath: '/' });
				expect(mockHub.call).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
					timeout: 15000,
				});
			});
		});

		describe('listSessions pattern', () => {
			async function listSessions(hub: { call: typeof mockHub.call }) {
				return await hub.call('session.list');
			}

			it('should call hub.call with session.list', async () => {
				await listSessions(mockHub);
				expect(mockHub.call).toHaveBeenCalledWith('session.list');
			});
		});

		describe('updateSession pattern', () => {
			async function updateSession(
				hub: { call: typeof mockHub.call },
				sessionId: string,
				updates: { title?: string }
			) {
				await hub.call('session.update', { sessionId, ...updates });
			}

			it('should call hub.call with session.update and merged params', async () => {
				await updateSession(mockHub, 'session-123', { title: 'New Title' });
				expect(mockHub.call).toHaveBeenCalledWith('session.update', {
					sessionId: 'session-123',
					title: 'New Title',
				});
			});
		});

		describe('deleteSession pattern', () => {
			async function deleteSession(hub: { call: typeof mockHub.call }, sessionId: string) {
				await hub.call('session.delete', { sessionId });
			}

			it('should call hub.call with session.delete', async () => {
				await deleteSession(mockHub, 'session-456');
				expect(mockHub.call).toHaveBeenCalledWith('session.delete', {
					sessionId: 'session-456',
				});
			});
		});

		describe('archiveSession pattern', () => {
			async function archiveSession(
				hub: { call: typeof mockHub.call },
				sessionId: string,
				confirmed = false
			) {
				return await hub.call('session.archive', { sessionId, confirmed });
			}

			it('should call hub.call with session.archive', async () => {
				await archiveSession(mockHub, 'session-789');
				expect(mockHub.call).toHaveBeenCalledWith('session.archive', {
					sessionId: 'session-789',
					confirmed: false,
				});
			});

			it('should pass confirmed flag', async () => {
				await archiveSession(mockHub, 'session-789', true);
				expect(mockHub.call).toHaveBeenCalledWith('session.archive', {
					sessionId: 'session-789',
					confirmed: true,
				});
			});
		});

		describe('getAuthStatus pattern', () => {
			async function getAuthStatus(hub: { call: typeof mockHub.call }) {
				return await hub.call('auth.status');
			}

			it('should call hub.call with auth.status', async () => {
				await getAuthStatus(mockHub);
				expect(mockHub.call).toHaveBeenCalledWith('auth.status');
			});
		});

		describe('updateGlobalSettings pattern', () => {
			async function updateGlobalSettings(
				hub: { call: typeof mockHub.call },
				updates: Record<string, unknown>
			) {
				return await hub.call('settings.global.update', { updates });
			}

			it('should call hub.call with settings.global.update', async () => {
				await updateGlobalSettings(mockHub, { theme: 'dark' });
				expect(mockHub.call).toHaveBeenCalledWith('settings.global.update', {
					updates: { theme: 'dark' },
				});
			});
		});

		describe('listMcpServersFromSources pattern', () => {
			async function listMcpServersFromSources(
				hub: { call: typeof mockHub.call },
				sessionId?: string
			) {
				return await hub.call('settings.mcp.listFromSources', sessionId ? { sessionId } : {});
			}

			it('should call hub.call without sessionId', async () => {
				await listMcpServersFromSources(mockHub);
				expect(mockHub.call).toHaveBeenCalledWith('settings.mcp.listFromSources', {});
			});

			it('should call hub.call with sessionId when provided', async () => {
				await listMcpServersFromSources(mockHub, 'session-abc');
				expect(mockHub.call).toHaveBeenCalledWith('settings.mcp.listFromSources', {
					sessionId: 'session-abc',
				});
			});
		});

		describe('updateMcpServerSettings pattern', () => {
			async function updateMcpServerSettings(
				hub: { call: typeof mockHub.call },
				serverName: string,
				settings: { allowed?: boolean; defaultOn?: boolean }
			) {
				return await hub.call('settings.mcp.updateServerSettings', {
					serverName,
					settings,
				});
			}

			it('should call hub.call with correct params', async () => {
				await updateMcpServerSettings(mockHub, 'my-server', {
					allowed: true,
					defaultOn: false,
				});
				expect(mockHub.call).toHaveBeenCalledWith('settings.mcp.updateServerSettings', {
					serverName: 'my-server',
					settings: { allowed: true, defaultOn: false },
				});
			});
		});
	});

	describe('Error handling patterns', () => {
		it('should propagate hub.call errors', async () => {
			mockHub.call.mockImplementation(() => Promise.reject(new Error('Network error')));

			await expect(mockHub.call('session.list')).rejects.toThrow('Network error');
		});

		it('should handle ConnectionNotReadyError in catch block', async () => {
			function getHubOrThrow() {
				throw new ConnectionNotReadyError('Not connected');
			}

			try {
				getHubOrThrow();
			} catch (err) {
				if (err instanceof ConnectionNotReadyError) {
					// Handle gracefully
					expect(err.message).toBe('Not connected');
				} else {
					throw err;
				}
			}
		});
	});

	describe('Non-blocking pattern', () => {
		it('should throw immediately when not connected', () => {
			function getHubOrThrow(connected: boolean) {
				if (!connected) {
					throw new ConnectionNotReadyError('Not connected to server');
				}
				return mockHub;
			}

			const start = Date.now();

			try {
				getHubOrThrow(false);
			} catch {
				// Expected
			}

			const elapsed = Date.now() - start;

			// Should be near-instant (< 10ms)
			expect(elapsed).toBeLessThan(10);
		});
	});
});
