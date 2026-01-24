/**
 * E2E Test: Model Selection Should Persist When Creating New Session
 *
 * Tests that when a user selects Opus before sending the first message,
 * the system init message correctly shows Opus (not Sonnet).
 */

import { test, expect } from '@playwright/test';

test.describe('Model Selection Persistence', () => {
	test('should use Opus when selected before first message', async ({ page }) => {
		// Navigate to the app
		await page.goto('/');

		// Wait for connection
		await page.waitForSelector('text=New Session', { timeout: 10000 });

		// Create a new session
		await page.click('text=New Session');

		// Wait for session to be created and chat interface to load
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 15000 });

		// Find and click the model switcher button (in the status bar)
		// It should be a button that shows the current model name
		const modelSwitcher = page
			.locator('button')
			.filter({ hasText: /Sonnet|Opus|Haiku/ })
			.first();
		await expect(modelSwitcher).toBeVisible({ timeout: 5000 });

		// Get initial model (should be Sonnet by default)
		const initialModel = await modelSwitcher.textContent();
		console.log('Initial model:', initialModel);

		// Click to open dropdown
		await modelSwitcher.click();
		await page.waitForTimeout(500);

		// Select Opus model from the dropdown
		const opusOption = page.getByRole('button', { name: /Opus/i });
		await expect(opusOption).toBeVisible({ timeout: 2000 });
		await opusOption.click();

		// Wait for model switch to complete
		await page.waitForTimeout(1000);

		// Verify model switcher now shows Opus
		const updatedModel = await modelSwitcher.textContent();
		console.log('Updated model:', updatedModel);
		expect(updatedModel).toMatch(/Opus/i);

		// Send first message
		await messageInput.fill('Hello, test message');
		await messageInput.press('Enter');

		// Wait for system init message to appear
		// System messages are typically shown in a specific container/style
		// Look for message containing "You are powered by"
		const systemInitLocator = page.locator('text=/You are powered by.*model/i').first();

		// Wait up to 10 seconds for system init message
		await expect(systemInitLocator).toBeVisible({ timeout: 10000 });

		// Get the full text of the system init message
		const systemInitText = await systemInitLocator.textContent();
		console.log('System init message:', systemInitText);

		// Assert: System init should mention Opus
		expect(systemInitText?.toLowerCase()).toContain('opus');

		// Assert: System init should NOT mention Sonnet
		expect(systemInitText?.toLowerCase()).not.toContain('sonnet');
	});

	test('should use default model (Sonnet) when no model is selected', async ({ page }) => {
		// Navigate to the app
		await page.goto('/');

		// Wait for connection
		await page.waitForSelector('text=New Session', { timeout: 10000 });

		// Create a new session
		await page.click('text=New Session');

		// Wait for session to be created and chat interface to load
		await page.waitForSelector(
			'[data-testid="message-input"], textarea[placeholder*="message"], input[placeholder*="message"]',
			{ timeout: 15000 }
		);

		// Don't change model - just send a message with default model

		// Send first message
		const messageInput = page
			.locator(
				'[data-testid="message-input"], textarea[placeholder*="message"], input[placeholder*="message"]'
			)
			.first();
		await messageInput.fill('Hello');

		// Find and click send button
		const sendButton = page
			.locator('[data-testid="send-button"], button[type="submit"], button:has-text("Send")')
			.first();
		await sendButton.click();

		// Wait for response
		await page.waitForTimeout(3000);

		// Check that model switcher shows Sonnet (default)
		const modelSwitcher = page
			.locator(
				'[data-testid="model-switcher"], button:has-text("Sonnet"), button:has-text("Opus"), button:has-text("Haiku")'
			)
			.first();
		await expect(modelSwitcher).toBeVisible();

		// Default should be Sonnet
		const switcherText = await modelSwitcher.textContent();
		console.log('Default model switcher text:', switcherText);

		// Should contain "Sonnet" or "default" but not "Opus"
		expect(switcherText?.toLowerCase()).toMatch(/sonnet|default/);
	});
});
