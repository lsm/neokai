import { expect, type Page } from '@playwright/test';

/**
 * Force close the WebSocket connection to simulate disconnection.
 *
 * Uses ConnectionManager.simulatePermanentDisconnect() which:
 * - Closes the WebSocket transport (sets closed=true, preventing auto-reconnect)
 * - Sets connectionState to 'disconnected'
 * - UI shows "Offline" indicator
 *
 * This is the correct approach because:
 * - ConnectionManager is exposed on window for testing: window.connectionManager
 * - simulatePermanentDisconnect() properly closes the transport and updates state
 * - The previous approach (hub.transport.ws.close()) no longer works because
 *   the transport is stored privately in ConnectionManager, not on MessageHub
 *
 * @param page - Playwright page instance
 */
export async function closeWebSocket(page: Page): Promise<void> {
	await page.evaluate(() => {
		const cm = (window as any).connectionManager;
		if (cm?.simulatePermanentDisconnect) {
			cm.simulatePermanentDisconnect();
		}
	});

	// Wait briefly for the close event to propagate
	// This is a short debounce, not a polling wait — 200ms is sufficient
	// for the JS event loop to process the close event and update state
	await page.waitForTimeout(200);
}

/**
 * Restore WebSocket connection after closing it with closeWebSocket().
 *
 * Uses ConnectionManager.reconnect() which:
 * - Resets transport state to allow fresh connection
 * - Clears existing hub and connection promise
 * - Sets connectionState to 'connecting'
 * - Attempts a fresh connection via getHub()
 *
 * @param page - Playwright page instance
 */
export async function restoreWebSocket(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const cm = (window as any).connectionManager;
		if (cm?.reconnect) {
			await cm.reconnect();
		}
	});

	// Don't wait here — callers should use waitForOnlineStatus() for event-based waiting
}

/**
 * Wait for the offline status indicator to appear in the UI.
 *
 * This is an event-based alternative to waitForTimeout(3000) that
 * polls for the actual offline indicator DOM element.
 */
export async function waitForOfflineStatus(page: Page, timeout: number = 5000): Promise<void> {
	await expect(page.locator('button[aria-label="Daemon: Offline"]').first()).toBeVisible({
		timeout,
	});
}

/**
 * Wait for the WebSocket to reconnect and the online status to be restored.
 *
 * This is an event-based alternative to waitForTimeout(3000) that
 * verifies the connection state via the MessageHub.
 *
 * The offline indicator visibility check uses a short timeout (2s) since
 * the indicator may not have appeared before the reconnect is initiated.
 * If it's still visible after reconnect, that indicates a problem and will
 * surface in the subsequent MessageHub state assertion.
 */
export async function waitForOnlineStatus(page: Page, timeout: number = 10000): Promise<void> {
	// Check if the offline indicator is currently visible and wait for it to
	// disappear with a short timeout — it may not have appeared at all if
	// the disconnect was brief.
	const offlineIndicator = page.locator('button[aria-label="Daemon: Offline"]').first();
	const wasVisible = await offlineIndicator.isVisible().catch(() => false);

	if (wasVisible) {
		// If the indicator was visible, wait for it to hide (max 2s).
		// If it doesn't hide, proceed to the MessageHub check which will
		// provide a clear failure message about the actual connection state.
		await offlineIndicator.toBeHidden({ timeout: 2000 }).catch(() => {
			// Offline indicator still visible — reconnection may have
			// partially failed. The MessageHub check below will confirm.
		});
	}

	// Verify WebSocket is actually connected via the MessageHub state.
	// This is the authoritative check — it waits for the transport to
	// be fully connected and the hub state to reflect 'connected'.
	await page.waitForFunction(
		() => {
			const hub = window.__messageHub || window.appState?.messageHub;
			return hub?.getState && hub.getState() === 'connected';
		},
		{ timeout }
	);
}
