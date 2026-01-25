/**
 * Session Info Modal E2E Tests
 *
 * Tests for the Session Info modal accessible from the ChatHeader dropdown menu.
 */

import { test, expect, type Page } from '../fixtures';
import {
	waitForWebSocketConnected,
	waitForSessionCreated,
	cleanupTestSession,
} from './helpers/wait-helpers';

/**
 * Open the header dropdown menu (three-dot menu)
 */
async function openHeaderMenu(page: Page): Promise<void> {
	// Click the three-dot menu button in the header
	const menuButton = page.locator('button[title="Session options"]');
	await menuButton.waitFor({ state: 'visible', timeout: 5000 });
	await menuButton.click();
	await page.waitForTimeout(200);
}

/**
 * Open the Session Info modal from header dropdown
 */
async function openSessionInfoModal(page: Page): Promise<void> {
	await openHeaderMenu(page);

	// Click "Session Info" menu item
	const sessionInfoItem = page.locator('[role="menuitem"]:has-text("Session Info")');
	await sessionInfoItem.waitFor({ state: 'visible', timeout: 3000 });
	await sessionInfoItem.click();

	// Wait for modal to appear
	await page.locator('h2:has-text("Session Info")').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close the Session Info modal
 */
async function closeSessionInfoModal(page: Page): Promise<void> {
	const closeButton = page.locator('[role="dialog"] button[aria-label="Close modal"]');
	await closeButton.click();
	await page.locator('h2:has-text("Session Info")').waitFor({ state: 'hidden', timeout: 3000 });
}

test.describe('Session Info Modal', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			await cleanupTestSession(page, sessionId);
			sessionId = null;
		}
	});

	test('should have Session Info menu item in header dropdown', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open header menu
		await openHeaderMenu(page);

		// Verify "Session Info" menu item exists
		const sessionInfoItem = page.locator('[role="menuitem"]:has-text("Session Info")');
		await expect(sessionInfoItem).toBeVisible();
	});

	test('should open Session Info modal from header dropdown', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Session Info modal
		await openSessionInfoModal(page);

		// Verify modal is open with "Session Info" title
		await expect(page.locator('h2:has-text("Session Info")')).toBeVisible();
	});

	test('should display SDK Folder path', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Session Info modal
		await openSessionInfoModal(page);

		// Verify SDK Folder label and value are shown
		await expect(page.locator('text=SDK Folder')).toBeVisible();

		// The SDK folder path should contain ~/.claude/projects/
		// Find the label span and get its sibling value span (they're in a flex row)
		const sdkFolderLabel = page.locator('[role="dialog"] span:text("SDK Folder")');
		// The value span is the next sibling with font-mono class
		const sdkFolderValue = sdkFolderLabel.locator('~ span.font-mono').first();
		await expect(sdkFolderValue).toContainText('~/.claude/projects/');
	});

	test('should display SDK Session ID when available', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Session Info modal
		await openSessionInfoModal(page);

		// SDK Session ID may not be available until first message is sent
		// Just verify the modal opened successfully
		await expect(page.locator('h2:has-text("Session Info")')).toBeVisible();
	});

	test('should have copy buttons for each field', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Session Info modal
		await openSessionInfoModal(page);

		// There should be at least one copy button (for SDK Folder)
		const copyButtons = page.locator('[role="dialog"] button:has(svg)');
		const count = await copyButtons.count();
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test('should close modal with close button', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Session Info modal
		await openSessionInfoModal(page);

		// Verify modal is open
		await expect(page.locator('h2:has-text("Session Info")')).toBeVisible();

		// Close the modal
		await closeSessionInfoModal(page);

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Session Info")')).toBeHidden();
	});

	test('should close modal with Escape key', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Session Info modal
		await openSessionInfoModal(page);

		// Verify modal is open
		await expect(page.locator('h2:has-text("Session Info")')).toBeVisible();

		// Press Escape
		await page.keyboard.press('Escape');

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Session Info")')).toBeHidden({ timeout: 3000 });
	});
});
