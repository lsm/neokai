import type { Page } from '@playwright/test';

/**
 * Force close all WebSocket connections by directly closing the MessageHub transport.
 *
 * This triggers the WebSocket onclose event, which causes the app to show "Offline" status
 * and enter disconnected state. The app's connection manager will detect this and update
 * the UI accordingly.
 *
 * **When to use this vs page.context().setOffline():**
 * - Use `closeWebSocket()` when you need to trigger immediate WebSocket disconnection
 *   and test the app's offline/reconnection behavior
 * - `page.context().setOffline()` blocks new network requests but does NOT close
 *   existing WebSocket connections (WebSockets are persistent connections that remain
 *   open until explicitly closed or timeout)
 *
 * **Why this approach:**
 * - We directly access the WebSocket via page.evaluate() to trigger a real close event
 * - This is acceptable because we're triggering a real browser event, not faking internal state
 * - The browser handles the close properly and fires all appropriate events (onclose, etc.)
 * - More reliable than CDP Network domain manipulation
 *
 * @param page - Playwright page instance
 */
export async function closeWebSocket(page: Page): Promise<void> {
	await page.evaluate(() => {
		// Access the MessageHub's WebSocket transport and close it
		// The app exposes this through window for debugging purposes
		const hub = (window as any).__messageHub || (window as any).appState?.messageHub;
		if (hub?.transport?.ws) {
			hub.transport.ws.close();
		}
	});

	// Wait a moment for the close event to propagate and UI to update
	await page.waitForTimeout(100);
}

/**
 * Restore WebSocket connection after closing it.
 *
 * The app's MessageHub transport has auto-reconnect enabled, so we just need to wait
 * for the reconnection to complete. The transport will automatically attempt to reconnect
 * when the WebSocket closes.
 *
 * @param page - Playwright page instance
 */
export async function restoreWebSocket(page: Page): Promise<void> {
	// The WebSocket transport has auto-reconnect enabled
	// Just wait for it to reconnect (typically takes 100-500ms)
	await page.waitForTimeout(500);

	// Optionally wait for the "Offline" indicator to disappear
	// This ensures the connection is fully restored before proceeding
	await page.waitForSelector('text=Offline', { state: 'hidden', timeout: 5000 });
}
