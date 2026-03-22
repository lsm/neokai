/**
 * Mission Creation E2E Tests
 *
 * Verifies type-specific mission creation UI:
 * - Creating a measurable mission with metrics
 * - Creating a recurring mission with schedule
 * - Autonomy level selector
 *
 * Setup: creates a room via RPC (infrastructure), then tests the UI.
 * Cleanup: deletes the room via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom, openMissionsTab } from '../helpers/room-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createRoom(page: Parameters<typeof waitForWebSocketConnected>[0]): Promise<string> {
	await waitForWebSocketConnected(page);
	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('room.create', {
			name: 'E2E Mission Creation Test Room',
		});
		return (res as { room: { id: string } }).room.id;
	});
}

async function openCreateMissionModal(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<void> {
	// Click the "Create Mission" button in the sidebar
	const createButtons = page.locator('button:has-text("Create Mission")');
	await expect(createButtons.first()).toBeVisible({ timeout: 5000 });
	await createButtons.first().click();
	// Wait for modal to appear — modal has wizard-goal-title input (step 1)
	await expect(page.locator('#wizard-goal-title')).toBeVisible({ timeout: 5000 });
}

/**
 * Advance the Create Mission wizard from step 1 to step 2.
 * Call this after filling in the title on step 1.
 */
async function advanceToStep2(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<void> {
	const nextButton = page.getByRole('button', { name: 'Next \u2192' });
	await expect(nextButton).toBeVisible({ timeout: 5000 });
	await nextButton.click();
	// Wait for step 2 to be visible
	await expect(page.locator('[data-testid="mission-type-one_shot"]')).toBeVisible({
		timeout: 5000,
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Mission Creation', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		roomId = await createRoom(page);
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('should show mission type selector in create form', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await openCreateMissionModal(page);

		// Fill in title on step 1 and advance to step 2
		await page.locator('#wizard-goal-title').fill('Test Mission');
		await advanceToStep2(page);

		// All three mission type buttons should be visible
		await expect(page.locator('[data-testid="mission-type-one_shot"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[data-testid="mission-type-measurable"]')).toBeVisible();
		await expect(page.locator('[data-testid="mission-type-recurring"]')).toBeVisible();
	});

	test('should show autonomy level selector in create form', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await openCreateMissionModal(page);

		// Fill in title on step 1 and advance to step 2
		await page.locator('#wizard-goal-title').fill('Test Mission');
		await advanceToStep2(page);

		await expect(page.locator('[data-testid="autonomy-supervised"]')).toBeVisible({
			timeout: 5000,
		});
		await expect(page.locator('[data-testid="autonomy-semi_autonomous"]')).toBeVisible();
	});

	test('should show metrics section when measurable type is selected', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await openCreateMissionModal(page);

		// Fill in title on step 1 and advance to step 2
		await page.locator('#wizard-goal-title').fill('Test Mission');
		await advanceToStep2(page);

		// Select measurable type
		await page.locator('[data-testid="mission-type-measurable"]').click();

		// Metrics section should appear
		await expect(page.locator('[data-testid="metrics-section"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="add-metric-btn"]')).toBeVisible();
	});

	test('should create a measurable mission with metrics', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await openCreateMissionModal(page);

		// Fill in title on step 1 and advance to step 2
		await page.locator('#wizard-goal-title').fill('Track Test Coverage');
		await advanceToStep2(page);

		// Select measurable type
		await page.locator('[data-testid="mission-type-measurable"]').click();

		// Add a metric
		await page.locator('[data-testid="add-metric-btn"]').click();

		// Fill in the metric name
		const metricNameInput = page.locator('[aria-label="Metric 1 name"]');
		await expect(metricNameInput).toBeVisible({ timeout: 5000 });
		await metricNameInput.fill('Test Coverage');

		// Fill in target
		const metricTargetInput = page.locator('[aria-label="Metric 1 target"]');
		await metricTargetInput.fill('90');

		// Fill in unit
		const metricUnitInput = page.locator('[aria-label="Metric 1 unit"]');
		await metricUnitInput.fill('%');

		// Submit the form
		await page.getByRole('button', { name: 'Create', exact: true }).click();

		// The mission should appear in the list
		await expect(page.locator('h4:has-text("Track Test Coverage")')).toBeVisible({ timeout: 8000 });

		// Measurable badge should be visible
		await expect(
			page.locator('[data-testid="mission-type-badge"]:has-text("Measurable")')
		).toBeVisible({ timeout: 5000 });
	});

	test('should show schedule section when recurring type is selected', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await openCreateMissionModal(page);

		// Fill in title on step 1 and advance to step 2
		await page.locator('#wizard-goal-title').fill('Test Mission');
		await advanceToStep2(page);

		// Select recurring type
		await page.locator('[data-testid="mission-type-recurring"]').click();

		// Schedule section should appear
		await expect(page.locator('[data-testid="schedule-section"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="schedule-preset"]')).toBeVisible();
		await expect(page.locator('[data-testid="timezone-select"]')).toBeVisible();
	});

	test('should create a recurring mission with daily schedule', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await openCreateMissionModal(page);

		// Fill in title on step 1 and advance to step 2
		await page.locator('#wizard-goal-title').fill('Daily Health Check');
		await advanceToStep2(page);

		// Select recurring type
		await page.locator('[data-testid="mission-type-recurring"]').click();

		// Schedule preset defaults to @daily — leave it
		// Timezone defaults to UTC — leave it

		// Submit the form
		await page.getByRole('button', { name: 'Create', exact: true }).click();

		// The mission should appear in the list
		await expect(page.locator('h4:has-text("Daily Health Check")')).toBeVisible({ timeout: 8000 });

		// Recurring badge should be visible
		await expect(
			page.locator('[data-testid="mission-type-badge"]:has-text("Recurring")')
		).toBeVisible({ timeout: 5000 });

		// Schedule should be shown in header
		await expect(page.locator('text=@daily')).toBeVisible({ timeout: 5000 });
	});

	test('should show custom cron field when custom preset is selected', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await openCreateMissionModal(page);

		// Fill in title on step 1 and advance to step 2
		await page.locator('#wizard-goal-title').fill('Test Mission');
		await advanceToStep2(page);

		// Select recurring type
		await page.locator('[data-testid="mission-type-recurring"]').click();

		// Select custom preset
		await page.locator('[data-testid="schedule-preset"]').selectOption('custom');

		// Custom cron input should appear
		await expect(page.locator('[data-testid="custom-cron"]')).toBeVisible({ timeout: 5000 });
	});

	test('should show semi-autonomous badge when autonomy is set', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await openCreateMissionModal(page);

		// Fill in title on step 1 and advance to step 2
		await page.locator('#wizard-goal-title').fill('Auto Mission');
		await advanceToStep2(page);

		// Select semi-autonomous
		await page.locator('[data-testid="autonomy-semi_autonomous"]').click();

		// Submit
		await page.getByRole('button', { name: 'Create', exact: true }).click();

		// The mission should appear with semi-autonomous badge
		await expect(page.locator('h4:has-text("Auto Mission")')).toBeVisible({ timeout: 8000 });
		await expect(
			page.locator('[data-testid="autonomy-badge"]:has-text("Semi-Autonomous")')
		).toBeVisible({ timeout: 5000 });
	});

	test('should show type filter buttons when missions exist', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);

		// Create a mission first
		await openCreateMissionModal(page);
		await page.locator('#wizard-goal-title').fill('Filter Test Mission');
		await advanceToStep2(page);
		await page.getByRole('button', { name: 'Create', exact: true }).click();
		await expect(page.locator('h4:has-text("Filter Test Mission")')).toBeVisible({ timeout: 8000 });

		// Filter buttons should appear
		await expect(page.locator('[data-testid="filter-all"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="filter-measurable"]')).toBeVisible();
		await expect(page.locator('[data-testid="filter-recurring"]')).toBeVisible();
	});
});
