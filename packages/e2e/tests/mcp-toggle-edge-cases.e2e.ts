/**
 * MCP Toggle - Edge Cases Tests
 *
 * Tests for edge cases and boundary conditions in MCP toggle functionality.
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
	toggleMcpServer,
	enableAllMcpServers,
	readSettingsLocalJson,
} from './helpers/mcp-toggle-helpers';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('MCP Toggle - Edge Cases', () => {
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

	test('should handle rapid toggle clicks gracefully', async ({ page }) => {
		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Rapidly toggle the same server multiple times
		for (let i = 0; i < 6; i++) {
			await toggleMcpServer(page, serverNames[0]);
		}

		// Should end up in original state (6 toggles = even = back to original)
		// Just verify no errors occurred and UI is responsive
		const saveButton = page.locator('button:has-text("Save")').first();
		await expect(saveButton).toBeVisible();
	});

	test('should preserve other settings when toggling MCP', async ({ page }) => {
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

		await openToolsModal(page);

		// Get Claude Code Preset checkbox state
		const claudeCodeCheckbox = page
			.locator('label:has-text("Claude Code Preset")')
			.locator('input[type="checkbox"]')
			.first();
		const claudeCodeEnabled = await claudeCodeCheckbox.isChecked();

		// Get Memory checkbox state
		const memoryCheckbox = page
			.locator('label:has-text("Memory")')
			.locator('input[type="checkbox"]')
			.first();
		const memoryEnabled = await memoryCheckbox.isChecked();

		// Toggle MCP server (if available)
		const serverNames = await getMcpServerNames(page);
		if (serverNames.length > 0) {
			await toggleMcpServer(page, serverNames[0]);
			await saveToolsModal(page);
			await openToolsModal(page);
		}

		// Verify other settings weren't affected
		const claudeCodeEnabledAfter = await claudeCodeCheckbox.isChecked();
		expect(claudeCodeEnabledAfter).toBe(claudeCodeEnabled);

		const memoryEnabledAfter = await memoryCheckbox.isChecked();
		expect(memoryEnabledAfter).toBe(memoryEnabled);
	});

	test('should handle individual server toggle correctly', async ({ page }) => {
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length < 2) {
			console.log('Skipping test - need at least 2 MCP servers');
			return;
		}

		// Start with all enabled
		await enableAllMcpServers(page);
		await saveToolsModal(page);

		// Disable first server only
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[0]);
		await saveToolsModal(page);

		let settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).toContain(serverNames[0]);
		expect(settings?.disabledMcpjsonServers).not.toContain(serverNames[1]);

		// Disable second server too
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[1]);
		await saveToolsModal(page);

		settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).toContain(serverNames[0]);
		expect(settings?.disabledMcpjsonServers).toContain(serverNames[1]);

		// Enable first server back
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[0]);
		await saveToolsModal(page);

		settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).not.toContain(serverNames[0]);
		expect(settings?.disabledMcpjsonServers).toContain(serverNames[1]);
	});
});
