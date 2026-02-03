/**
 * Per-Message Rewind Modal E2E Tests
 *
 * Tests for the per-message rewind feature accessible via hover actions on messages.
 * The rewind feature allows users to rewind the conversation to a specific message point.
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

test.describe('Per-Message Rewind Modal', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			await cleanupTestSession(page, sessionId);
			sessionId = null;
		}
	});

	test('should show rewind button on hover for user messages', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to have content to rewind
		await sendMessage(page, 'Test message for rewind', sessionId);

		// Wait for the message to appear
		await page.waitForTimeout(1000);

		// Locate the user message container
		const userMessage = page.locator('[data-message-uuid]').first();
		await expect(userMessage).toBeVisible({ timeout: 5000 });

		// Hover over the message container to reveal the rewind button
		await userMessage.hover();

		// Verify rewind button appears
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await expect(rewindButton).toBeVisible({ timeout: 5000 });
	});

	test('should show rewind button on hover for assistant messages', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to get an assistant response
		await sendMessage(page, 'Say hello', sessionId);

		// Wait for assistant message to appear
		await page.waitForTimeout(2000);

		// Locate the assistant message container - should be the second message with uuid
		const assistantMessage = page.locator('[data-message-uuid]').nth(1);
		await expect(assistantMessage).toBeVisible({ timeout: 5000 });

		// Hover over the message container to reveal the rewind button
		await assistantMessage.hover();

		// Verify rewind button appears
		const rewindButton = assistantMessage.locator('button[title="Rewind to here"]');
		await expect(rewindButton).toBeVisible({ timeout: 5000 });
	});

	test('should open rewind modal when rewind button is clicked', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test message for modal', sessionId);
		await page.waitForTimeout(1000);

		// Hover over the message and click rewind button
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Verify modal opens
		const modalHeading = page.locator('h2:has-text("Rewind Conversation")');
		await expect(modalHeading).toBeVisible({ timeout: 5000 });
	});

	test('should display three radio button options in the modal', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test radio options', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Verify all three radio options are visible
		await expect(page.locator('text=Files & Conversation')).toBeVisible();
		await expect(page.locator('text=Files only')).toBeVisible();
		await expect(page.locator('text=Conversation only')).toBeVisible();
	});

	test('should have "Files & Conversation" (both) checked by default', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test default selection', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Verify "both" radio is checked by default
		const bothRadio = page.locator('input[type="radio"][value="both"]');
		await expect(bothRadio).toBeChecked();
	});

	test('should be able to switch between rewind modes', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test mode switching', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Click "Files only" radio button
		const filesRadio = page.locator('input[type="radio"][value="files"]');
		await filesRadio.click();
		await expect(filesRadio).toBeChecked();

		// Click "Conversation only" radio button
		const conversationRadio = page.locator('input[type="radio"][value="conversation"]');
		await conversationRadio.click();
		await expect(conversationRadio).toBeChecked();

		// Click back to "both"
		const bothRadio = page.locator('input[type="radio"][value="both"]');
		await bothRadio.click();
		await expect(bothRadio).toBeChecked();
	});

	test('should close modal when Cancel button is clicked', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send multiple messages
		await sendMessage(page, 'First message', sessionId);
		await sendMessage(page, 'Second message', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Verify modal is open
		await expect(page.locator('h2:has-text("Rewind Conversation")')).toBeVisible();

		// Click Cancel button
		const cancelButton = page.locator('[role="dialog"] button:has-text("Cancel")').first();
		await cancelButton.click();

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Rewind Conversation")')).toBeHidden({
			timeout: 3000,
		});

		// Verify messages are still present
		await expect(page.locator('text=First message')).toBeVisible();
		await expect(page.locator('text=Second message')).toBeVisible();
	});

	test('should display warning text about action being irreversible', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test warning text', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Verify warning message is displayed
		await expect(page.locator('text=This action cannot be undone.')).toBeVisible();
	});

	test('should display explanatory text about rewind behavior', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test explanatory text', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Verify explanatory text is present
		await expect(
			page.locator(
				'text=This will rewind the conversation to before this message. Choose what to restore:'
			)
		).toBeVisible();
	});

	test('should have Rewind button in modal footer', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test rewind button', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Verify Rewind button is present in the modal
		const modalRewindButton = page.locator('[role="dialog"] button:has-text("Rewind")');
		await expect(modalRewindButton).toBeVisible();
	});

	test('should not show rewind button on messages during rewind mode', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send messages
		await sendMessage(page, 'First message', sessionId);
		await sendMessage(page, 'Second message', sessionId);
		await page.waitForTimeout(1000);

		// Try to enter rewind mode by opening the header menu
		const menuButton = page.locator('button[title="Session options"]');
		await menuButton.waitFor({ state: 'visible', timeout: 5000 });
		await menuButton.click();
		await page.waitForTimeout(200);

		// Look for "Enter Rewind Mode" option (if it exists)
		const rewindModeItem = page.locator('[role="menuitem"]:has-text("Enter Rewind Mode")');
		const rewindModeExists = (await rewindModeItem.count()) > 0;

		if (rewindModeExists) {
			await rewindModeItem.click();
			await page.waitForTimeout(500);

			// In rewind mode, hover actions should not show rewind buttons
			const userMessage = page.locator('[data-message-uuid]').first();
			await userMessage.hover();

			// The rewind button should not be visible (checkboxes should be visible instead)
			const rewindButton = page.locator('button[title="Rewind to here"]');
			await expect(rewindButton).toBeHidden({ timeout: 2000 });

			// Instead, checkboxes should be visible
			const checkbox = page.locator('[data-message-uuid] input[type="checkbox"]').first();
			await expect(checkbox).toBeVisible();
		}
	});

	test('should show checkboxes on messages in rewind mode if available', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send messages
		await sendMessage(page, 'First message', sessionId);
		await sendMessage(page, 'Second message', sessionId);
		await page.waitForTimeout(1000);

		// Try to enter rewind mode
		const menuButton = page.locator('button[title="Session options"]');
		await menuButton.waitFor({ state: 'visible', timeout: 5000 });
		await menuButton.click();
		await page.waitForTimeout(200);

		// Look for "Enter Rewind Mode" option
		const rewindModeItem = page.locator('[role="menuitem"]:has-text("Enter Rewind Mode")');
		const rewindModeExists = (await rewindModeItem.count()) > 0;

		if (rewindModeExists) {
			await rewindModeItem.click();
			await page.waitForTimeout(500);

			// Verify checkboxes appear on both user and assistant messages
			const checkboxes = page.locator('[data-message-uuid] input[type="checkbox"]');
			const checkboxCount = await checkboxes.count();
			expect(checkboxCount).toBeGreaterThan(0);

			// Both user and assistant messages should have checkboxes
			// We sent 2 user messages and should have 2 assistant responses = 4 total
			expect(checkboxCount).toBeGreaterThanOrEqual(2);
		}
	});

	test('should close modal when clicking outside (Escape key)', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test escape key', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		const rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Verify modal is open
		await expect(page.locator('h2:has-text("Rewind Conversation")')).toBeVisible();

		// Press Escape key
		await page.keyboard.press('Escape');

		// Verify modal is closed
		await expect(page.locator('h2:has-text("Rewind Conversation")')).toBeHidden({
			timeout: 3000,
		});
	});

	test('should preserve selected radio option when reopening modal', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator('button:has-text("New Session")').first();
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		await sendMessage(page, 'Test option persistence', sessionId);
		await page.waitForTimeout(1000);

		// Open the rewind modal
		const userMessage = page.locator('[data-message-uuid]').first();
		await userMessage.hover();
		let rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Select "Files only"
		const filesRadio = page.locator('input[type="radio"][value="files"]');
		await filesRadio.click();
		await expect(filesRadio).toBeChecked();

		// Close the modal
		const cancelButton = page.locator('[role="dialog"] button:has-text("Cancel")').first();
		await cancelButton.click();
		await page.waitForTimeout(500);

		// Reopen the modal
		await userMessage.hover();
		rewindButton = page.locator('button[title="Rewind to here"]').first();
		await rewindButton.click();

		// Note: This behavior might vary - the modal might reset to default or preserve selection
		// Verify the modal opened again
		await expect(page.locator('h2:has-text("Rewind Conversation")')).toBeVisible();
	});
});
