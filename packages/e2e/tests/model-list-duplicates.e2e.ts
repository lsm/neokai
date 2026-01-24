/**
 * E2E Test: Model List Should Not Contain Duplicate Sonnet Models
 *
 * Tests that legacy model IDs like "claude-sonnet-4-5-20250929" are filtered out
 * to prevent duplicates in the model switcher dropdown.
 */

import { test, expect } from '@playwright/test';

test.describe('Model List Duplicates', () => {
	test('should not show duplicate Sonnet models in model switcher', async ({ page }) => {
		// Navigate to the app
		await page.goto('/');

		// Wait for connection and create new session
		await page.waitForSelector('text=New Session', { timeout: 10000 });
		await page.click('text=New Session');

		// Wait for chat interface to load
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(messageInput).toBeVisible({ timeout: 15000 });

		// Find and click the model switcher button
		const modelSwitcher = page
			.locator('button')
			.filter({ hasText: /Sonnet|Opus|Haiku/ })
			.first();
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
