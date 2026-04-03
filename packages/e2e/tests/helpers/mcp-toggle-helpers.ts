/**
 * MCP Toggle Test Helpers
 *
 * Shared utility functions for MCP toggle E2E tests.
 * Extracted from mcp-toggle.e2e.ts for reusability across test files.
 */

import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
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
 * Locator for the expanded content area of the "Project MCP Servers" group.
 * GroupHeader renders: outer-div > GroupHeader-div > button
 * Content area is a sibling of GroupHeader-div inside the outer-div.
 * Uses XPath to navigate up two levels from the button then find the ml-5 content div.
 *
 * Note: fileMcpGroupOpen initializes to true in ToolsModal.tsx, so the content div is
 * always present in the DOM immediately after the modal opens.
 */
function getProjectMcpContent(page: Page) {
	return page
		.locator('button:has-text("Project MCP Servers")')
		.locator('xpath=../../div[contains(@class,"ml-5")]');
}

/**
 * Locator for individual server labels inside the Project MCP Servers content.
 * Each server label contains a `div.text-sm` for the server name (ToolsModal.tsx renders
 * `<div class="text-sm text-gray-200 truncate">{server.name}</div>`). Source-group toggle
 * labels (for user/project/local sections) only contain a checkbox — no div.text-sm — so
 * `label:has(div.text-sm)` is a structurally stable discriminator.
 */
function getServerLabels(page: Page) {
	return getProjectMcpContent(page).locator('label:has(div.text-sm)');
}

/**
 * Get the list of MCP server names displayed in the Project MCP Servers section.
 * Returns bare server names as stored in settings (e.g. "my-server"), not truncated
 * or split, because ToolsModal renders server.name directly in a dedicated div.text-sm.
 */
export async function getMcpServerNames(page: Page): Promise<string[]> {
	const labels = getServerLabels(page);
	const count = await labels.count();
	const serverNames: string[] = [];

	for (let i = 0; i < count; i++) {
		const label = labels.nth(i);
		// Server name is in `div.text-sm` (class="text-sm text-gray-200 truncate")
		// which renders server.name directly — no extra words to strip.
		const nameElement = label.locator('div.text-sm').first();
		const name = await nameElement.textContent();
		if (name) {
			serverNames.push(name.trim());
		}
	}

	return serverNames;
}

/**
 * Check if a specific MCP server is enabled (checkbox checked)
 */
export async function isMcpServerEnabled(page: Page, serverName: string): Promise<boolean> {
	const labels = getServerLabels(page);
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
	const labels = getServerLabels(page);
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
 * Enable all MCP servers in the Project MCP Servers section
 */
export async function enableAllMcpServers(page: Page): Promise<void> {
	const checkboxes = getServerLabels(page).locator('input[type="checkbox"]');

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
 * Disable all MCP servers in the Project MCP Servers section
 */
export async function disableAllMcpServers(page: Page): Promise<void> {
	const checkboxes = getServerLabels(page).locator('input[type="checkbox"]');

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
 * Get the count of enabled MCP servers in the Project MCP Servers section
 */
export async function getEnabledMcpServerCount(page: Page): Promise<number> {
	const checkboxes = getServerLabels(page).locator('input[type="checkbox"]');

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

// Path to the project-level .mcp.json file in the test workspace
export const PROJECT_MCP_JSON_PATH = join(WORKSPACE_PATH, '.mcp.json');

/**
 * Write a .mcp.json file in the test workspace with the given server configs.
 * Used to set up project-level MCP servers for testing the disable toggle.
 */
export function writeProjectMcpJson(servers: Record<string, unknown>): void {
	mkdirSync(WORKSPACE_PATH, { recursive: true });
	writeFileSync(PROJECT_MCP_JSON_PATH, JSON.stringify({ mcpServers: servers }, null, 2));
}

/**
 * Remove the .mcp.json file from the test workspace.
 */
export function cleanupProjectMcpJson(): void {
	try {
		if (existsSync(PROJECT_MCP_JSON_PATH)) {
			rmSync(PROJECT_MCP_JSON_PATH);
		}
	} catch {
		// Ignore errors
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
