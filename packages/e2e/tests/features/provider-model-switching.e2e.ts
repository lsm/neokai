/**
 * Provider / Model Switching E2E Tests
 *
 * Two suites that cover provider-related UI behaviour:
 *
 * Suite A – "Model picker UI rendering"
 *   Works with any single provider.  Verifies static rendering: model name visible
 *   in the session status bar, dropdown opens, models are grouped by provider, and
 *   provider labels appear as group headers.
 *
 * Suite B – "Cross-provider model switching"
 *   Requires at least two configured providers.  Verifies that switching to a model
 *   from a different provider updates the provider badge and that the session
 *   continues to work (sends a message, gets a response).
 *   If only one provider is available the suite FAILS with a clear message — it
 *   does NOT silently skip (hard-fail rule from CLAUDE.md).
 */

import { test, expect } from '../../fixtures';
import {
	setupMessageHubTesting,
	createSessionViaUI,
	cleanupTestSession,
	waitForAssistantResponse,
} from '../helpers/wait-helpers';

// ---------------------------------------------------------------------------
// Suite A: Model picker UI rendering
// ---------------------------------------------------------------------------
test.describe('Model picker UI rendering', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
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

	test('model name is visible in the session status bar', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		// The model switcher button title is "Switch Model (<name>)" once a model
		// is loaded.  We accept the plain "Switch Model" title too (e.g. when the
		// daemon defaults are unknown), but at minimum the button must exist.
		const modelBtn = page.locator('button[title^="Switch Model"]');
		await expect(modelBtn).toBeVisible({ timeout: 10000 });
	});

	test('model picker dropdown opens when clicking the model button', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		const modelBtn = page.locator('button[title^="Switch Model"]');
		await expect(modelBtn).toBeVisible({ timeout: 10000 });
		await modelBtn.click();

		// The dropdown header "Select Model" should be visible
		await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });
	});

	test('models are grouped by provider with provider headers', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		const modelBtn = page.locator('button[title^="Switch Model"]');
		await expect(modelBtn).toBeVisible({ timeout: 10000 });
		await modelBtn.click();

		// Wait for dropdown
		await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });

		// At least one provider group header (uppercase text in dropdown, smaller font)
		// They are rendered as: <span class="... text-[10px] font-semibold text-gray-400 uppercase ...">
		const providerHeaders = page.locator(
			'[class*="text-gray-400"][class*="uppercase"], [class*="font-semibold"][class*="uppercase"]'
		);
		const headerCount = await providerHeaders.count();
		expect(headerCount).toBeGreaterThan(0);
	});

	test('closing the dropdown by clicking the model button again hides it', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		const modelBtn = page.locator('button[title^="Switch Model"]');
		await expect(modelBtn).toBeVisible({ timeout: 10000 });

		// Open dropdown
		await modelBtn.click();
		await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });

		// Click the same button again to close (toggle)
		await modelBtn.click();

		// Dropdown should disappear
		await expect(page.locator('text=Select Model')).toBeHidden({ timeout: 5000 });
	});

	test('provider badge is visible next to the model button', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		// The ProviderBadge renders a span[data-testid="provider-badge"]
		const badge = page.locator('[data-testid="provider-badge"]');
		await expect(badge).toBeVisible({ timeout: 10000 });
	});
});

// ---------------------------------------------------------------------------
// Suite B: Cross-provider model switching
// ---------------------------------------------------------------------------
test.describe('Cross-provider model switching', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
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

	/**
	 * Helper: open the model dropdown and return the provider group labels visible
	 * in the dropdown.  The caller is responsible for ensuring the dropdown is open
	 * before calling helpers that read it.
	 */
	async function openDropdownAndGetProviderGroups(
		page: import('@playwright/test').Page
	): Promise<string[]> {
		const modelBtn = page.locator('button[title^="Switch Model"]');
		await expect(modelBtn).toBeVisible({ timeout: 10000 });
		await modelBtn.click();
		await expect(page.locator('text=Select Model')).toBeVisible({ timeout: 5000 });

		// Provider labels are <span> with uppercase + small font inside the dropdown.
		// We locate the dropdown container first so we don't pick up stray labels.
		const dropdown = page.locator('div:has(> div:has-text("Select Model"))').last();
		const headers = dropdown.locator(
			'span[class*="uppercase"][class*="text-gray-400"], span[class*="uppercase"][class*="font-semibold"]'
		);
		const count = await headers.count();
		const labels: string[] = [];
		for (let i = 0; i < count; i++) {
			const text = (await headers.nth(i).textContent()) ?? '';
			if (text.trim()) labels.push(text.trim());
		}
		return labels;
	}

	test('requires at least 2 providers — fails clearly when only one is configured', async ({
		page,
	}) => {
		sessionId = await createSessionViaUI(page);

		const providerGroups = await openDropdownAndGetProviderGroups(page);

		// HARD FAIL — no silent skipping (see CLAUDE.md "Hard Fail Rule")
		expect(
			providerGroups.length,
			'Cross-provider switch test requires at least 2 configured providers. ' +
				`Found providers: [${providerGroups.join(', ')}]. ` +
				'Configure a second provider (e.g. anthropic-copilot or anthropic-codex) to run this suite.'
		).toBeGreaterThan(1);
	});

	test('provider badge updates after switching to a model from a different provider', async ({
		page,
	}) => {
		sessionId = await createSessionViaUI(page);

		// Read the current provider badge label (aria-label = provider display name)
		const badge = page.locator('[data-testid="provider-badge"]');
		await expect(badge).toBeVisible({ timeout: 10000 });
		const initialProvider = await badge.getAttribute('aria-label');

		// Open the dropdown and collect provider groups
		const providerGroups = await openDropdownAndGetProviderGroups(page);

		// Hard fail if only one provider
		expect(
			providerGroups.length,
			'Cross-provider switch test requires at least 2 configured providers. ' +
				`Found providers: [${providerGroups.join(', ')}]. ` +
				'Configure a second provider (e.g. anthropic-copilot or anthropic-codex) to run this suite.'
		).toBeGreaterThan(1);

		// Find a provider group different from the current one
		const targetProvider = providerGroups.find(
			(label) => label.toLowerCase() !== (initialProvider ?? '').toLowerCase()
		);
		expect(targetProvider).toBeTruthy();

		// Click the first model under the target provider group.
		// Provider group headers are followed immediately by model buttons inside the
		// same parent <div>.  We select the first button in that section.
		const dropdown = page.locator('div:has(> div:has-text("Select Model"))').last();
		const targetHeader = dropdown
			.locator(
				'span[class*="uppercase"][class*="text-gray-400"], span[class*="uppercase"][class*="font-semibold"]'
			)
			.filter({ hasText: targetProvider! });

		// The header is inside a wrapper div; sibling model buttons follow.
		// Navigate: header span → parent div (provider section) → first model button
		const modelBtn = targetHeader.locator('xpath=ancestor::div[1]/following-sibling::button[1]');
		await expect(modelBtn).toBeVisible({ timeout: 5000 });
		await modelBtn.click();

		// Wait for the dropdown to close (model switching in progress / complete)
		await expect(page.locator('text=Select Model')).toBeHidden({ timeout: 10000 });

		// The provider badge aria-label should now reflect the new provider
		await expect(badge).toBeVisible({ timeout: 10000 });
		const newProvider = await badge.getAttribute('aria-label');
		expect(newProvider).not.toEqual(initialProvider);
	});

	test('session continues working after cross-provider model switch', async ({ page }) => {
		sessionId = await createSessionViaUI(page);

		// Check provider groups first
		const providerGroups = await openDropdownAndGetProviderGroups(page);

		// Hard fail if only one provider
		expect(
			providerGroups.length,
			'Cross-provider switch test requires at least 2 configured providers. ' +
				`Found providers: [${providerGroups.join(', ')}]. ` +
				'Configure a second provider (e.g. anthropic-copilot or anthropic-codex) to run this suite.'
		).toBeGreaterThan(1);

		const badge = page.locator('[data-testid="provider-badge"]');
		const initialProvider = await badge.getAttribute('aria-label');

		// Pick a different provider's first model
		const targetProvider = providerGroups.find(
			(label) => label.toLowerCase() !== (initialProvider ?? '').toLowerCase()
		);
		const dropdown = page.locator('div:has(> div:has-text("Select Model"))').last();
		const targetHeader = dropdown
			.locator(
				'span[class*="uppercase"][class*="text-gray-400"], span[class*="uppercase"][class*="font-semibold"]'
			)
			.filter({ hasText: targetProvider! });
		const switchBtn = targetHeader.locator('xpath=ancestor::div[1]/following-sibling::button[1]');
		await expect(switchBtn).toBeVisible({ timeout: 5000 });
		await switchBtn.click();

		// Wait for switch to complete
		await expect(page.locator('text=Select Model')).toBeHidden({ timeout: 10000 });

		// Verify badge updated
		await expect(badge).toBeVisible({ timeout: 10000 });
		const newProvider = await badge.getAttribute('aria-label');
		expect(newProvider).not.toEqual(initialProvider);

		// Send a simple message and verify the session produces a response
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeEnabled({ timeout: 10000 });
		await textarea.fill('Reply with exactly: OK');
		await page.keyboard.press('Meta+Enter');

		// An assistant message should appear
		await waitForAssistantResponse(page, { timeout: 90000 });

		// Session input should be re-enabled, meaning the session is still functional
		await expect(textarea).toBeEnabled({ timeout: 20000 });
	});
});
