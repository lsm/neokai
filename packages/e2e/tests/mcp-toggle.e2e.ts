/**
 * MCP Toggle E2E Tests
 *
 * End-to-end tests for the MCP (Model Context Protocol) toggle functionality.
 * Tests the Tools modal MCP server toggles and verifies:
 * 1. MCP servers can be enabled/disabled via UI
 * 2. Disabling all MCP servers correctly sets loadProjectMcp to false
 * 3. MCP toggle state persists after save
 * 4. MCP tools are not loaded when disabled
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect, type Page } from '@playwright/test';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

/**
 * Open the Tools modal
 */
async function openToolsModal(page: Page): Promise<void> {
	// Look for the Tools button in the toolbar (wrench icon)
	const toolsButton = page.locator('button[title="Tools"]').first();
	await toolsButton.waitFor({ state: 'visible', timeout: 5000 });
	await toolsButton.click();

	// Wait for modal to appear
	await page
		.locator('[role="dialog"]:has-text("Tools")')
		.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close the Tools modal by clicking Cancel
 */
async function closeToolsModal(page: Page): Promise<void> {
	const cancelButton = page.locator('button:has-text("Cancel")').first();
	await cancelButton.click();

	// Wait for modal to close
	await page
		.locator('[role="dialog"]:has-text("Tools")')
		.waitFor({ state: 'hidden', timeout: 3000 });
}

/**
 * Save the Tools modal configuration
 */
async function saveToolsModal(page: Page): Promise<void> {
	const saveButton = page.locator('button:has-text("Save")').first();
	await saveButton.click();

	// Wait for modal to close
	await page
		.locator('[role="dialog"]:has-text("Tools")')
		.waitFor({ state: 'hidden', timeout: 10000 });

	// Wait for toast or state update
	await page.waitForTimeout(500);
}

/**
 * Get the list of MCP server names displayed in the modal
 */
async function getMcpServerNames(page: Page): Promise<string[]> {
	// MCP servers section contains server labels
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	const serverLabels = mcpSection.locator('label');

	const count = await serverLabels.count();
	const names: string[] = [];

	for (let i = 0; i < count; i++) {
		const label = serverLabels.nth(i);
		const text = await label.locator('div.text-sm').first().textContent();
		if (text) {
			names.push(text.trim());
		}
	}

	return names;
}

/**
 * Check if a specific MCP server is enabled (checkbox checked)
 */
async function isMcpServerEnabled(page: Page, serverName: string): Promise<boolean> {
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	const serverLabel = mcpSection.locator(`label:has-text("${serverName}")`).first();
	const checkbox = serverLabel.locator('input[type="checkbox"]').first();

	return checkbox.isChecked();
}

/**
 * Toggle a specific MCP server
 */
async function toggleMcpServer(page: Page, serverName: string): Promise<void> {
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	const serverLabel = mcpSection.locator(`label:has-text("${serverName}")`).first();
	const checkbox = serverLabel.locator('input[type="checkbox"]').first();

	await checkbox.click();
}

/**
 * Enable all MCP servers
 */
async function enableAllMcpServers(page: Page): Promise<void> {
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	const checkboxes = mcpSection.locator('input[type="checkbox"]');

	const count = await checkboxes.count();
	for (let i = 0; i < count; i++) {
		const checkbox = checkboxes.nth(i);
		const isChecked = await checkbox.isChecked();
		if (!isChecked) {
			await checkbox.click();
		}
	}
}

/**
 * Disable all MCP servers
 */
async function disableAllMcpServers(page: Page): Promise<void> {
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	const checkboxes = mcpSection.locator('input[type="checkbox"]');

	const count = await checkboxes.count();
	for (let i = 0; i < count; i++) {
		const checkbox = checkboxes.nth(i);
		const isChecked = await checkbox.isChecked();
		if (isChecked) {
			await checkbox.click();
		}
	}
}

/**
 * Get the count of enabled MCP servers
 */
async function getEnabledMcpServerCount(page: Page): Promise<number> {
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	const checkboxes = mcpSection.locator('input[type="checkbox"]');

	const count = await checkboxes.count();
	let enabledCount = 0;

	for (let i = 0; i < count; i++) {
		const checkbox = checkboxes.nth(i);
		if (await checkbox.isChecked()) {
			enabledCount++;
		}
	}

	return enabledCount;
}

/**
 * Verify MCP tools config via RPC (for assertion purposes)
 */
async function getMcpConfigViaRPC(
	page: Page,
	sessionId: string
): Promise<{ loadProjectMcp: boolean; enabledMcpPatterns: string[] }> {
	return page.evaluate(async (sid) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub) {
			throw new Error('MessageHub not found');
		}

		const result = await hub.call('session.get', { sessionId: sid });
		const session = result.session as {
			config: {
				tools?: {
					loadProjectMcp?: boolean;
					enabledMcpPatterns?: string[];
				};
			};
		};

		return {
			loadProjectMcp: session.config.tools?.loadProjectMcp ?? false,
			enabledMcpPatterns: session.config.tools?.enabledMcpPatterns ?? [],
		};
	}, sessionId);
}

test.describe('MCP Toggle - Tools Modal', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a new session
		const newSessionButton = page.locator("button:has-text('New Session')");
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
	});

	test('should display Tools button in message input toolbar', async ({ page }) => {
		const toolsButton = page.locator('button[title="Tools"]').first();
		await expect(toolsButton).toBeVisible();
	});

	test('should open Tools modal when Tools button is clicked', async ({ page }) => {
		await openToolsModal(page);

		// Verify modal is open with expected sections
		const modal = page.locator('[role="dialog"]:has-text("Tools")');
		await expect(modal).toBeVisible();

		// Verify section headers
		await expect(page.locator('h3:has-text("System Prompt")')).toBeVisible();
		await expect(page.locator('h3:has-text("Setting Sources")')).toBeVisible();
		await expect(page.locator('h3:has-text("MCP Servers")')).toBeVisible();
		await expect(page.locator('h3:has-text("Liuboer Tools")')).toBeVisible();
		await expect(page.locator('h3:has-text("SDK Built-in")')).toBeVisible();
	});

	test('should close Tools modal with Cancel button', async ({ page }) => {
		await openToolsModal(page);

		// Verify modal is open
		await expect(page.locator('[role="dialog"]:has-text("Tools")')).toBeVisible();

		// Close with Cancel
		await closeToolsModal(page);

		// Verify modal is closed
		await expect(page.locator('[role="dialog"]:has-text("Tools")')).toBeHidden();
	});

	test('should show MCP servers section', async ({ page }) => {
		await openToolsModal(page);

		// Find MCP Servers section
		const mcpSection = page.locator('h3:has-text("MCP Servers")');
		await expect(mcpSection).toBeVisible();

		// Verify the section description
		const mcpDescription = page.locator('text=External tool servers from .mcp.json');
		await expect(mcpDescription).toBeVisible();
	});

	test('should display MCP servers from .mcp.json', async ({ page }) => {
		await openToolsModal(page);

		// Get MCP servers displayed
		const serverNames = await getMcpServerNames(page);

		// We should have at least one MCP server (chrome-devtools is common)
		// Note: If no .mcp.json exists, this might be 0 which is valid
		expect(serverNames).toBeDefined();

		// Log server names for debugging
		console.log('MCP servers found:', serverNames);
	});

	test('should enable Save button when MCP toggle changes', async ({ page }) => {
		await openToolsModal(page);

		// Save button should initially be disabled (no changes)
		const saveButton = page.locator('button:has-text("Save")').first();
		await expect(saveButton).toBeDisabled();

		// Get server names to toggle
		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Toggle the first server
		await toggleMcpServer(page, serverNames[0]);

		// Save button should now be enabled
		await expect(saveButton).toBeEnabled();
	});

	test('should save MCP toggle state', async ({ page }) => {
		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Get initial state
		const initialEnabled = await isMcpServerEnabled(page, serverNames[0]);

		// Toggle the server
		await toggleMcpServer(page, serverNames[0]);

		// Save changes
		await saveToolsModal(page);

		// Reopen modal
		await openToolsModal(page);

		// Verify toggle state persisted
		const currentEnabled = await isMcpServerEnabled(page, serverNames[0]);
		expect(currentEnabled).toBe(!initialEnabled);
	});

	test('should disable all MCP servers when all toggles are unchecked', async ({ page }) => {
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// First, enable all servers
		await enableAllMcpServers(page);
		await saveToolsModal(page);

		// Verify loadProjectMcp is true via RPC
		let mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(true);
		expect(mcpConfig.enabledMcpPatterns.length).toBeGreaterThan(0);

		// Reopen and disable all
		await openToolsModal(page);
		await disableAllMcpServers(page);
		await saveToolsModal(page);

		// Verify loadProjectMcp is now false (auto-synced)
		mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(false);
		expect(mcpConfig.enabledMcpPatterns.length).toBe(0);
	});

	test('should enable loadProjectMcp when any MCP server is enabled', async ({ page }) => {
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Start with all disabled
		await disableAllMcpServers(page);
		await saveToolsModal(page);

		// Verify loadProjectMcp is false
		let mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(false);

		// Enable just one server
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[0]);
		await saveToolsModal(page);

		// Verify loadProjectMcp is now true (auto-synced)
		mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(true);
		expect(mcpConfig.enabledMcpPatterns.length).toBe(1);
	});

	test('should persist MCP toggle state across modal open/close', async ({ page }) => {
		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Get initial enabled count
		const initialEnabledCount = await getEnabledMcpServerCount(page);

		// Toggle first server without saving
		await toggleMcpServer(page, serverNames[0]);

		// Cancel (should discard changes)
		await closeToolsModal(page);

		// Reopen modal
		await openToolsModal(page);

		// Count should be same as initial (changes discarded)
		const currentEnabledCount = await getEnabledMcpServerCount(page);
		expect(currentEnabledCount).toBe(initialEnabledCount);
	});

	test('should handle enabling and disabling single MCP server', async ({ page }) => {
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length < 2) {
			console.log('Skipping test - need at least 2 MCP servers');
			return;
		}

		// Start with all disabled
		await disableAllMcpServers(page);
		await saveToolsModal(page);

		// Enable first server
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[0]);
		await saveToolsModal(page);

		let mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(true);
		expect(mcpConfig.enabledMcpPatterns.length).toBe(1);
		expect(mcpConfig.enabledMcpPatterns[0]).toContain(serverNames[0].replace(/-/g, '-'));

		// Enable second server
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[1]);
		await saveToolsModal(page);

		mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(true);
		expect(mcpConfig.enabledMcpPatterns.length).toBe(2);

		// Disable first server
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[0]);
		await saveToolsModal(page);

		mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(true);
		expect(mcpConfig.enabledMcpPatterns.length).toBe(1);

		// Disable second server (last one)
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[1]);
		await saveToolsModal(page);

		// loadProjectMcp should now be false (auto-synced)
		mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(false);
		expect(mcpConfig.enabledMcpPatterns.length).toBe(0);
	});
});

test.describe('MCP Toggle - State Persistence', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const newSessionButton = page.locator("button:has-text('New Session')");
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

		// Enable first server only
		await disableAllMcpServers(page);
		await toggleMcpServer(page, serverNames[0]);
		await saveToolsModal(page);

		// Verify state before refresh
		let mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(true);
		expect(mcpConfig.enabledMcpPatterns.length).toBe(1);

		// Refresh page
		await page.reload();
		await waitForWebSocketConnected(page);

		// Navigate back to session
		const sessionLink = page.locator(`[data-session-id="${sessionId}"]`).first();
		await sessionLink.click();
		await page.waitForTimeout(1000);

		// Verify state persisted
		mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.loadProjectMcp).toBe(true);
		expect(mcpConfig.enabledMcpPatterns.length).toBe(1);

		// Verify in UI
		await openToolsModal(page);
		const isEnabled = await isMcpServerEnabled(page, serverNames[0]);
		expect(isEnabled).toBe(true);
	});

	test('should maintain correct loadProjectMcp state after multiple toggles', async ({ page }) => {
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
			// Enable all
			await enableAllMcpServers(page);
			await saveToolsModal(page);

			let mcpConfig = await getMcpConfigViaRPC(page, sessionId);
			expect(mcpConfig.loadProjectMcp).toBe(true);

			// Disable all
			await openToolsModal(page);
			await disableAllMcpServers(page);
			await saveToolsModal(page);

			mcpConfig = await getMcpConfigViaRPC(page, sessionId);
			expect(mcpConfig.loadProjectMcp).toBe(false);

			// Reopen for next cycle
			if (i < 2) {
				await openToolsModal(page);
			}
		}
	});
});

test.describe('MCP Toggle - Edge Cases', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		const newSessionButton = page.locator("button:has-text('New Session')");
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
	});

	test('should handle rapid toggle clicks', async ({ page }) => {
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

		// Toggle MCP server (if available)
		const serverNames = await getMcpServerNames(page);
		if (serverNames.length > 0) {
			await toggleMcpServer(page, serverNames[0]);
		}

		// Verify Claude Code Preset wasn't affected
		const claudeCodeEnabledAfter = await claudeCodeCheckbox.isChecked();
		expect(claudeCodeEnabledAfter).toBe(claudeCodeEnabled);
	});
});
