/**
 * Event-based wait helpers to replace arbitrary timeouts
 *
 * These helpers wait for specific conditions or events instead of fixed timeouts,
 * making tests more reliable and faster.
 *
 * NOTE: Window augmentation for test types is in packages/e2e/global.d.ts
 * The global Window interface is extended there with test-specific properties.
 */

import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Wait for WebSocket connection to be established
 */
export async function waitForWebSocketConnected(page: Page): Promise<void> {
	await page.waitForFunction(
		() => {
			const hub = window.__messageHub || window.appState?.messageHub;
			return hub?.getState && hub.getState() === 'connected';
		},
		{ timeout: 10000 }
	);

	// Also wait for visual indicator in the sidebar footer
	// The sidebar shows "Daemon: Connected" when WebSocket is connected
	// Use .first() since there may be multiple "Connected" indicators (Daemon and Claude API)
	await page.locator('text=Connected').first().waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Wait for session to be created and loaded
 */
export async function waitForSessionCreated(page: Page): Promise<string> {
	// Wait for session to be created and loaded
	await page.waitForTimeout(1500);

	// Verify we're NOT on the welcome screen
	await page.waitForFunction(
		() => !document.querySelector('h2')?.textContent?.includes('Welcome to NeoKai'),
		{ timeout: 10000 }
	);

	// Verify we're in a chat view (message input should be visible)
	const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
	await expect(messageInput).toBeVisible({ timeout: 10000 });
	await expect(messageInput).toBeEnabled({ timeout: 5000 });

	// Get and return the session ID - try multiple methods for robustness
	const sessionId = await page.evaluate(() => {
		// 1. From URL path (format: /{sessionId} or /session/{id})
		const pathParts = window.location.pathname.split('/').filter(Boolean);
		const pathId = pathParts[0] === 'session' ? pathParts[1] : pathParts[0];
		if (pathId && pathId !== 'undefined' && pathId !== 'null') return pathId;

		// 2. From currentSessionIdSignal (if exposed)
		const currentSessionId = window.currentSessionIdSignal?.value;
		if (currentSessionId) return currentSessionId;

		// 3. From sessionStore (if exposed)
		const sessionStoreId = window.sessionStore?.activeSessionId?.value;
		if (sessionStoreId) return sessionStoreId;

		// 4. From localStorage
		const localStorageId = localStorage.getItem('currentSessionId');
		if (localStorageId) return localStorageId;

		// 5. From latest session in globalStore sessions list
		const sessions = window.globalStore?.sessions?.value || [];
		const latestSession = sessions[sessions.length - 1] as { id?: string } | undefined;
		if (latestSession?.id) return latestSession.id;

		return null;
	});

	if (!sessionId) {
		throw new Error('Session ID not found after creation');
	}

	return sessionId;
}

/**
 * Wait for user message to be sent
 */
export async function waitForMessageSent(page: Page, messageText: string): Promise<void> {
	// Wait for user message to appear in the UI
	// Use getByText which handles special characters better than text= selector
	await page.getByText(messageText, { exact: false }).first().waitFor({
		state: 'visible',
		timeout: 10000,
	});
}

/**
 * Wait for new assistant response to appear
 * Uses simpler approach matching the passing chat-flow.e2e.ts pattern
 * @param options.containsText - Optional text that should be in the response
 * @param options.timeout - Custom timeout (default 90s for CI reliability)
 */
export async function waitForAssistantResponse(
	page: Page,
	options: { containsText?: string; timeout?: number } = {}
): Promise<void> {
	// Use longer timeout for CI reliability (90s default)
	// CI environments can be significantly slower due to xvfb, network latency,
	// and Claude API response times that can exceed 50s
	const timeout = options.timeout || 90000;

	// Count existing assistant messages before waiting
	const initialCount = await page.locator('[data-message-role="assistant"]').count();

	// Wait for a new assistant message to appear
	// Use waitForFunction for more reliable detection of new messages
	await page.waitForFunction(
		(expectedCount) => {
			const messages = document.querySelectorAll('[data-message-role="assistant"]');
			return messages.length > expectedCount;
		},
		initialCount,
		{ timeout }
	);

	// If text matching is requested, verify it
	if (options.containsText) {
		const lastAssistant = page.locator('[data-message-role="assistant"]').last();
		await expect(lastAssistant).toContainText(options.containsText, {
			timeout: 10000,
		});
	}

	// Wait for input to be enabled again (processing complete)
	const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
	await expect(messageInput).toBeEnabled({ timeout: 20000 });
}

/**
 * Wait for message to be sent and get a response
 * Convenience wrapper around waitForMessageSent + waitForAssistantResponse
 */
export async function waitForMessageProcessed(page: Page, messageText: string): Promise<void> {
	await waitForMessageSent(page, messageText);
	await waitForAssistantResponse(page);
}

/**
 * Wait for SDK system:init message to be received
 * This indicates the SDK has accepted the message and started processing
 *
 * Uses UI element: the "Session info" button (circle with "i" icon) that appears
 * next to the user message when system:init is received.
 *
 * Use this instead of arbitrary timeouts to ensure proper synchronization
 */
export async function waitForSDKSystemInitMessage(
	page: Page,
	timeout: number = 10000
): Promise<void> {
	// Wait for the "Session info" button to appear - this indicates system:init was received
	// The button appears next to the user message when sessionInfo is attached
	// Use locator.waitFor() for better retry logic with async signal-based rendering
	// Use .last() to wait for the most recent button (handles multiple messages)
	await page.locator('button[title="Session info"]').last().waitFor({ state: 'visible', timeout });
}

/**
 * Wait for specific event to be published
 */
export async function waitForEvent(
	page: Page,
	eventName: string,
	sessionId: string = 'global'
): Promise<unknown> {
	return page.evaluate(
		async ({ event, sid }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub) {
				throw new Error('MessageHub not found');
			}

			return new Promise((resolve) => {
				const timeout = setTimeout(() => {
					resolve({ timeout: true });
				}, 10000);

				(async () => {
					const unsubscribe = await hub.subscribe(
						event,
						async (data: unknown) => {
							clearTimeout(timeout);
							await unsubscribe();
							resolve(data);
						},
						{ sessionId: sid }
					);
				})();
			});
		},
		{ event: eventName, sid: sessionId }
	);
}

/**
 * Wait for UI element with retry logic
 */
export async function waitForElement(
	page: Page,
	selector: string,
	options: {
		state?: 'attached' | 'detached' | 'visible' | 'hidden';
		timeout?: number;
	} = {}
): Promise<Locator> {
	const element = page.locator(selector).first();
	await element.waitFor({
		state: options.state || 'visible',
		timeout: options.timeout || 10000,
	});
	return element;
}

/**
 * Wait for slash commands to be loaded
 * NOTE: Uses sessionStore.sessionState.value?.commandsData for current session
 */
export async function waitForSlashCommands(page: Page, sessionId: string): Promise<void> {
	await page.waitForFunction(
		(sid) => {
			const sessionStoreState = window.sessionStore?.sessionState?.value;
			if (!sessionStoreState || window.sessionStore?.activeSessionId?.value !== sid) {
				return false;
			}
			const commands = sessionStoreState.commandsData?.availableCommands;
			return commands && commands.length > 0;
		},
		sessionId,
		{ timeout: 10000 }
	);
}

/**
 * Helper to setup MessageHub exposure for testing
 * Uses simpler approach matching the passing chat-flow.e2e.ts pattern
 */
export async function setupMessageHubTesting(page: Page): Promise<void> {
	// Navigate to home page
	await page.goto('/');

	// Wait for app to initialize - check for sidebar heading
	await expect(page.getByRole('heading', { name: 'NeoKai', exact: true }).first()).toBeVisible({
		timeout: 10000,
	});

	// Wait for WebSocket connection - simple timeout like chat-flow.e2e.ts
	await page.waitForTimeout(1000);

	// Optionally inject MessageHub tracking (for tests that need it)
	await page.evaluate(() => {
		window.__sdkMessages = [];
		const hub = window.appState?.messageHub;
		if (hub) {
			window.__messageHub = hub;
		}
	});
}

/**
 * Helper to clean up after tests
 * IMPORTANT: E2E tests must test the actual UI, not bypass it
 *
 * For parallel execution, this helper uses RPC as primary method for reliability.
 * ALWAYS uses RPC cleanup - UI cleanup is completely removed for better reliability.
 */
export async function cleanupTestSession(page: Page, sessionId: string): Promise<void> {
	if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
		return; // Nothing to clean up
	}

	try {
		// Use MessageHub RPC for reliable cleanup (works even if page is in bad state)
		// Generous timeout: manual deletion takes ~3ms, but may take longer during agent processing
		const result = await page.evaluate(async (sid) => {
			try {
				const hub = window.__messageHub || window.appState?.messageHub;
				if (!hub || !hub.call) {
					return { success: false, error: 'MessageHub not available' };
				}

				// 10s timeout - if it takes longer, something is likely stuck/deadlocked
				await hub.call('session.delete', { sessionId: sid }, { timeout: 10000 });
				return { success: true, error: undefined };
			} catch (error: unknown) {
				return {
					success: false,
					error: (error as Error)?.message || String(error),
				};
			}
		}, sessionId);

		if (result.success) {
			// Successfully deleted via RPC
			// Navigate home if we're still on the deleted session
			try {
				await page.waitForTimeout(500);
				if (page.url().includes(sessionId)) {
					await page.goto('/').catch(() => {}); // Ignore navigation errors
					await page.waitForTimeout(300);
				}
			} catch {
				// Ignore navigation errors
			}
		} else {
			// RPC deletion failed after retries, log warning but don't throw
			console.warn(`⚠️  Failed to cleanup session ${sessionId}: ${result.error}`);
		}
	} catch (error) {
		// page.evaluate itself failed (page might be closed/crashed)
		console.warn(`⚠️  Cleanup error for session ${sessionId}:`, (error as Error).message || error);
	}

	// Never throw errors from cleanup - just log warnings
}

/**
 * Wait for model to be switched
 * NOTE: Uses globalStore.sessions to find session and check config.model
 */
export async function waitForModelSwitch(
	page: Page,
	sessionId: string,
	modelId: string
): Promise<void> {
	await page.waitForFunction(
		({ sid, expected }) => {
			const session = window.globalStore?.sessions?.value?.find(
				(s: { id: string }) => s.id === sid
			);
			return session?.config?.model === expected;
		},
		{ sid: sessionId, expected: modelId },
		{ timeout: 10000 }
	);
}
