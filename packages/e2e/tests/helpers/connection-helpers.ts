import type { Page } from '@playwright/test';

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

	// Wait for the close event to propagate and UI to update
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

	// Wait for reconnection to complete and UI to update
	await page.waitForTimeout(500);
}
