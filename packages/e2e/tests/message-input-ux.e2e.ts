/**
 * Message Input UX E2E Tests
 *
 * Tests the recent UX improvements to the message input component:
 * - Plus button remains enabled during processing
 * - Model switcher is disabled during processing
 * - Textarea allows typing during processing (but send is disabled)
 * - Send button alignment with multiline input
 * - Autoscroll toggle is in plus menu (no standalone button)
 * - Larger stop button icon
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Message Input UX Improvements', () => {
	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
	});

	test('should keep plus button enabled during processing', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Send a message to trigger processing
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Write a detailed essay about quantum computing.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);

		// Wait for stop button to appear (confirms processing started)
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });

		// Plus button should still be enabled (not disabled)
		const plusButton = page.locator('button[title="More options"]');
		await expect(plusButton).toBeVisible();
		await expect(plusButton).toBeEnabled();

		// Plus button should not have disabled classes
		const classes = await plusButton.getAttribute('class');
		expect(classes).not.toContain('cursor-not-allowed');
		expect(classes).not.toContain('opacity-50');

		// Click plus button to verify it opens menu
		await plusButton.click();
		await page.waitForTimeout(200);

		// Menu should be visible
		const menu = page.locator('div:has(> button:has-text("Auto-scroll"))').first();
		await expect(menu).toBeVisible();

		// Interrupt to clean up
		await page.click('[data-testid="stop-button"]');
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});

	test('should disable model switcher during processing', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Send a message to trigger processing
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Explain machine learning in detail.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });

		// Open plus menu
		const plusButton = page.locator('button[title="More options"]');
		await plusButton.click();
		await page.waitForTimeout(200);

		// Find model switcher button in menu
		const modelSwitcherInMenu = page
			.locator(
				'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
			)
			.first();

		// Model switcher should be visible but have opacity-50 (disabled visual)
		await expect(modelSwitcherInMenu).toBeVisible();
		const classes = await modelSwitcherInMenu.getAttribute('class');
		expect(classes).toContain('opacity-50');
		expect(classes).toContain('cursor-not-allowed');

		// Should also be disabled at DOM level
		await expect(modelSwitcherInMenu).toBeDisabled();

		// Close menu
		await page.keyboard.press('Escape');

		// Interrupt to clean up
		await page.click('[data-testid="stop-button"]');
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});

	test('should allow typing in textarea during processing', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Send a message to trigger processing
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Explain neural networks.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });

		// Textarea should be enabled (allowing typing)
		await expect(messageInput).toBeEnabled();

		// Type text in textarea
		const testText = 'This is a follow-up question.';
		await messageInput.fill(testText);

		// Verify text appears in textarea
		const inputValue = await messageInput.inputValue();
		expect(inputValue).toBe(testText);

		// Send button should NOT be visible (stop button is shown instead)
		await expect(page.locator('[data-testid="send-button"]')).not.toBeVisible();

		// Stop button should be visible (confirming we can't send while processing)
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible();

		// Interrupt to clean up
		await page.click('[data-testid="stop-button"]');
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});

	test('should align send button to bottom with multiline input', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Type multiline text to expand textarea
		const messageInput = await waitForElement(page, 'textarea');
		const multilineText = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
		await messageInput.fill(multilineText);

		// Wait for textarea to auto-resize
		await page.waitForTimeout(500);

		// Get bounding boxes
		const textareaBox = await messageInput.boundingBox();
		const sendButton = page.locator('[data-testid="send-button"]');
		const sendButtonBox = await sendButton.boundingBox();

		expect(textareaBox).not.toBeNull();
		expect(sendButtonBox).not.toBeNull();

		if (textareaBox && sendButtonBox) {
			// Send button bottom should be near textarea bottom (within 10px)
			const textareaBottom = textareaBox.y + textareaBox.height;
			const sendButtonBottom = sendButtonBox.y + sendButtonBox.height;

			const verticalDistance = Math.abs(textareaBottom - sendButtonBottom);

			// Send button should be positioned at bottom of textarea (within 10px tolerance)
			expect(verticalDistance).toBeLessThan(10);

			// Additionally verify textarea expanded (height > 40px)
			expect(textareaBox.height).toBeGreaterThan(40);
		}

		await cleanupTestSession(page, sessionId);
	});

	test('should not show standalone autoscroll button', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Wait for input to be ready
		await waitForElement(page, 'textarea');

		// Look for standalone autoscroll button (should NOT exist)
		// The old implementation had a button with title containing "Auto-scroll" outside the menu
		const standaloneAutoScrollButton = page.locator(
			'button[title*="Auto-scroll"]:not(:has-text("More options"))'
		);

		// Count should be 0 (no standalone button)
		const count = await standaloneAutoScrollButton.count();
		expect(count).toBe(0);

		// Open plus menu
		const plusButton = page.locator('button[title="More options"]');
		await plusButton.click();
		await page.waitForTimeout(200);

		// Autoscroll toggle should exist INSIDE the menu
		const autoScrollInMenu = page.locator('button:has-text("Auto-scroll")');
		await expect(autoScrollInMenu).toBeVisible();

		await cleanupTestSession(page, sessionId);
	});

	test('should show larger interrupt button icon', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Send a message to trigger processing
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Write a comprehensive guide to distributed systems.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);

		// Stop button should appear
		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 5000 });

		// Get the SVG inside stop button
		const svg = stopButton.locator('svg').first();
		await expect(svg).toBeVisible();

		// Verify SVG has w-4 h-4 class (not w-3.5 h-3.5)
		const svgClasses = await svg.getAttribute('class');
		expect(svgClasses).toContain('w-4');
		expect(svgClasses).toContain('h-4');
		expect(svgClasses).not.toContain('w-3.5');
		expect(svgClasses).not.toContain('h-3.5');

		// Interrupt to clean up
		await stopButton.click();
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});

	test('should allow clicking plus button and then typing while processing', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// Send a message to trigger processing
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Explain the CAP theorem.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });

		// Click plus button (should work)
		const plusButton = page.locator('button[title="More options"]');
		await plusButton.click();
		await page.waitForTimeout(200);

		// Menu should be visible
		const menu = page.locator('div:has(> button:has-text("Auto-scroll"))').first();
		await expect(menu).toBeVisible();

		// Close menu
		await page.keyboard.press('Escape');
		await page.waitForTimeout(200);

		// Type in textarea (should work)
		const newText = 'Follow-up about consistency.';
		await messageInput.fill(newText);

		// Verify text was entered
		const inputValue = await messageInput.inputValue();
		expect(inputValue).toBe(newText);

		// Interrupt to clean up
		await page.click('[data-testid="stop-button"]');
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});

	test('should show visual feedback when model switcher is disabled during processing', async ({
		page,
	}) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		// First check enabled state (before processing)
		const plusButton = page.locator('button[title="More options"]');
		await plusButton.click();
		await page.waitForTimeout(200);

		const modelSwitcherBefore = page
			.locator(
				'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
			)
			.first();
		const classesBeforeProcessing = await modelSwitcherBefore.getAttribute('class');

		// Should NOT have disabled styling before processing
		expect(classesBeforeProcessing).not.toContain('opacity-50');
		expect(classesBeforeProcessing).not.toContain('cursor-not-allowed');

		// Close menu
		await page.keyboard.press('Escape');

		// Send a message to trigger processing
		const messageInput = await waitForElement(page, 'textarea');
		await messageInput.fill('Explain consensus algorithms.');
		await page.click('[data-testid="send-button"]');

		// Wait for processing to start
		await page.waitForTimeout(1000);
		await expect(page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 5000 });

		// Open plus menu again
		await plusButton.click();
		await page.waitForTimeout(200);

		// Check model switcher styling during processing
		const modelSwitcherDuringProcessing = page
			.locator(
				'button:has-text("Select Model"), button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
			)
			.first();
		const classesDuringProcessing = await modelSwitcherDuringProcessing.getAttribute('class');

		// Should have disabled styling during processing
		expect(classesDuringProcessing).toContain('opacity-50');
		expect(classesDuringProcessing).toContain('cursor-not-allowed');

		// Interrupt to clean up
		await page.keyboard.press('Escape');
		await page.click('[data-testid="stop-button"]');
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});

	test('should maintain send button size consistency across states', async ({ page }) => {
		// Create a session
		await page.click('button:has-text("New Session")');
		const sessionId = await waitForSessionCreated(page);

		const messageInput = await waitForElement(page, 'textarea');

		// Get send button dimensions when disabled (no content)
		const sendButtonDisabled = page.locator('[data-testid="send-button"]');
		const disabledBox = await sendButtonDisabled.boundingBox();

		// Type content to enable send button
		await messageInput.fill('Test message');
		await page.waitForTimeout(200);

		// Get send button dimensions when enabled
		const enabledBox = await sendButtonDisabled.boundingBox();

		expect(disabledBox).not.toBeNull();
		expect(enabledBox).not.toBeNull();

		if (disabledBox && enabledBox) {
			// Dimensions should be consistent (w-7 h-7 = 28px)
			expect(disabledBox.width).toBeCloseTo(enabledBox.width, 1);
			expect(disabledBox.height).toBeCloseTo(enabledBox.height, 1);

			// Should be roughly 28px (7 * 4px)
			expect(enabledBox.width).toBeGreaterThanOrEqual(26);
			expect(enabledBox.width).toBeLessThanOrEqual(30);
			expect(enabledBox.height).toBeGreaterThanOrEqual(26);
			expect(enabledBox.height).toBeLessThanOrEqual(30);
		}

		// Send message and check stop button dimensions
		await page.click('[data-testid="send-button"]');
		await page.waitForTimeout(1000);

		const stopButton = page.locator('[data-testid="stop-button"]');
		await expect(stopButton).toBeVisible({ timeout: 5000 });

		const stopButtonBox = await stopButton.boundingBox();
		expect(stopButtonBox).not.toBeNull();

		if (stopButtonBox && enabledBox) {
			// Stop button should have same dimensions as send button
			expect(stopButtonBox.width).toBeCloseTo(enabledBox.width, 1);
			expect(stopButtonBox.height).toBeCloseTo(enabledBox.height, 1);
		}

		// Interrupt to clean up
		await stopButton.click();
		await page.waitForTimeout(1000);

		await cleanupTestSession(page, sessionId);
	});
});
