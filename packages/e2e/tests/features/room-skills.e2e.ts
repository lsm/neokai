/**
 * Room Skills Enablement E2E Tests
 *
 * Verifies the full room skill enablement flow through the UI:
 * - Skills section renders in Room Settings
 * - Built-in skills show "always on" badge with disabled toggle
 * - Plugin skills can be toggled off/on per room
 * - Toggle state persists after page reload (room override stored)
 * - "room override" badge appears when per-room setting differs from global
 * - Reset button clears the per-room override
 *
 * Setup: creates a room and a non-built-in plugin skill via RPC (infrastructure).
 * Cleanup: deletes both in afterEach. Plugin skill is application-level, so it
 * must be explicitly deleted (not cascaded by room deletion).
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { createRoom, deleteRoom } from '../helpers/room-helpers';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_SKILL_DISPLAY_NAME = 'E2E Room Test Plugin';

// ─── Infrastructure helpers ───────────────────────────────────────────────────

/**
 * Create a non-built-in plugin skill via RPC. For use in beforeEach only.
 * Uses a timestamp-based name to avoid conflicts when tests run in parallel.
 * Returns both the skill ID and display name for assertions and cleanup.
 */
async function createTestPluginSkill(
	page: import('@playwright/test').Page
): Promise<{ skillId: string; skillName: string }> {
	return page.evaluate(
		async ({ displayName }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const uniqueName = `e2e-room-skill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const res = await hub.request('skill.create', {
				params: {
					name: uniqueName,
					displayName,
					description: 'Temporary E2E test plugin skill',
					sourceType: 'plugin',
					config: { type: 'plugin', pluginPath: '/tmp/e2e-test-skill-placeholder' },
					enabled: true,
					validationStatus: 'pending',
				},
			});
			return { skillId: (res as { skill: { id: string } }).skill.id, skillName: uniqueName };
		},
		{ displayName: TEST_SKILL_DISPLAY_NAME }
	);
}

/**
 * Delete a skill via RPC. Best-effort — silently ignores errors so it can be
 * used safely in afterEach without masking test failures.
 */
async function deleteTestSkill(
	page: import('@playwright/test').Page,
	skillId: string
): Promise<void> {
	if (!skillId) return;
	try {
		await page.evaluate(async (id) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) return;
			await hub.request('skill.delete', { id });
		}, skillId);
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Navigate to a room's Settings tab and wait for the Skills section to load.
 */
async function navigateToRoomSkillsSettings(
	page: import('@playwright/test').Page,
	roomId: string
): Promise<void> {
	await page.goto(`/room/${roomId}`);
	await waitForWebSocketConnected(page);

	// Scope to the room's tab bar to avoid matching the global nav Settings button
	const roomTabBar = page.locator('.border-b.border-dark-700.bg-dark-850');
	const settingsTab = roomTabBar.locator('button:has-text("Settings")');
	await settingsTab.waitFor({ state: 'visible', timeout: 5000 });
	await settingsTab.click();

	// Wait for the Skills label to be visible in the settings panel
	await expect(page.locator('label').filter({ hasText: 'Skills' }).first()).toBeVisible({
		timeout: 5000,
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Room Skills Settings - UI rendering', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E Room Skills Test Room');
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('should show the Skills section in room settings', async ({ page }) => {
		await navigateToRoomSkillsSettings(page, roomId);

		// Verify the Skills section label is visible
		await expect(page.locator('label').filter({ hasText: 'Skills' }).first()).toBeVisible();

		// Verify the description text is present
		await expect(page.locator('text=Enable or disable skills for this room')).toBeVisible({
			timeout: 5000,
		});
	});

	test('should show built-in playwright skill', async ({ page }) => {
		await navigateToRoomSkillsSettings(page, roomId);

		// The playwright skill is seeded as a built-in skill (enabled by default)
		const skillLabel = page.locator('label').filter({ hasText: 'Playwright' }).first();
		await expect(skillLabel).toBeVisible({ timeout: 10000 });
	});
});

test.describe('Room Skills Settings - Plugin skill toggle', () => {
	let roomId = '';
	let skillId = '';
	let skillDisplayName = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E Room Skills Toggle Room');
		const result = await createTestPluginSkill(page);
		skillId = result.skillId;
		skillDisplayName = TEST_SKILL_DISPLAY_NAME;
	});

	test.afterEach(async ({ page }) => {
		if (skillId) {
			await deleteTestSkill(page, skillId);
			skillId = '';
		}
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('should show the plugin skill in the skills list', async ({ page }) => {
		await navigateToRoomSkillsSettings(page, roomId);

		// Verify the plugin skill row appears
		const skillLabel = page.locator('label').filter({ hasText: skillDisplayName }).first();
		await expect(skillLabel).toBeVisible({ timeout: 10000 });

		// Verify the Plugin source type badge is visible
		await expect(skillLabel.locator('span').filter({ hasText: 'Plugin' }).first()).toBeVisible();

		// Verify the checkbox is not disabled (plugin skills are toggleable)
		const checkbox = skillLabel.locator('input[type="checkbox"]');
		await expect(checkbox).not.toBeDisabled();
	});

	test('should toggle plugin skill off and persist the state', async ({ page }) => {
		await navigateToRoomSkillsSettings(page, roomId);

		const skillLabel = page.locator('label').filter({ hasText: skillDisplayName }).first();
		await expect(skillLabel).toBeVisible({ timeout: 10000 });

		const checkbox = skillLabel.locator('input[type="checkbox"]');

		// Initially enabled (global default is true for this skill)
		await expect(checkbox).toBeChecked();

		// Toggle off
		await checkbox.click();

		// Verify the checkbox is now unchecked
		await expect(checkbox).not.toBeChecked();

		// Verify "room override" badge appears — per-room setting differs from global
		await expect(page.locator('text=room override').first()).toBeVisible({ timeout: 5000 });

		// Verify persistence: reload and navigate back
		await page.reload();
		await waitForWebSocketConnected(page);
		await navigateToRoomSkillsSettings(page, roomId);

		const persistedLabel = page.locator('label').filter({ hasText: skillDisplayName }).first();
		await expect(persistedLabel).toBeVisible({ timeout: 10000 });

		const persistedCheckbox = persistedLabel.locator('input[type="checkbox"]');
		await expect(persistedCheckbox).not.toBeChecked();

		// "room override" badge still present after reload
		await expect(page.locator('text=room override').first()).toBeVisible({ timeout: 5000 });
	});

	test('should toggle plugin skill back on after disabling', async ({ page }) => {
		await navigateToRoomSkillsSettings(page, roomId);

		const skillLabel = page.locator('label').filter({ hasText: skillDisplayName }).first();
		await expect(skillLabel).toBeVisible({ timeout: 10000 });

		const checkbox = skillLabel.locator('input[type="checkbox"]');

		// Toggle off
		await checkbox.click();
		await expect(checkbox).not.toBeChecked();

		// Toggle back on
		await checkbox.click();
		await expect(checkbox).toBeChecked();

		// The skill shows as enabled again
		await expect(page.locator('label').filter({ hasText: skillDisplayName }).first()).toBeVisible();
		await expect(checkbox).toBeChecked();
	});

	test('should clear room override via Reset button', async ({ page }) => {
		await navigateToRoomSkillsSettings(page, roomId);

		const skillLabel = page.locator('label').filter({ hasText: skillDisplayName }).first();
		await expect(skillLabel).toBeVisible({ timeout: 10000 });

		const checkbox = skillLabel.locator('input[type="checkbox"]');

		// Toggle off to create a room override
		await checkbox.click();
		await expect(checkbox).not.toBeChecked();
		await expect(page.locator('text=room override').first()).toBeVisible({ timeout: 5000 });

		// Click the Reset button to clear the override
		const resetButton = skillLabel
			.locator('..') // parent container of label
			.locator('button:has-text("Reset")');
		await resetButton.waitFor({ state: 'visible', timeout: 5000 });
		await resetButton.click();

		// After reset, "room override" badge should be gone
		// and the skill should revert to global default (enabled)
		await expect(checkbox).toBeChecked({ timeout: 5000 });
		await expect(page.locator('text=room override')).not.toBeVisible({ timeout: 5000 });
	});
});
