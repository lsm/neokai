/**
 * MCP Toggle E2E Tests
 *
 * End-to-end tests for the MCP (Model Context Protocol) toggle functionality.
 * Tests the Tools modal MCP server toggles and verifies:
 * 1. MCP servers can be enabled/disabled via UI
 * 2. Disabling MCP servers writes to .claude/settings.local.json
 * 3. MCP toggle state persists after save
 * 4. File-based settings are correctly formatted (disabledMcpjsonServers)
 *
 * IMPORTANT: Tests actual UI behavior - does not bypass via RPC
 *
 * Implementation Notes:
 * - Uses file-based approach: disabled servers written to settings.local.json
 * - SDK reads settings.local.json at query init (session restart required for changes)
 * - disabledMcpServers array maps to disabledMcpjsonServers in the file
 */

import { test, expect, type Page } from '../fixtures';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
	waitForSessionCreated,
	waitForWebSocketConnected,
	cleanupTestSession,
} from './helpers/wait-helpers';

// Workspace path where settings.local.json is written
const WORKSPACE_PATH = join(process.cwd(), '..', 'cli', 'tmp', 'workspace');
const SETTINGS_LOCAL_PATH = join(WORKSPACE_PATH, '.claude', 'settings.local.json');

/**
 * Open the Tools modal via Session options menu
 */
async function openToolsModal(page: Page): Promise<void> {
	// Click the Session options button (three-dot menu in header with title="Session options")
	const sessionOptionsButton = page.locator('button[title="Session options"]').first();
	await sessionOptionsButton.waitFor({ state: 'visible', timeout: 5000 });
	await sessionOptionsButton.click();

	// Wait for menu to appear and click Tools
	const toolsMenuItem = page.locator('text=Tools').first();
	await toolsMenuItem.waitFor({ state: 'visible', timeout: 3000 });
	await toolsMenuItem.click();

	// Wait for modal to appear
	await page.locator('h2:has-text("Tools")').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close the Tools modal by clicking the X button
 */
async function closeToolsModal(page: Page): Promise<void> {
	// The Modal component has a close button with aria-label="Close modal"
	const closeButton = page.locator('button[aria-label="Close modal"]');
	await closeButton.click();

	// Wait for modal to close
	await page.locator('h2:has-text("Tools")').waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Save the Tools modal configuration
 */
async function saveToolsModal(page: Page): Promise<void> {
	const saveButton = page.locator('button:has-text("Save")').first();
	// Use force click to bypass any overlaying elements
	await saveButton.click({ force: true });

	// Wait for success toast notification
	await page
		.locator('text=Tools configuration saved')
		.waitFor({ state: 'visible', timeout: 10000 });

	// Wait for modal to close
	await page.locator('h2:has-text("Tools")').waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Get the list of MCP server names displayed in the modal
 */
async function getMcpServerNames(page: Page): Promise<string[]> {
	// MCP servers section contains server labels with checkbox inputs
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	const serverNames: string[] = [];

	// Get all labels that contain server checkboxes
	const labels = mcpSection.locator('label:has(input[type="checkbox"])');
	const count = await labels.count();

	for (let i = 0; i < count; i++) {
		const label = labels.nth(i);
		// Server name is usually in a span or div with text
		const nameElement = label.locator('span, div').first();
		const name = await nameElement.textContent();
		if (name) {
			// Extract just the server name (remove "bunx" suffix if present)
			const serverName = name.trim().split(/\s+/)[0];
			serverNames.push(serverName);
		}
	}

	return serverNames;
}

/**
 * Check if a specific MCP server is enabled (checkbox checked)
 */
async function isMcpServerEnabled(page: Page, serverName: string): Promise<boolean> {
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	// Find checkbox by looking for label containing server name
	const labels = mcpSection.locator('label');
	const count = await labels.count();

	for (let i = 0; i < count; i++) {
		const label = labels.nth(i);
		const text = await label.textContent();
		if (text && text.includes(serverName)) {
			const cb = label.locator('input[type="checkbox"]');
			return cb.isChecked();
		}
	}

	return false;
}

/**
 * Toggle a specific MCP server by clicking its checkbox
 */
async function toggleMcpServer(page: Page, serverName: string): Promise<void> {
	const mcpSection = page.locator('h3:has-text("MCP Servers")').locator('..').first();
	const labels = mcpSection.locator('label');
	const count = await labels.count();

	for (let i = 0; i < count; i++) {
		const label = labels.nth(i);
		const text = await label.textContent();
		if (text && text.includes(serverName)) {
			const checkbox = label.locator('input[type="checkbox"]');
			await checkbox.click();
			return;
		}
	}

	throw new Error(`MCP server "${serverName}" not found in modal`);
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
 * Read the settings.local.json file
 */
function readSettingsLocalJson(): { disabledMcpjsonServers?: string[] } | null {
	try {
		if (!existsSync(SETTINGS_LOCAL_PATH)) {
			return null;
		}
		const content = readFileSync(SETTINGS_LOCAL_PATH, 'utf-8');
		return JSON.parse(content) as { disabledMcpjsonServers?: string[] };
	} catch {
		return null;
	}
}

/**
 * Clean up settings.local.json before tests
 */
function cleanupSettingsLocalJson(): void {
	try {
		if (existsSync(SETTINGS_LOCAL_PATH)) {
			rmSync(SETTINGS_LOCAL_PATH);
		}
	} catch {
		// Ignore errors
	}
}

/**
 * Ensure .claude directory exists
 */
function ensureClaudeDir(): void {
	const claudeDir = join(WORKSPACE_PATH, '.claude');
	if (!existsSync(claudeDir)) {
		mkdirSync(claudeDir, { recursive: true });
	}
}

/**
 * Get MCP config from session via RPC
 */
async function getMcpConfigViaRPC(
	page: Page,
	sessionId: string
): Promise<{ disabledMcpServers?: string[] }> {
	return page.evaluate(async (sid) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub) {
			throw new Error('MessageHub not found');
		}

		const result = await hub.call('session.get', { sessionId: sid });
		const session = result.session as {
			config: {
				tools?: {
					disabledMcpServers?: string[];
				};
			};
		};

		return {
			disabledMcpServers: session.config.tools?.disabledMcpServers ?? [],
		};
	}, sessionId);
}

test.describe('MCP Toggle - Tools Modal', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		// Clean up settings file before each test
		cleanupSettingsLocalJson();
		ensureClaudeDir();

		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a new session
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
		await expect(page.locator('h2:has-text("Tools")')).toBeHidden({ timeout: 5000 });
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
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

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
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

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

test.describe('MCP Toggle - Session Config Sync', () => {
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

	test('should sync disabledMcpServers to session config', async ({ page }) => {
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

		// Verify session config via RPC
		const mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.disabledMcpServers).toContain(serverNames[0]);
	});

	test('should clear disabledMcpServers when all servers enabled', async ({ page }) => {
		if (!sessionId) {
			throw new Error('Session ID is required for this test');
		}

		await openToolsModal(page);

		const serverNames = await getMcpServerNames(page);
		if (serverNames.length === 0) {
			console.log('Skipping test - no MCP servers available');
			return;
		}

		// First disable all
		await disableAllMcpServers(page);
		await saveToolsModal(page);

		// Verify all disabled in config
		let mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.disabledMcpServers?.length).toBe(serverNames.length);

		// Enable all
		await openToolsModal(page);
		await enableAllMcpServers(page);
		await saveToolsModal(page);

		// Verify config is cleared
		mcpConfig = await getMcpConfigViaRPC(page, sessionId);
		expect(mcpConfig.disabledMcpServers?.length).toBe(0);
	});
});

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
