/**
 * Rewind Modal E2E Tests
 *
 * Tests for the Rewind modal accessible from the ChatHeader dropdown menu.
 * The rewind feature allows users to restore their session to a previous checkpoint.
 */

import { test, expect, type Page } from '../fixtures';
import {
	waitForWebSocketConnected,
	waitForSessionCreated,
	cleanupTestSession,
	waitForMessageProcessed,
} from './helpers/wait-helpers';

/**
 * Open the header dropdown menu (three-dot menu)
 */
async function openHeaderMenu(page: Page): Promise<void> {
	const menuButton = page.locator('button[title="Session options"]');
	await menuButton.waitFor({ state: 'visible', timeout: 5000 });
	await menuButton.click();
	await page.waitForTimeout(200);
}

/**
 * Open the Rewind modal from header dropdown
 */
async function openRewindModal(page: Page): Promise<void> {
	await openHeaderMenu(page);

	// Click "Rewind to Checkpoint" menu item
	const rewindItem = page.locator('[role="menuitem"]:has-text("Rewind to Checkpoint")');
	await rewindItem.waitFor({ state: 'visible', timeout: 3000 });
	await rewindItem.click();

	// Wait for modal to appear
	await page
		.locator('h2:has-text("Rewind to Checkpoint")')
		.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Close the Rewind modal
 */
async function closeRewindModal(page: Page): Promise<void> {
	const closeButton = page.locator('[role="dialog"] button[aria-label="Close modal"]');
	await closeButton.click();
	await page
		.locator('h2:has-text("Rewind to Checkpoint")')
		.waitFor({ state: 'hidden', timeout: 3000 });
}

/**
 * Helper to send a message and wait for it to be processed
 */
async function sendMessage(page: Page, messageText: string, sessionId: string): Promise<void> {
	const messageInput = 'textarea[placeholder*="Ask"]';
	await page.fill(messageInput, messageText);
	await page.click('button[aria-label*="Send message"]');
	await waitForMessageProcessed(page, sessionId);
}

test.describe('Rewind Modal', () => {
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

	test('should have Rewind to Checkpoint menu item in header dropdown', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open header menu
		await openHeaderMenu(page);

		// Verify "Rewind to Checkpoint" menu item exists
		const rewindItem = page.locator('[role="menuitem"]:has-text("Rewind to Checkpoint")');
		await expect(rewindItem).toBeVisible();
	});

	test('should show empty state when no checkpoints exist', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Rewind modal
		await openRewindModal(page);

		// Verify empty state message
		await expect(page.locator('text=No checkpoints available')).toBeVisible();
		await expect(
			page.locator('text=Checkpoints are created when you send messages to the agent.')
		).toBeVisible();
	});

	test('should display checkpoints after sending messages', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send multiple messages to create checkpoints
		await sendMessage(page, 'First message to create checkpoint', sessionId);
		await sendMessage(page, 'Second message to create another checkpoint', sessionId);

		// Wait a bit for checkpoints to be processed
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Verify checkpoints are displayed
		await expect(page.locator('text=Turn 2')).toBeVisible();
		await expect(page.locator('text=Turn 1')).toBeVisible();

		// Verify message previews are shown
		await expect(page.locator('text=First message to create checkpoint')).toBeVisible();
		await expect(page.locator('text=Second message to create another checkpoint')).toBeVisible();
	});

	test('should display mode options and descriptions', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to create a checkpoint
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Verify mode options are displayed
		await expect(page.locator('text=Files only')).toBeVisible();
		await expect(page.locator('text=Conversation only')).toBeVisible();
		await expect(page.locator('text=Both')).toBeVisible();

		// Verify default mode (Files only) is selected
		const filesRadio = page.locator('input[type="radio"][value="files"]');
		await expect(filesRadio).isChecked();

		// Verify description for files mode
		await expect(page.locator('text=Restore file changes only')).toBeVisible();
	});

	test('should switch mode and show updated description', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Switch to conversation mode
		const conversationRadio = page.locator('input[type="radio"][value="conversation"]');
		await conversationRadio.click();

		// Verify description updated
		await expect(page.locator('text=Resume conversation from this point')).toBeVisible();

		// Switch to both mode
		const bothRadio = page.locator('input[type="radio"][value="both"]');
		await bothRadio.click();

		// Verify description updated
		await expect(page.locator('text=Restore both files and conversation')).toBeVisible();
	});

	test('should show preview when checkpoint is selected', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message for preview', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Click on a checkpoint to load preview
		const checkpointButton = page.locator('button:has-text("Test message for preview")');
		await checkpointButton.click();

		// Wait for preview panel to load
		await page.waitForTimeout(2000);

		// Verify preview panel is shown
		await expect(page.locator('text=Preview')).toBeVisible();

		// Note: The actual preview content depends on whether there are file changes
	});

	test('should close modal with close button', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to have a checkpoint
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Verify modal is open
		await expect(page.locator('h2:has-text("Rewind to Checkpoint")')).toBeVisible();

		// Close the modal
		await closeRewindModal(page);

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Rewind to Checkpoint")')).toBeHidden();
	});

	test('should close modal with Escape key', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Open Rewind modal
		await openRewindModal(page);

		// Verify modal is open
		await expect(page.locator('h2:has-text("Rewind to Checkpoint")')).toBeVisible();

		// Press Escape
		await page.keyboard.press('Escape');

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Rewind to Checkpoint")')).toBeHidden({ timeout: 3000 });
	});

	test('should close modal with Cancel button', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to have a checkpoint
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Click Cancel button
		const cancelButton = page.locator('[role="dialog"] button:has-text("Cancel")').first();
		await cancelButton.click();

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Rewind to Checkpoint")')).toBeHidden();
	});

	test('should show confirmation for conversation mode', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Switch to conversation mode
		const conversationRadio = page.locator('input[type="radio"][value="conversation"]');
		await conversationRadio.click();

		// Select a checkpoint
		const checkpointButton = page.locator('button:has-text("Test message")');
		await checkpointButton.click();
		await page.waitForTimeout(1000);

		// Click Rewind button (should show confirmation, not execute immediately)
		const rewindButton = page.locator('[role="dialog"] button:has-text("Rewind")');
		await rewindButton.click();

		// Verify confirmation dialog appears
		await expect(page.locator('text=This action cannot be undone')).toBeVisible();
		await expect(
			page.locator('text=Messages after this checkpoint will be permanently deleted')
		).toBeVisible();

		// Verify Confirm Rewind button is shown
		await expect(page.locator('button:has-text("Confirm Rewind")')).toBeVisible();
	});

	test('should cancel rewind from confirmation dialog', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Switch to conversation mode
		const conversationRadio = page.locator('input[type="radio"][value="conversation"]');
		await conversationRadio.click();

		// Select a checkpoint
		const checkpointButton = page.locator('button:has-text("Test message")');
		await checkpointButton.click();
		await page.waitForTimeout(1000);

		// Click Rewind button to show confirmation
		const rewindButton = page.locator('[role="dialog"] button:has-text("Rewind")');
		await rewindButton.click();

		// Click Cancel in confirmation dialog
		const cancelButton = page
			.locator('[role="dialog"] .bg-red-500\\/10 button:has-text("Cancel")')
			.first();
		await cancelButton.click();

		// Verify modal is still open (not closed after rewind)
		await expect(page.locator('h2:has-text("Rewind to Checkpoint")')).toBeVisible();

		// Verify confirmation dialog is hidden
		await expect(page.locator('text=This action cannot be undone')).toBeHidden();
	});

	test('should disable rewind button when no checkpoint selected', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Verify Rewind button is disabled initially (no checkpoint selected)
		const rewindButton = page.locator('[role="dialog"] button:has-text("Rewind")');
		await expect(rewindButton).toBeDisabled();
	});

	test('should show confirmation for both mode', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Switch to both mode
		const bothRadio = page.locator('input[type="radio"][value="both"]');
		await bothRadio.click();

		// Select a checkpoint
		const checkpointButton = page.locator('button:has-text("Test message")');
		await checkpointButton.click();
		await page.waitForTimeout(1000);

		// Click Rewind button (should show confirmation)
		const rewindButton = page.locator('[role="dialog"] button:has-text("Rewind")');
		await rewindButton.click();

		// Verify confirmation dialog appears
		await expect(page.locator('text=This action cannot be undone')).toBeVisible();
	});

	test('should not show confirmation for files mode', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Verify files mode is selected (default)
		const filesRadio = page.locator('input[type="radio"][value="files"]');
		await expect(filesRadio).isChecked();

		// Select a checkpoint
		const checkpointButton = page.locator('button:has-text("Test message")');
		await checkpointButton.click();
		await page.waitForTimeout(1000);

		// Click Rewind button (should NOT show confirmation for files mode)
		const rewindButton = page.locator('[role="dialog"] button:has-text("Rewind")');
		await rewindButton.click();

		// Verify confirmation dialog does NOT appear
		await expect(page.locator('text=This action cannot be undone')).toBeHidden();

		// Modal should close (or show success message)
		// The exact behavior depends on the rewind result
	});

	test('should sort checkpoints by turn number (newest first)', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send multiple messages
		for (let i = 1; i <= 3; i++) {
			await sendMessage(page, `Message number ${i}`, sessionId);
			await page.waitForTimeout(500);
		}

		// Open Rewind modal
		await openRewindModal(page);

		// Get all checkpoint buttons with turn numbers
		const checkpointButtons = page.locator('button:has-text("Turn")');
		const count = await checkpointButtons.count();
		expect(count).toBe(3);

		// Verify they are sorted with newest first (Turn 3, then Turn 2, then Turn 1)
		const firstButton = checkpointButtons.nth(0);
		const secondButton = checkpointButtons.nth(1);
		const thirdButton = checkpointButtons.nth(2);

		await expect(firstButton).toContainText('Turn 3');
		await expect(secondButton).toContainText('Turn 2');
		await expect(thirdButton).toContainText('Turn 1');
	});

	test('should display timestamps for checkpoints', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message', sessionId);
		await page.waitForTimeout(1000);

		// Open Rewind modal
		await openRewindModal(page);

		// Verify timestamp is displayed (either "Today", "Yesterday", or a date)
		const hasToday = await page.locator('span.text-gray-500:has-text("Today")').count();
		const hasYesterday = await page.locator('span.text-gray-500:has-text("Yesterday")').count();
		const hasComma = await page.locator('span.text-gray-500:has-text(",")').count();

		expect(hasToday + hasYesterday + hasComma).toBeGreaterThan(0);
	});
});
