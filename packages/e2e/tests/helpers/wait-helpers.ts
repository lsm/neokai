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
	await page.locator('text=Connected').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Wait for session to be created and loaded
 */
export async function waitForSessionCreated(page: Page): Promise<string> {
	// Wait for navigation away from home
	await page.waitForFunction(
		() => !document.querySelector('h2')?.textContent?.includes('Welcome to Liuboer'),
		{ timeout: 10000 }
	);

	// Wait for message input to be visible and enabled
	const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
	await messageInput.waitFor({ state: 'visible', timeout: 10000 });
	// Wait for the input to be enabled (not disabled)
	await page.waitForFunction(
		() => {
			const input = document.querySelector('textarea[placeholder*="Ask"]') as HTMLTextAreaElement;
			return input && !input.disabled;
		},
		{ timeout: 5000 }
	);

	// Get and return the session ID
	const sessionId = await page.evaluate(() => {
		// Try multiple ways to get session ID
		// 1. From appState's private field (if exposed)
		const appStateSessionId = window.appState?.currentSessionIdSignal?.value;
		if (appStateSessionId) return appStateSessionId;

		// 2. From global currentSessionIdSignal (if exposed)
		const globalSignal = window.currentSessionIdSignal?.value;
		if (globalSignal) return globalSignal;

		// 3. From localStorage
		const localStorageId = localStorage.getItem('currentSessionId');
		if (localStorageId) return localStorageId;

		// 4. From URL path
		const pathId = window.location.pathname.split('/').filter(Boolean)[0];
		if (pathId && pathId !== 'undefined') return pathId;

		// 5. From latest session in sessions list
		const sessions = window.appState?.global?.value?.sessions?.$.value?.sessions || [];
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
 * Wait for session to be deleted and UI to update
 */
export async function waitForSessionDeleted(page: Page, sessionId: string): Promise<void> {
	// Wait for redirect to home
	await page.waitForFunction(
		() => document.querySelector('h2')?.textContent?.includes('Welcome to Liuboer'),
		{ timeout: 10000 }
	);

	// Wait for session to disappear from sidebar
	await page.waitForFunction(
		(sid) => {
			const sessionElements = Array.from(document.querySelectorAll('[data-session-id]'));
			for (const el of sessionElements) {
				if (el.getAttribute('data-session-id') === sid) {
					return false;
				}
			}
			return true;
		},
		sessionId,
		{ timeout: 5000 }
	);
}

/**
 * Wait for user message to be sent
 */
export async function waitForMessageSent(page: Page, messageText: string): Promise<void> {
	// Wait for user message to appear in the UI
	await page.locator(`[data-testid="user-message"]:has-text("${messageText}")`).waitFor({
		state: 'visible',
		timeout: 5000,
	});
}

/**
 * Wait for new assistant response to appear
 * @param options.containsText - Optional text that should be in the response
 * @param options.timeout - Custom timeout (default 30s)
 */
export async function waitForAssistantResponse(
	page: Page,
	options: { containsText?: string; timeout?: number } = {}
): Promise<void> {
	const timeout = options.timeout || 30000;

	// Count existing assistant messages
	const initialCount = await page.locator('[data-testid="assistant-message"]').count();

	// Wait for input to be disabled (processing started)
	await page
		.waitForFunction(
			() => {
				const input = document.querySelector('textarea[placeholder*="Ask"]') as HTMLTextAreaElement;
				return input && input.disabled;
			},
			{ timeout: 5000 }
		)
		.catch(() => {
			// Input might disable too fast to catch
		});

	// Wait for new assistant message to appear
	await page
		.waitForFunction(
			(expectedCount) => {
				const messages = document.querySelectorAll('[data-testid="assistant-message"]');
				return messages.length > expectedCount;
			},
			initialCount,
			{ timeout }
		)
		.catch(async () => {
			// Check for error state
			const hasError = await page.locator('[data-error-message]').count();
			if (hasError === 0) {
				throw new Error('No new assistant response appeared (timeout)');
			}
		});

	// If text matching is requested, verify it
	if (options.containsText) {
		const lastAssistant = page.locator('[data-testid="assistant-message"]').last();
		await expect(lastAssistant).toContainText(options.containsText, { timeout: 5000 });
	}

	// Wait for input to be enabled again (processing complete)
	await page.waitForFunction(
		() => {
			const input = document.querySelector('textarea[placeholder*="Ask"]') as HTMLTextAreaElement;
			return input && !input.disabled;
		},
		{ timeout: 5000 }
	);
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
 * Wait for state channel to be initialized and data loaded
 */
export async function waitForStateChannel(
	page: Page,
	channel: string,
	sessionId: string = 'global'
): Promise<void> {
	await page.waitForFunction(
		({ chan, sid }) => {
			const state = window.appState;
			if (!state) return false;

			if (sid === 'global') {
				// Access dynamic channel property
				const globalValue = state.global?.value as Record<string, { $?: unknown }> | undefined;
				return globalValue?.[chan]?.$ !== undefined;
			} else {
				const sessionState = state.sessions?.get(sid) as
					| Record<string, { $?: unknown }>
					| undefined;
				return sessionState?.[chan]?.$ !== undefined;
			}
		},
		{ chan: channel, sid: sessionId },
		{ timeout: 10000 }
	);
}

/**
 * Wait for sessions list to be loaded in sidebar
 */
export async function waitForSessionsList(page: Page): Promise<void> {
	await waitForStateChannel(page, 'sessions', 'global');

	// Also wait for visual confirmation
	await page.waitForFunction(
		() => {
			const sidebar = document.querySelector('[data-sidebar]') || document.querySelector('aside');
			return sidebar !== null;
		},
		{ timeout: 5000 }
	);
}

/**
 * Wait for specific SDK message type to appear
 */
export async function waitForSDKMessage(
	page: Page,
	messageType: string,
	timeout: number = 10000
): Promise<void> {
	await page.waitForFunction(
		(type) => {
			const messages = window.__sdkMessages || [];
			return messages.some((m) => m.type === type);
		},
		messageType,
		{ timeout }
	);
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
 * Wait for navigation to complete
 */
export async function waitForNavigation(page: Page, url?: string | RegExp): Promise<void> {
	if (url) {
		await page.waitForURL(url, { timeout: 10000 });
	} else {
		await page.waitForLoadState('networkidle', { timeout: 10000 });
	}
}

/**
 * Wait for multi-tab synchronization
 */
export async function waitForTabSync(pages: Page[], timeout: number = 5000): Promise<void> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeout) {
		// Check if all tabs have the same session count
		const sessionCounts = await Promise.all(
			pages.map((page) =>
				page.evaluate(() => {
					const sessions = window.appState?.global?.value?.sessions?.$.value?.sessions;
					return sessions?.length || 0;
				})
			)
		);

		// If all tabs have the same count, sync is likely complete
		if (sessionCounts.every((count) => count === sessionCounts[0])) {
			// Wait a bit more to ensure full sync
			await pages[0].waitForTimeout(500);
			return;
		}

		// Wait before checking again
		await pages[0].waitForTimeout(100);
	}

	throw new Error(`Tab sync did not complete within ${timeout}ms`);
}

/**
 * Wait for agent state change
 */
export async function waitForAgentState(
	page: Page,
	sessionId: string,
	expectedState: 'idle' | 'working' | 'interrupted'
): Promise<void> {
	await page.waitForFunction(
		({ sid, state }) => {
			const agentState = window.appState?.sessions?.get(sid)?.agent?.$.value;
			return agentState?.status === state;
		},
		{ sid: sessionId, state: expectedState },
		{ timeout: 10000 }
	);
}

/**
 * Wait for context update (after /context command)
 */
export async function waitForContextUpdate(page: Page, sessionId: string): Promise<void> {
	// Wait for context state channel update
	await page.waitForFunction(
		(sid) => {
			const context = window.appState?.sessions?.get(sid)?.context?.$.value;
			// Check if contextInfo exists (it's on ContextState)
			const contextWithInfo = context as { contextInfo?: unknown } | undefined;
			return contextWithInfo?.contextInfo !== null && contextWithInfo?.contextInfo !== undefined;
		},
		sessionId,
		{ timeout: 10000 }
	);
}

/**
 * Wait for slash commands to be loaded
 */
export async function waitForSlashCommands(page: Page, sessionId: string): Promise<void> {
	await page.waitForFunction(
		(sid) => {
			const commands = window.appState?.sessions?.get(sid)?.commands?.$.value;
			// Check if availableCommands exists (it's on CommandsState)
			const commandsWithAvailable = commands as { availableCommands?: unknown[] } | undefined;
			return (
				commandsWithAvailable?.availableCommands &&
				commandsWithAvailable.availableCommands.length > 0
			);
		},
		sessionId,
		{ timeout: 10000 }
	);
}

/**
 * Helper to setup MessageHub exposure for testing
 */
export async function setupMessageHubTesting(page: Page): Promise<void> {
	// Inject script to expose MessageHub and track SDK messages
	await page.addInitScript(() => {
		// Track SDK messages
		window.__sdkMessages = [];

		// Wait for MessageHub to be available and expose it
		const checkInterval = setInterval(async () => {
			const hub = window.appState?.messageHub;
			if (hub) {
				window.__messageHub = hub;

				// Subscribe to SDK messages for tracking
				await hub.subscribe(
					'sdk.message',
					(msg: unknown) => {
						window.__sdkMessages?.push(
							msg as Parameters<NonNullable<typeof window.__sdkMessages>['push']>[0]
						);
					},
					{ sessionId: 'global' }
				);

				clearInterval(checkInterval);
			}
		}, 100);
	});

	// Navigate and wait for setup
	await page.goto('/');
	await waitForWebSocketConnected(page);
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
				return { success: false, error: (error as Error)?.message || String(error) };
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
 * Cleanup multiple sessions at once (for test suites)
 */
export async function cleanupTestSessions(page: Page, sessionIds: string[]): Promise<void> {
	for (const sessionId of sessionIds) {
		await cleanupTestSession(page, sessionId);
	}
}

/**
 * Wait for session to be archived
 */
export async function waitForSessionArchived(page: Page, sessionId: string): Promise<void> {
	await page.waitForFunction(
		(sid) => {
			const session = window.appState?.sessions?.get(sid);
			const sessionValue = session?.session?.$.value as { isArchived?: boolean } | undefined;
			return sessionValue?.isArchived === true;
		},
		sessionId,
		{ timeout: 10000 }
	);

	// Also wait for visual confirmation (archived label)
	await page.locator('text=Session archived').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Wait for processing state change
 * @param state - Expected state: 'idle', 'queued', or 'processing'
 * @param phase - Optional phase when state is 'processing': 'initializing', 'thinking', 'streaming', 'finalizing'
 */
export async function waitForProcessingState(
	page: Page,
	sessionId: string,
	state: 'idle' | 'queued' | 'processing',
	phase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing'
): Promise<void> {
	await page.waitForFunction(
		({ sid, expectedState, expectedPhase }) => {
			const agentState = window.appState?.sessions?.get(sid)?.agent?.$.value;
			if (!agentState) return false;

			if (agentState.status !== expectedState) return false;

			// If phase is specified and state is 'processing', check the phase
			if (expectedPhase && expectedState === 'processing') {
				return agentState.phase === expectedPhase;
			}

			return true;
		},
		{ sid: sessionId, expectedState: state, expectedPhase: phase },
		{ timeout: 30000 }
	);
}

/**
 * Wait for slash command autocomplete dropdown to appear
 */
export async function waitForCommandAutocomplete(page: Page): Promise<Locator> {
	const dropdown = page.locator('text=Slash Commands').locator('..');
	await dropdown.waitFor({ state: 'visible', timeout: 5000 });
	return dropdown;
}

/**
 * Wait for slash command autocomplete dropdown to close
 */
export async function waitForCommandAutocompleteClosed(page: Page): Promise<void> {
	const dropdown = page.locator('text=Slash Commands').locator('..');
	await dropdown.waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Wait for error message to appear
 */
export async function waitForError(page: Page, errorText?: string): Promise<Locator> {
	if (errorText) {
		const errorElement = page.locator(`[data-error-message]:has-text("${errorText}")`);
		await errorElement.waitFor({ state: 'visible', timeout: 10000 });
		return errorElement;
	}

	const errorElement = page.locator('[data-error-message]').first();
	await errorElement.waitFor({ state: 'visible', timeout: 10000 });
	return errorElement;
}

/**
 * Wait for Settings modal to open
 */
export async function waitForSettingsModal(page: Page): Promise<void> {
	await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Wait for Settings modal to close
 */
export async function waitForSettingsModalClosed(page: Page): Promise<void> {
	await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Wait for plus menu dropdown to open
 */
export async function waitForPlusMenu(page: Page): Promise<void> {
	// Click the plus/more options button
	const plusButton = page.locator('button[title="More options"]');
	await plusButton.waitFor({ state: 'visible', timeout: 5000 });
	await plusButton.click();
	await page.waitForTimeout(300);
}

/**
 * Wait for toast notification to appear
 */
export async function waitForToast(page: Page, text?: string): Promise<Locator> {
	if (text) {
		const toast = page.locator(
			`[data-testid="toast"]:has-text("${text}"), [role="alert"]:has-text("${text}")`
		);
		await toast.waitFor({ state: 'visible', timeout: 5000 });
		return toast;
	}

	const toast = page.locator('[data-testid="toast"], [role="alert"]').first();
	await toast.waitFor({ state: 'visible', timeout: 5000 });
	return toast;
}

/**
 * Wait for model to be switched
 */
export async function waitForModelSwitch(
	page: Page,
	sessionId: string,
	modelId: string
): Promise<void> {
	await page.waitForFunction(
		({ sid, expected }) => {
			const session = window.appState?.sessions?.get(sid);
			const sessionValue = session?.session?.$.value as { config?: { model?: string } } | undefined;
			return sessionValue?.config?.model === expected;
		},
		{ sid: sessionId, expected: modelId },
		{ timeout: 10000 }
	);
}
