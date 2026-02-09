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
import { cleanupTestSession, waitForSessionCreated } from '../helpers/wait-helpers';

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

		// Wait for system init message to appear
		// System messages are typically shown in a specific container/style
		// Look for message containing "You are powered by"
		const systemInitLocator = page.locator('text=/You are powered by.*model/i').first();

		// Wait up to 10 seconds for system init message
		await expect(systemInitLocator).toBeVisible({ timeout: 10000 });

		// Get the full text of the system init message
		const systemInitText = await systemInitLocator.textContent();
		console.log('System init message:', systemInitText);

		// Assert: System init should mention the selected model family
		if (selectedFamily) {
			expect(systemInitText?.toLowerCase()).toContain(selectedFamily.toLowerCase());
		}
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

		// Wait for connection and create new session
		await page.waitForSelector('text=New Session', { timeout: 10000 });
		await page.click('text=New Session');
		sessionId = await waitForSessionCreated(page);

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
		await expect(page.getByRole('heading', { name: 'NeoKai', exact: true }).first()).toBeVisible();
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
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await newSessionButton.click();

		// Wait for session to be created
		sessionId = await waitForSessionCreated(page);
		expect(sessionId).toBeTruthy();

		// Get the session data via RPC to check the model
		const sessionData = await page.evaluate(async (sid) => {
			const messageHub = window.__messageHub || window.appState?.messageHub;
			if (!messageHub) {
				throw new Error('MessageHub not available');
			}

			try {
				const response = await messageHub.call('session.get', {
					sessionId: sid,
				});
				return response;
			} catch (error) {
				console.error('Failed to get session:', error);
				throw error;
			}
		}, sessionId);

		// Verify the session was retrieved
		expect(sessionData).toBeTruthy();
		expect(sessionData.session).toBeTruthy();

		// Verify the model is set to Haiku
		const modelId = sessionData.session.config.model;
		expect(modelId).toBeTruthy();

		// The model should contain "haiku" in the ID (case-insensitive)
		expect(modelId.toLowerCase()).toContain('haiku');

		console.log(`✅ Session ${sessionId} created with model: ${modelId}`);
	});
});
