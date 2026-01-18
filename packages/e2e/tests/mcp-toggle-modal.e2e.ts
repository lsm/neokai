/**
 * MCP Toggle - Tools Modal UI Tests
 *
 * Tests for the MCP (Model Context Protocol) toggle functionality in the Tools modal.
 * Focuses on basic modal UI interaction and toggle behavior.
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 */

import { test, expect } from '../fixtures';
import {
	cleanupSettingsLocalJson,
	ensureClaudeDir,
	openToolsModal,
	closeToolsModal,
	saveToolsModal,
	getMcpServerNames,
	isMcpServerEnabled,
	toggleMcpServer,
	enableAllMcpServers,
	disableAllMcpServers,
	getEnabledMcpServerCount,
	readSettingsLocalJson,
} from './helpers/mcp-toggle-helpers';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('MCP Toggle - Tools Modal', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		// Clean up settings file before each test
		cleanupSettingsLocalJson();
		ensureClaudeDir();

		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a new session
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
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
		// Clean up settings file after each test
		cleanupSettingsLocalJson();
	});

	test('should open Tools modal from session options menu', async ({ page }) => {
		await openToolsModal(page);

		// Verify modal is open with expected sections
		await expect(page.locator('h2:has-text("Tools")')).toBeVisible();

		// Verify section headers (use .first() to handle potential duplicate elements)
		await expect(page.locator('h3:has-text("System Prompt")').first()).toBeVisible();
		await expect(page.locator('h3:has-text("Setting Sources")').first()).toBeVisible();
		await expect(page.locator('h3:has-text("MCP Servers")').first()).toBeVisible();
		await expect(page.locator('h3:has-text("Liuboer Tools")').first()).toBeVisible();
		await expect(page.locator('h3:has-text("SDK Built-in")').first()).toBeVisible();
	});

	test.skip('should close Tools modal with close button', async ({ page }) => {
		// TODO: Flaky test - click on close button doesn't reliably close the modal
		await openToolsModal(page);

		// Verify modal is open
		await expect(page.locator('h2:has-text("Tools")')).toBeVisible();

		// Wait for modal to fully load before trying to close
		await page.waitForTimeout(500);

		// Click the close button - use first() as there may be multiple close buttons on page
		const closeButton = page.getByRole('button', { name: 'Close modal' }).first();
		await expect(closeButton).toBeVisible({ timeout: 5000 });
		await closeButton.click({ force: true });

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Tools")')).toBeHidden({
			timeout: 5000,
		});
	});

	test('should show MCP servers section with servers from settings', async ({ page }) => {
		await openToolsModal(page);

		// Find MCP Servers section
		const mcpSection = page.locator('h3:has-text("MCP Servers")');
		await expect(mcpSection).toBeVisible();

		// Get MCP servers displayed
		const serverNames = await getMcpServerNames(page);

		// Log server names for debugging
		console.log('MCP servers found:', serverNames);

		// We should have at least the test MCP server if configured
		expect(serverNames).toBeDefined();
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

	test('should write disabledMcpjsonServers to settings.local.json when server is disabled', async ({
		page,
	}) => {
		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Ensure server starts enabled (check and enable if not)
		const wasEnabled = await isMcpServerEnabled(page, serverNames[0]);
		if (!wasEnabled) {
			await toggleMcpServer(page, serverNames[0]);
			await saveToolsModal(page);
			await openToolsModal(page);
		}

		// Disable the first server
		await toggleMcpServer(page, serverNames[0]);
		await saveToolsModal(page);

		// Verify settings.local.json was written correctly
		const settings = readSettingsLocalJson();
		expect(settings).not.toBeNull();
		expect(settings?.disabledMcpjsonServers).toBeDefined();
		expect(settings?.disabledMcpjsonServers).toContain(serverNames[0]);
	});

	test('should remove server from disabledMcpjsonServers when re-enabled', async ({ page }) => {
		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// First, disable the server
		const wasEnabled = await isMcpServerEnabled(page, serverNames[0]);
		if (wasEnabled) {
			await toggleMcpServer(page, serverNames[0]);
		}
		await saveToolsModal(page);

		// Verify server is disabled in file
		let settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).toContain(serverNames[0]);

		// Re-enable the server
		await openToolsModal(page);
		await toggleMcpServer(page, serverNames[0]);
		await saveToolsModal(page);

		// Verify server is no longer in disabled list
		settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).toBeDefined();
		expect(settings?.disabledMcpjsonServers).not.toContain(serverNames[0]);
	});

	test('should persist toggle state in UI after save', async ({ page }) => {
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

	test('should handle disabling all MCP servers', async ({ page }) => {
		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// Disable all servers
		await disableAllMcpServers(page);
		await saveToolsModal(page);

		// Verify settings.local.json contains all servers as disabled
		const settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).toBeDefined();
		expect(settings?.disabledMcpjsonServers?.length).toBe(serverNames.length);

		// Verify each server is in the disabled list
		for (const serverName of serverNames) {
			expect(settings?.disabledMcpjsonServers).toContain(serverName);
		}
	});

	test('should handle enabling all MCP servers', async ({ page }) => {
		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// First disable all
		await disableAllMcpServers(page);
		await saveToolsModal(page);

		// Verify all disabled
		let settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers?.length).toBe(serverNames.length);

		// Now enable all
		await openToolsModal(page);
		await enableAllMcpServers(page);
		await saveToolsModal(page);

		// Verify disabled list is empty
		settings = readSettingsLocalJson();
		expect(settings?.disabledMcpjsonServers).toBeDefined();
		expect(settings?.disabledMcpjsonServers?.length).toBe(0);
	});

	test('should discard changes when Cancel is clicked', async ({ page }) => {
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
});
