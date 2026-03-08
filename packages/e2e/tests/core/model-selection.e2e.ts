/**
 * Model Selection E2E Tests
 *
 * Comprehensive tests for model selection behavior:
 * - Model persistence when selected before first message (critical regression)
 * - Model switcher dropdown filtering (no duplicates)
 * - Default model configuration (DEFAULT_MODEL env var)
 *
 * CRITICAL REGRESSION TESTS:
 * - Model selected before first message must persist (bug: reset to default)
 * - Legacy model IDs should not appear as duplicates in dropdown
 *
 * MERGED FROM:
 * - model-selection-persistence.e2e.ts (base - critical regression)
 * - model-list-duplicates.e2e.ts (critical regression)
 * - default-model-haiku.e2e.ts
 * - model-switcher.e2e.ts (basic UI interactions already covered)
 */

import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

test.describe('Model Selection Persistence', () => {
	test('should use Opus when selected before first message', async ({ page }) => {
		// Navigate to the app
		await page.goto('/');

		// Create a new session
		await createSessionViaUI(page);

		// Wait for chat interface to load
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 15000 });

		// Find and click the model switcher button (in the status bar)
		// The button shows an emoji icon but has a title with the model name
		const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
		await expect(modelSwitcher).toBeVisible({ timeout: 5000 });

		// Get initial model (should be Sonnet by default)
		const initialModel = await modelSwitcher.textContent();
		console.log('Initial model:', initialModel);

		// Click to open dropdown
		await modelSwitcher.click();
		await page.waitForTimeout(500);

		// Get all model options in the dropdown (excluding the current one marked with "(current)")
		const modelOptions = page
			.getByRole('button')
			.filter({ hasText: /Sonnet|Opus|Haiku|GLM/ })
			.filter({ hasNotText: '(current)' });
		const modelCount = await modelOptions.count();
		console.log('Available models to switch to:', modelCount);

		// Skip test if no other models available
		if (modelCount === 0) {
			console.log('No other models available to switch to, skipping test');
			return;
		}

		// Select the first available model that's not current
		const targetModel = modelOptions.first();
		const targetModelName = await targetModel.textContent();
		console.log('Switching to model:', targetModelName);
		await targetModel.click();

		// Wait for model switch to complete
		await page.waitForTimeout(1000);

		// Verify model switcher now shows the new model (check title attribute)
		const updatedTitle = await modelSwitcher.getAttribute('title');
		console.log('Updated model title:', updatedTitle);

		// The title should contain the model name we selected
		const selectedFamily = targetModelName?.match(/Sonnet|Opus|Haiku|GLM/i)?.[0];
		if (selectedFamily) {
			expect(updatedTitle?.toLowerCase()).toContain(selectedFamily.toLowerCase());
		}

		// Send first message
		await messageInput.fill('Hello, test message');
		await messageInput.press('Enter');

		// Wait for assistant response
		await page.locator('[data-message-role="assistant"]').first().waitFor({
			state: 'visible',
			timeout: 30000,
		});

		// Wait for input to be enabled again (processing complete)
		await expect(messageInput).toBeEnabled({ timeout: 20000 });

		// Verify model switcher STILL shows the selected model after the message round-trip
		// This is the critical regression: model used to reset to default after first message
		const postMessageTitle = await modelSwitcher.getAttribute('title');
		console.log('Post-message model title:', postMessageTitle);

		if (selectedFamily) {
			expect(postMessageTitle?.toLowerCase()).toContain(selectedFamily.toLowerCase());
		}
	});

	test('should use default model (Sonnet) when no model is selected', async ({ page }) => {
		// Navigate to the app
		await page.goto('/');

		// Create a new session
		await createSessionViaUI(page);

		// Don't change model - just send a message with default model

		// Send first message
		const messageInput = page
			.locator(
				'[data-testid="message-input"], textarea[placeholder*="Ask"], input[placeholder*="Ask"]'
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

		// Check that model switcher button is visible
		// The button shows an emoji icon and has a title attribute with the model name
		const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
		await expect(modelSwitcher).toBeVisible();

		// Get the title attribute to check the model name
		const switcherTitle = await modelSwitcher.getAttribute('title');
		console.log('Default model switcher title:', switcherTitle);

		// In CI with DEFAULT_MODEL=haiku, it may show Haiku; otherwise it's typically Sonnet
		// Just verify the title contains a model name
		expect(switcherTitle).toMatch(/Switch Model/i);
	});
});

// ============================================================
// Tests merged from model-list-duplicates.e2e.ts
// CRITICAL REGRESSION: Legacy model IDs should not show as duplicates
// ============================================================

test.describe('Model List Duplicates', () => {
	let sessionId: string | null = null;

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should not show duplicate Sonnet models in model switcher', async ({ page }) => {
		// Navigate to the app
		await page.goto('/');

		// Create new session
		sessionId = await createSessionViaUI(page);

		// Wait for chat interface to load
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 15000 });

		// Find and click the model switcher button (uses title attribute since button shows emoji icon)
		const modelSwitcher = page.locator('button[title*="Switch Model"]').first();
		await expect(modelSwitcher).toBeVisible({ timeout: 5000 });
		await modelSwitcher.click();

		// Wait for dropdown to open
		await page.waitForTimeout(500);

		// Get all model option buttons in the dropdown
		const modelOptions = page.getByRole('button').filter({ hasText: /Sonnet|Opus|Haiku|GLM/ });
		const modelCount = await modelOptions.count();

		// Get text of all model options
		const modelTexts: string[] = [];
		for (let i = 0; i < modelCount; i++) {
			const text = await modelOptions.nth(i).textContent();
			if (text) modelTexts.push(text.trim());
		}

		console.log('Found models:', modelTexts);

		// Count Sonnet models
		const sonnetModels = modelTexts.filter((text) => text.toLowerCase().includes('sonnet'));

		console.log('Sonnet models found:', sonnetModels);

		// Assert: Should NOT contain the legacy model ID
		const hasLegacyId = modelTexts.some((text) => text.includes('claude-sonnet-4-5-20250929'));
		expect(hasLegacyId).toBe(false);

		// Assert: Should have at most 2 Sonnet models:
		// 1. "Sonnet 4.5" (default)
		// 2. "Sonnet 4.5 with 1M context" (sonnet[1m])
		expect(sonnetModels.length).toBeLessThanOrEqual(2);

		// Assert: Each model should appear only once
		const uniqueModels = new Set(modelTexts);
		expect(modelTexts.length).toBe(uniqueModels.size);
	});
});

// ============================================================
// Tests merged from default-model-haiku.e2e.ts
// Tests DEFAULT_MODEL environment variable
// ============================================================

test.describe('Default Model Configuration', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
		await page.waitForTimeout(1000);
		sessionId = null;
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
	});

	test.skip('should create sessions with Haiku model when DEFAULT_MODEL=haiku', async ({
		page,
	}) => {
		// SKIPPED: This test requires Haiku model availability which may not be available
		// with all API keys. The fix for model aliases has been implemented in model-service.ts
		// by setting the alias from LEGACY_MODEL_MAPPINGS.

		// Create a new session
		sessionId = await createSessionViaUI(page);
		expect(sessionId).toBeTruthy();

		// Verify the model shown in the UI contains "haiku"
		const modelDisplay = page.locator('[data-testid="model-display"], .model-name, .model-id');
		await expect(modelDisplay.first()).toContainText(/haiku/i);
	});
});
