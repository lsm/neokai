// @ts-nocheck
/**
 * Unit tests for ConnectionManager page visibility handling
 *
 * Tests the Safari background tab reconnection behavior:
 * - Page visibility change detection
 * - Force resubscription on foreground return
 * - State refresh after validation
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { ConnectionManager } from '../connection-manager';
import { globalStore } from '../global-store';
import { sessionStore } from '../session-store';
import { appState } from '../state';

describe('ConnectionManager - Page Visibility Handling', () => {
	let connectionManager: ConnectionManager;
	let visibilityChangeHandler: ((event: Event) => void) | null = null;
	let pageHideHandler: ((event: Event) => void) | null = null;
	let originalAddEventListener: typeof document.addEventListener;
	let originalRemoveEventListener: typeof document.removeEventListener;

	beforeEach(() => {
		// Capture event listeners for visibilitychange and pagehide
		originalAddEventListener = document.addEventListener;
		originalRemoveEventListener = document.removeEventListener;

		document.addEventListener = mock((type: string, listener: EventListener) => {
			if (type === 'visibilitychange') {
				visibilityChangeHandler = listener as (event: Event) => void;
			} else if (type === 'pagehide') {
				pageHideHandler = listener as (event: Event) => void;
			}
			return originalAddEventListener.call(document, type, listener);
		}) as typeof document.addEventListener;

		document.removeEventListener = mock((type: string, listener: EventListener) => {
			if (type === 'visibilitychange' && listener === visibilityChangeHandler) {
				visibilityChangeHandler = null;
			} else if (type === 'pagehide' && listener === pageHideHandler) {
				pageHideHandler = null;
			}
			return originalRemoveEventListener.call(document, type, listener);
		}) as typeof document.removeEventListener;

		connectionManager = new ConnectionManager();
	});

	afterEach(() => {
		document.addEventListener = originalAddEventListener;
		document.removeEventListener = originalRemoveEventListener;
		visibilityChangeHandler = null;
		pageHideHandler = null;
	});

	describe('Visibility Handler Registration', () => {
		it('should register visibilitychange handler on construction', () => {
			expect(visibilityChangeHandler).not.toBeNull();
		});

		it('should register pagehide handler on construction', () => {
			expect(pageHideHandler).not.toBeNull();
		});

		it('should remove handlers on disconnect', async () => {
			await connectionManager.disconnect();
			expect(document.removeEventListener).toHaveBeenCalledWith(
				'visibilitychange',
				expect.any(Function)
			);
			expect(document.removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
		});
	});

	describe('Page Hidden Event', () => {
		it('should log when page becomes hidden', () => {
			const consoleSpy = spyOn(console, 'log');

			// Simulate page becoming hidden
			Object.defineProperty(document, 'hidden', {
				value: true,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Page hidden'));
		});
	});

	describe('Page Visible Event - Reconnection Flow', () => {
		let mockTransport: Record<string, unknown>;
		let mockMessageHub: Record<string, unknown>;

		beforeEach(() => {
			// Create mock transport with resetReconnectState
			mockTransport = {
				isReady: mock(() => true),
				resetReconnectState: mock(() => {}),
				forceReconnect: mock(() => {}),
				close: mock(() => {}),
			};

			// Create mock MessageHub
			mockMessageHub = {
				call: mock(() => Promise.resolve({ status: 'ok' })),
				forceResubscribe: mock(() => {}),
				isConnected: mock(() => true),
			};

			// Inject mocks into connection manager
			(connectionManager as unknown as Record<string, unknown>).transport = mockTransport;
			(connectionManager as unknown as Record<string, unknown>).messageHub = mockMessageHub;
		});

		afterEach(() => {
			// Restore all mocks to prevent test pollution
			const sessionStoreRefresh = sessionStore.refresh as unknown;
			if (
				typeof sessionStoreRefresh === 'object' &&
				sessionStoreRefresh !== null &&
				'mockRestore' in sessionStoreRefresh &&
				typeof (sessionStoreRefresh as { mockRestore: unknown }).mockRestore === 'function'
			) {
				(sessionStoreRefresh as { mockRestore: () => void }).mockRestore();
			}
			const appStateRefresh = appState.refreshAll as unknown;
			if (
				typeof appStateRefresh === 'object' &&
				appStateRefresh !== null &&
				'mockRestore' in appStateRefresh &&
				typeof (appStateRefresh as { mockRestore: unknown }).mockRestore === 'function'
			) {
				(appStateRefresh as { mockRestore: () => void }).mockRestore();
			}
			const globalStoreRefresh = globalStore.refresh as unknown;
			if (
				typeof globalStoreRefresh === 'object' &&
				globalStoreRefresh !== null &&
				'mockRestore' in globalStoreRefresh &&
				typeof (globalStoreRefresh as { mockRestore: unknown }).mockRestore === 'function'
			) {
				(globalStoreRefresh as { mockRestore: () => void }).mockRestore();
			}
		});

		it('should reset reconnect state when page becomes visible', () => {
			// Simulate page becoming visible
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			expect(mockTransport.resetReconnectState).toHaveBeenCalled();
		});

		it('should trigger validateConnectionOnResume when page becomes visible', async () => {
			const validateSpy = spyOn(
				connectionManager as unknown as Record<string, unknown>,
				'validateConnectionOnResume'
			);

			// Simulate page becoming visible
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			// Wait for async call
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(validateSpy).toHaveBeenCalled();
		});

		it('should call forceResubscribe when health check succeeds', async () => {
			const _appStateRefreshSpy = spyOn(appState, 'refreshAll').mockResolvedValue(undefined);
			const _globalStoreRefreshSpy = spyOn(globalStore, 'refresh').mockResolvedValue(undefined);

			// Simulate page becoming visible
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			// Wait for async validation
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(mockMessageHub.forceResubscribe).toHaveBeenCalled();
		});

		it('should refresh sessionStore, appState, and globalStore', async () => {
			const sessionStoreRefreshSpy = spyOn(sessionStore, 'refresh').mockResolvedValue(undefined);
			const appStateRefreshSpy = spyOn(appState, 'refreshAll').mockResolvedValue(undefined);
			const globalStoreRefreshSpy = spyOn(globalStore, 'refresh').mockResolvedValue(undefined);

			// Simulate page becoming visible
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			// Wait for async validation
			await new Promise((resolve) => setTimeout(resolve, 100));

			// FIX: sessionStore.refresh() is now called to sync agent state for status bar
			expect(sessionStoreRefreshSpy).toHaveBeenCalled();
			expect(appStateRefreshSpy).toHaveBeenCalled();
			expect(globalStoreRefreshSpy).toHaveBeenCalled();
		});

		it('should call refreshes in parallel (Promise.all)', async () => {
			const refreshStartTimes: number[] = [];

			const _sessionStoreRefreshSpy = spyOn(sessionStore, 'refresh').mockImplementation(
				async () => {
					refreshStartTimes.push(Date.now());
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			);

			const _appStateRefreshSpy = spyOn(appState, 'refreshAll').mockImplementation(async () => {
				refreshStartTimes.push(Date.now());
				await new Promise((resolve) => setTimeout(resolve, 50));
			});

			const _globalStoreRefreshSpy = spyOn(globalStore, 'refresh').mockImplementation(async () => {
				refreshStartTimes.push(Date.now());
				await new Promise((resolve) => setTimeout(resolve, 50));
			});

			// Simulate page becoming visible
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			// Wait for completion
			await new Promise((resolve) => setTimeout(resolve, 200));

			// All 3 should start within 10ms of each other (parallel execution)
			expect(refreshStartTimes.length).toBe(3);
			const maxDiff = Math.max(...refreshStartTimes) - Math.min(...refreshStartTimes);
			expect(maxDiff).toBeLessThan(10);
		});
	});

	describe('Error Handling', () => {
		let mockTransport: Record<string, unknown>;
		let mockMessageHub: Record<string, unknown>;
		let appStateRefreshSpy: ReturnType<typeof spyOn> | null = null;
		let globalStoreRefreshSpy: ReturnType<typeof spyOn> | null = null;

		beforeEach(() => {
			// Set up spies in beforeEach to track all calls in this describe block
			appStateRefreshSpy = spyOn(appState, 'refreshAll').mockResolvedValue(undefined);
			globalStoreRefreshSpy = spyOn(globalStore, 'refresh').mockResolvedValue(undefined);

			mockTransport = {
				isReady: mock(() => true),
				resetReconnectState: mock(() => {}),
				forceReconnect: mock(() => {}),
			};

			mockMessageHub = {
				call: mock(() => Promise.reject(new Error('Health check failed'))),
				forceResubscribe: mock(() => {}),
				isConnected: mock(() => true),
			};

			(connectionManager as unknown as Record<string, unknown>).transport = mockTransport;
			(connectionManager as unknown as Record<string, unknown>).messageHub = mockMessageHub;
		});

		afterEach(() => {
			// Clean up spies
			if (appStateRefreshSpy) {
				appStateRefreshSpy.mockRestore();
				appStateRefreshSpy = null;
			}
			if (globalStoreRefreshSpy) {
				globalStoreRefreshSpy.mockRestore();
				globalStoreRefreshSpy = null;
			}
		});

		it('should call forceReconnect when health check fails', async () => {
			// Simulate page becoming visible
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			// Wait for async validation to fail
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(mockTransport.forceReconnect).toHaveBeenCalled();
		});

		it('should NOT call refresh methods when health check fails', async () => {
			// Simulate page becoming visible
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			// Wait for async validation to fail
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(appStateRefreshSpy).not.toHaveBeenCalled();
			expect(globalStoreRefreshSpy).not.toHaveBeenCalled();
		});
	});

	describe('No Connection Scenario', () => {
		beforeEach(() => {
			// No transport or messageHub
			(connectionManager as unknown as Record<string, unknown>).transport = null;
			(connectionManager as unknown as Record<string, unknown>).messageHub = null;
		});

		it('should attempt reconnect when no connection exists', async () => {
			const reconnectSpy = spyOn(connectionManager, 'reconnect').mockResolvedValue(undefined);

			// Simulate page becoming visible
			Object.defineProperty(document, 'hidden', {
				value: false,
				writable: true,
				configurable: true,
			});

			visibilityChangeHandler?.(new Event('visibilitychange'));

			// Wait for async call
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(reconnectSpy).toHaveBeenCalled();
		});
	});
});
