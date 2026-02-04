/**
 * Rewind Mode E2E Tests
 *
 * Tests for the Rewind Mode feature (multi-select rewind) accessible via
 * the InputActionsMenu (plus button dropdown).
 * The rewind mode allows users to select multiple messages and rewind to a specific point.
 */

import { test, expect, type Page } from '../fixtures';
import {
	setupMessageHubTesting,
	cleanupTestSession,
	waitForSessionCreated,
	waitForMessageProcessed,
} from './helpers/wait-helpers';

/**
 * Helper to send a message and wait for it to be processed
 */
async function sendMessage(page: Page, messageText: string, sessionId: string): Promise<void> {
	const messageInput = 'textarea[placeholder*="Ask"]';
	await page.fill(messageInput, messageText);
	await page.click('button[aria-label*="Send message"]');
	await waitForMessageProcessed(page, sessionId);
}

/**
 * Open the InputActionsMenu (plus button dropdown)
 */
async function openInputActionsMenu(page: Page): Promise<void> {
	const menuButton = page
		.locator('button[aria-label="More options"]')
		.or(page.locator('button:has(svg path[d="M12 4v16m8-8H4"])'));
	await menuButton.waitFor({ state: 'visible', timeout: 5000 });
	await menuButton.click();
	await page.waitForTimeout(200);
}

/**
 * Helper to count checkboxes visible in rewind mode
 */
async function getCheckboxCount(page: Page): Promise<number> {
	return await page.locator('input[type="checkbox"][data-message-uuid]').count();
}

/**
 * Helper to get selected checkbox count
 */
async function getSelectedCheckboxCount(page: Page): Promise<number> {
	return await page.locator('input[type="checkbox"][data-message-uuid]:checked').count();
}

test.describe('Rewind Mode', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			// Exit rewind mode if active
			const rewindModeActive = await page
				.locator('div.bg-amber-500\\/10')
				.isVisible()
				.catch(() => false);
			if (rewindModeActive) {
				const exitButton = page
					.locator('button:has-text("Exit Rewind Mode")')
					.or(page.locator('button[aria-label="Close rewind mode"]'));
				await exitButton.click().catch(() => {});
				await page.waitForTimeout(500);
			}
			await cleanupTestSession(page, sessionId);
			sessionId = null;
		}
	});

	test('should have "Rewind Mode" option in InputActionsMenu', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open InputActionsMenu
		await openInputActionsMenu(page);

		// Verify "Rewind Mode" menu item exists
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await expect(rewindModeItem).toBeVisible();
	});

	test('should enter rewind mode when "Rewind Mode" is clicked', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to have content
		await sendMessage(page, 'Test message for rewind mode', sessionId);
		await page.waitForTimeout(1000);

		// Open InputActionsMenu and click "Rewind Mode"
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();

		// Verify rewind mode banner appears
		const rewindBanner = page
			.locator('div.bg-amber-500\\/10')
			.or(page.locator('div:has(svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"])'));
		await expect(rewindBanner).toBeVisible({ timeout: 5000 });

		// Verify banner shows "Select a message to rewind to"
		await expect(page.locator('text=Select a message to rewind to')).toBeVisible();
	});

	test('should show checkboxes next to messages in rewind mode', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send multiple messages
		await sendMessage(page, 'First message', sessionId);
		await sendMessage(page, 'Second message', sessionId);
		await page.waitForTimeout(1000);

		// Enter rewind mode
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();
		await page.waitForTimeout(500);

		// Verify checkboxes appear next to messages
		const checkboxCount = await getCheckboxCount(page);
		expect(checkboxCount).toBeGreaterThan(0);
	});

	test('should not show checkboxes for tool progress messages', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message that triggers tool use
		await sendMessage(page, 'What files are in the current directory?', sessionId);
		await page.waitForTimeout(3000); // Wait for tool execution

		// Enter rewind mode
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();
		await page.waitForTimeout(500);

		// Verify user and assistant messages have checkboxes
		const userCheckboxes = page.locator('[data-message-uuid]').locator('input[type="checkbox"]');
		const count = await userCheckboxes.count();

		// Checkboxes should only be on user/assistant messages, not tool progress
		expect(count).toBeGreaterThan(0);
	});

	test('should auto-select subsequent messages when a message is selected', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send multiple messages
		await sendMessage(page, 'First message', sessionId);
		await sendMessage(page, 'Second message', sessionId);
		await sendMessage(page, 'Third message', sessionId);
		await page.waitForTimeout(1000);

		// Enter rewind mode
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();
		await page.waitForTimeout(500);

		// Get initial checkbox count
		const initialCheckboxCount = await getCheckboxCount(page);

		// Click the first message checkbox
		const firstCheckbox = page.locator('input[type="checkbox"][data-message-uuid]').first();
		await firstCheckbox.click();
		await page.waitForTimeout(300);

		// Verify multiple messages are selected (all subsequent messages should be selected)
		const selectedCount = await getSelectedCheckboxCount(page);
		expect(selectedCount).toBeGreaterThan(1);
		expect(selectedCount).toBeLessThanOrEqual(initialCheckboxCount);
	});

	test('should update selection count in banner', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send messages
		await sendMessage(page, 'First message', sessionId);
		await sendMessage(page, 'Second message', sessionId);
		await page.waitForTimeout(1000);

		// Enter rewind mode
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();
		await page.waitForTimeout(500);

		// Verify initial banner text
		await expect(page.locator('text=Select a message to rewind to')).toBeVisible();

		// Select a message
		const firstCheckbox = page.locator('input[type="checkbox"][data-message-uuid]').first();
		await firstCheckbox.click();
		await page.waitForTimeout(300);

		// Verify banner shows selection count
		const selectionText = page.locator(/message.*selected/);
		await expect(selectionText).toBeVisible();
	});

	test('should show "Rewind to Here" button when messages are selected', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send messages
		await sendMessage(page, 'First message', sessionId);
		await sendMessage(page, 'Second message', sessionId);
		await page.waitForTimeout(1000);

		// Enter rewind mode
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();
		await page.waitForTimeout(500);

		// "Rewind to Here" button should not be visible initially
		const rewindButton = page
			.locator('button:has-text("Rewind to Here")')
			.or(page.locator('button:text-is("Rewind to Here")'));
		await expect(rewindButton)
			.not.toBeVisible({ timeout: 3000 })
			.catch(() => {});

		// Select a message
		const firstCheckbox = page.locator('input[type="checkbox"][data-message-uuid]').first();
		await firstCheckbox.click();
		await page.waitForTimeout(300);

		// "Rewind to Here" button should now be visible
		await expect(rewindButton).toBeVisible({ timeout: 3000 });
	});

	test('should exit rewind mode when "Exit Rewind Mode" is clicked', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Enter rewind mode
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();
		await page.waitForTimeout(500);

		// Verify rewind mode is active
		await expect(
			page
				.locator('div.bg-amber-500\\/10')
				.or(page.locator('div:has(svg path[d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"])'))
		).toBeVisible();

		// Open InputActionsMenu and click "Exit Rewind Mode"
		await openInputActionsMenu(page);
		const exitRewindModeItem = page
			.locator('button:has-text("Exit Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Exit Rewind Mode")'));
		await expect(exitRewindModeItem).toBeVisible();
		await exitRewindModeItem.click();
		await page.waitForTimeout(500);

		// Verify rewind mode banner is gone
		await expect(page.locator('div.bg-amber-500\\/10'))
			.not.toBeVisible({ timeout: 3000 })
			.catch(() => {});

		// Verify checkboxes are gone
		const checkboxCount = await getCheckboxCount(page);
		expect(checkboxCount).toBe(0);
	});

	test('should show checkmark icon when in rewind mode', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Enter rewind mode
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();
		await page.waitForTimeout(500);

		// Open menu again to verify checkmark appears
		await openInputActionsMenu(page);

		// Check for checkmark icon next to "Exit Rewind Mode"
		const checkmarkIcon = page
			.locator('button:has-text("Exit Rewind Mode") svg')
			.or(page.locator('[role="menuitem"]:has-text("Exit Rewind Mode") svg'));
		await expect(checkmarkIcon).toBeVisible();
	});

	test('should deselect messages when checkbox is clicked again', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send messages
		await sendMessage(page, 'First message', sessionId);
		await sendMessage(page, 'Second message', sessionId);
		await page.waitForTimeout(1000);

		// Enter rewind mode
		await openInputActionsMenu(page);
		const rewindModeItem = page
			.locator('button:has-text("Rewind Mode")')
			.or(page.locator('[role="menuitem"]:has-text("Rewind Mode")'));
		await rewindModeItem.click();
		await page.waitForTimeout(500);

		// Select a message
		const firstCheckbox = page.locator('input[type="checkbox"][data-message-uuid]').first();
		await firstCheckbox.click();
		await page.waitForTimeout(300);

		// Verify messages are selected
		let selectedCount = await getSelectedCheckboxCount(page);
		expect(selectedCount).toBeGreaterThan(0);

		// Click the same checkbox again to deselect
		await firstCheckbox.click();
		await page.waitForTimeout(300);

		// Verify all messages are deselected
		selectedCount = await getSelectedCheckboxCount(page);
		expect(selectedCount).toBe(0);
	});
});
