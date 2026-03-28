/**
 * Neo Settings E2E Tests
 *
 * Tests the Neo settings section in Global Settings:
 * - Neo section is visible in Settings navigation
 * - Security mode selector changes and persists across page reload
 * - Model selector shows available models and persists selection
 * - Clear Session button shows confirmation dialog
 * - Confirming clear session resets the Neo chat (toast confirmation)
 * - Canceling clear session preserves the chat (dialog dismissed)
 *
 * Note: Full verification of Neo chat content reset/preservation (subtasks 5–6)
 * requires the Neo Panel slide-out UI (task 7.3), which is not yet implemented.
 * Those tests are marked fixme until the panel renders messages.
 *
 * Setup: no room needed; tests the Global Settings > Neo Agent panel directly.
 */

import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { openSettingsModal } from '../helpers/settings-modal-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Navigate to the Neo Agent section inside the Global Settings panel.
 * Assumes Global Settings is already open.
 */
async function navigateToNeoSection(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Neo Agent', exact: true }).click();
	await expect(page.locator('h3:has-text("Neo Agent")')).toBeVisible({ timeout: 5000 });
}

/**
 * Open Global Settings and navigate straight to the Neo Agent section.
 */
async function openNeoSettings(page: Page): Promise<void> {
	await openSettingsModal(page);
	await navigateToNeoSection(page);
}

/**
 * Return a locator for the Neo Agent section container (h3's parent div).
 * Scoping selectors to this container prevents cross-section interference.
 */
function getNeoSectionLocator(page: Page) {
	return page.locator('h3:has-text("Neo Agent")').locator('..');
}

/**
 * Return the select for a given SettingsRow label within the Neo Agent section.
 *
 * SettingsRow structure:
 *   div.flex                   ← row
 *     div.flex-1
 *       div.text-sm "label"    ← matched by hasText; navigate up to div.flex-1
 *       div.text-xs "desc"
 *     div.flex-shrink-0        ← following-sibling of div.flex-1
 *       select                 ← the control
 *
 * The XPath `../following-sibling::div` walks from the label div up one level
 * (to div.flex-1) and then to its sibling (div.flex-shrink-0), so the result
 * is resilient to row reordering within the Neo section.
 */
function getSelectByLabel(page: Page, label: string) {
	return getNeoSectionLocator(page)
		.locator('div', { hasText: new RegExp(`^${label}$`) })
		.locator('xpath=../following-sibling::div')
		.locator('select');
}

/** Security Mode <select> — identified by its row label. */
function getSecurityModeSelect(page: Page) {
	return getSelectByLabel(page, 'Security Mode');
}

/** Model <select> — identified by its row label. */
function getModelSelect(page: Page) {
	return getSelectByLabel(page, 'Model');
}

// ─── Navigation ───────────────────────────────────────────────────────────────

test.describe('Neo Settings - Navigation', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('should show Neo Agent section in Settings navigation', async ({ page }) => {
		await openSettingsModal(page);
		await expect(page.getByRole('button', { name: 'Neo Agent', exact: true })).toBeVisible();
	});

	test('should display Neo Agent settings content when section is selected', async ({ page }) => {
		await openNeoSettings(page);

		// Section heading
		await expect(page.locator('h3:has-text("Neo Agent")')).toBeVisible();

		// All three setting rows should be present (scoped to avoid sidebar matches)
		const neoSection = getNeoSectionLocator(page);
		await expect(neoSection.locator('text=Security Mode')).toBeVisible();
		await expect(neoSection.locator('div', { hasText: /^Model$/ })).toBeVisible();
		await expect(neoSection.locator('text=Clear Session')).toBeVisible();
	});
});

// ─── Security Mode ────────────────────────────────────────────────────────────

test.describe('Neo Settings - Security Mode', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);
	});

	test('should show security mode selector with expected options', async ({ page }) => {
		const select = getSecurityModeSelect(page);
		await expect(select).toBeVisible();
		await expect(select.locator('option:has-text("Conservative")')).toBeAttached();
		await expect(select.locator('option:has-text("Balanced (default)")')).toBeAttached();
		await expect(select.locator('option:has-text("Autonomous")')).toBeAttached();
	});

	test('should change security mode and show success toast', async ({ page }) => {
		const select = getSecurityModeSelect(page);
		await select.selectOption('conservative');
		await expect(page.locator('text=Security mode updated')).toBeVisible({ timeout: 5000 });
		await expect(select).toHaveValue('conservative');
	});

	test('should persist security mode selection across page reload', async ({ page }) => {
		// Change to autonomous
		await getSecurityModeSelect(page).selectOption('autonomous');
		await expect(page.locator('text=Security mode updated')).toBeVisible({ timeout: 5000 });

		// Reload and re-open Neo settings
		await page.reload();
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);

		// Value should be persisted
		await expect(getSecurityModeSelect(page)).toHaveValue('autonomous');
	});

	test.afterEach(async ({ page }) => {
		// Restore to balanced regardless of test outcome
		try {
			await openNeoSettings(page);
			const select = getSecurityModeSelect(page);
			const current = await select.inputValue();
			if (current !== 'balanced') {
				await select.selectOption('balanced');
				await page
					.locator('text=Security mode updated')
					.waitFor({ state: 'visible', timeout: 5000 });
			}
		} catch {
			// Best-effort cleanup; don't fail the test on cleanup errors
		}
	});
});

// ─── Model Selector ───────────────────────────────────────────────────────────

test.describe('Neo Settings - Model Selector', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);
	});

	test('should show model selector with available options', async ({ page }) => {
		const select = getModelSelect(page);
		await expect(select).toBeVisible();
		await expect(select.locator('option:has-text("App default")')).toBeAttached();
		await expect(select.locator('option:has-text("Claude Sonnet 4")')).toBeAttached();
		await expect(select.locator('option:has-text("Claude Opus 4")')).toBeAttached();
		await expect(select.locator('option:has-text("Claude Haiku 3.5")')).toBeAttached();
	});

	test('should change model and show success toast', async ({ page }) => {
		const select = getModelSelect(page);
		await select.selectOption('sonnet');
		await expect(page.locator('text=Model updated')).toBeVisible({ timeout: 5000 });
		await expect(select).toHaveValue('sonnet');
	});

	test('should persist model selection across page reload', async ({ page }) => {
		// Pick a target value different from whatever is currently set
		const select = getModelSelect(page);
		const current = await select.inputValue();
		const target = current === 'opus' ? 'sonnet' : 'opus';

		await select.selectOption(target);
		await expect(page.locator('text=Model updated')).toBeVisible({ timeout: 5000 });

		// Reload and re-open Neo settings
		await page.reload();
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);

		// Value should be persisted
		await expect(getModelSelect(page)).toHaveValue(target);
	});

	test.afterEach(async ({ page }) => {
		// Restore to app default (empty string) regardless of test outcome
		try {
			await openNeoSettings(page);
			const select = getModelSelect(page);
			const current = await select.inputValue();
			if (current !== '') {
				await select.selectOption('');
				await page.locator('text=Model updated').waitFor({ state: 'visible', timeout: 5000 });
			}
		} catch {
			// Best-effort cleanup; don't fail the test on cleanup errors
		}
	});
});

// ─── Clear Session ────────────────────────────────────────────────────────────

test.describe('Neo Settings - Clear Session', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await openNeoSettings(page);
	});

	test('should show confirmation dialog when Clear Session is clicked', async ({ page }) => {
		await page.getByRole('button', { name: 'Clear Session', exact: true }).click();

		// Confirmation elements should appear
		await expect(page.locator('text=Are you sure?')).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

		// Original button should be replaced
		await expect(page.getByRole('button', { name: 'Clear Session', exact: true })).toBeHidden();
	});

	test('should clear Neo session and show success toast when Confirm is clicked', async ({
		page,
	}) => {
		await page.getByRole('button', { name: 'Clear Session', exact: true }).click();
		await expect(page.locator('text=Are you sure?')).toBeVisible({ timeout: 3000 });

		await page.getByRole('button', { name: 'Confirm', exact: true }).click();

		// Success toast confirms the server-side clear succeeded
		await expect(page.locator('text=Neo session cleared')).toBeVisible({ timeout: 5000 });

		// Dialog dismisses; button restores
		await expect(page.locator('text=Are you sure?')).toBeHidden({ timeout: 3000 });
		await expect(page.getByRole('button', { name: 'Clear Session', exact: true })).toBeVisible({
			timeout: 3000,
		});

		// TODO: once the Neo Panel slide-out (task 7.3) is implemented, add:
		//   1. Send a message via the Neo panel before clicking Clear Session
		//   2. After confirming, open the Neo panel and assert no messages are visible
	});

	test('should dismiss confirmation dialog when Cancel is clicked', async ({ page }) => {
		await page.getByRole('button', { name: 'Clear Session', exact: true }).click();
		await expect(page.locator('text=Are you sure?')).toBeVisible({ timeout: 3000 });

		await page.getByRole('button', { name: 'Cancel', exact: true }).click();

		// Dialog should be dismissed without clearing
		await expect(page.locator('text=Are you sure?')).toBeHidden({ timeout: 3000 });
		await expect(page.getByRole('button', { name: 'Clear Session', exact: true })).toBeVisible({
			timeout: 3000,
		});
		// No toast means no session was cleared
		await expect(page.locator('text=Neo session cleared')).toBeHidden();

		// TODO: once the Neo Panel slide-out (task 7.3) is implemented, add:
		//   1. Send a message via the Neo panel before clicking Clear Session
		//   2. After cancelling, open the Neo panel and assert the message is still present
	});
});
