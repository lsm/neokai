/**
 * MCP Toggle Test Helpers
 *
 * Shared utility functions for MCP toggle E2E tests.
 * Extracted from mcp-toggle.e2e.ts for reusability across test files.
 */

import type { Page } from '@playwright/test';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// Workspace path where settings.local.json is written
export const WORKSPACE_PATH = join(process.cwd(), '..', 'cli', 'tmp', 'workspace');
export const SETTINGS_LOCAL_PATH = join(WORKSPACE_PATH, '.claude', 'settings.local.json');

/**
 * Open the Tools modal via Session options menu
 */
export async function openToolsModal(page: Page): Promise<void> {
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
export async function closeToolsModal(page: Page): Promise<void> {
	// The Modal component has a close button with aria-label="Close modal"
	const closeButton = page.locator('button[aria-label="Close modal"]');
	await closeButton.click();

	// Wait for modal to close
	await page.locator('h2:has-text("Tools")').waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Save the Tools modal configuration
 */
export async function saveToolsModal(page: Page): Promise<void> {
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
export async function getMcpServerNames(page: Page): Promise<string[]> {
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
export async function isMcpServerEnabled(page: Page, serverName: string): Promise<boolean> {
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
export async function toggleMcpServer(page: Page, serverName: string): Promise<void> {
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
export async function enableAllMcpServers(page: Page): Promise<void> {
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
export async function disableAllMcpServers(page: Page): Promise<void> {
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
export async function getEnabledMcpServerCount(page: Page): Promise<number> {
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
export function readSettingsLocalJson(): {
	disabledMcpjsonServers?: string[];
} | null {
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
export function cleanupSettingsLocalJson(): void {
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
export function ensureClaudeDir(): void {
	const claudeDir = join(WORKSPACE_PATH, '.claude');
	if (!existsSync(claudeDir)) {
		mkdirSync(claudeDir, { recursive: true });
	}
}

/**
 * Get MCP config from session via RPC
 */
export async function getMcpConfigViaRPC(
	page: Page,
	sessionId: string
): Promise<{ disabledMcpServers?: string[] }> {
	return page.evaluate(async (sid) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub) {
			throw new Error('MessageHub not found');
		}

		const result = await hub.request('session.get', { sessionId: sid });
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
