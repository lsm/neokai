/**
 * MCP Toggle - State Persistence Tests
 *
 * Tests for verifying that MCP toggle state persists across page refreshes
 * and multiple toggle cycles.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../fixtures';
import {
	cleanupSettingsLocalJson,
	ensureClaudeDir,
	openToolsModal,
	saveToolsModal,
	getMcpServerNames,
	isMcpServerEnabled,
	toggleMcpServer,
	enableAllMcpServers,
	disableAllMcpServers,
	readSettingsLocalJson,
} from './helpers/mcp-toggle-helpers';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('MCP Toggle - State Persistence', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		cleanupSettingsLocalJson();
		ensureClaudeDir();

		await page.goto('/');
		await waitForWebSocketConnected(page);

		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
		cleanupSettingsLocalJson();
	});

	test('should persist MCP state after page refresh', async ({ page }) => {
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Disable first server
		const wasEnabled = await isMcpServerEnabled(page, serverNames[0]);
		if (wasEnabled) {
			await toggleMcpServer(page, serverNames[0]);
		}
		await saveToolsModal(page);

		// Verify file before refresh
		let settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).toContain(serverNames[0]);

		// Refresh page
		await page.reload();
		await waitForWebSocketConnected(page);

		// Navigate back to session
		const sessionLink = page.locator(`[data-session-id="${sessionId}"]`).first();
		await sessionLink.click();
		await page.waitForTimeout(1000);

		// Verify file still contains correct data
		settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).toContain(serverNames[0]);

		// Verify in UI
		await openToolsModal(page);
		const isEnabled = await isMcpServerEnabled(page, serverNames[0]);
		expect(isEnabled).toBe(false);
	});

	test('should maintain correct state after multiple toggle cycles', async ({ page }) => {
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Perform multiple toggle cycles
		for (let i = 0; i < 3; i++) {
			// Disable all
			await disableAllMcpServers(page);
			await saveToolsModal(page);

			let settings = readSettingsLocalJson();
			expect(settings?.disabledMcpjsonServers?.length).toBe(serverNames.length);

			// Enable all
			await openToolsModal(page);
			await enableAllMcpServers(page);
			await saveToolsModal(page);

			settings = readSettingsLocalJson();
			expect(settings?.disabledMcpjsonServers?.length).toBe(0);

			// Reopen for next cycle
			if (i < 2) {
				await openToolsModal(page);
			}
		}
	});
});
