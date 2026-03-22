/**
 * Mission Detail View E2E Tests
 *
 * Verifies the expanded mission detail views:
 * - Measurable mission: metric progress bars visible in header and expanded section
 * - Recurring mission: execution history section visible when expanded
 *
 * Setup: creates a room via RPC (infrastructure), then tests the UI.
 * Cleanup: deletes the room via RPC in afterEach.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { deleteRoom } from '../helpers/room-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createRoom(page: Parameters<typeof waitForWebSocketConnected>[0]): Promise<string> {
	await waitForWebSocketConnected(page);
	return page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const res = await hub.request('room.create', {
			name: 'E2E Mission Detail Test Room',
		});
		return (res as { room: { id: string } }).room.id;
	});
}

async function openMissionsTab(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<void> {
	// Use exact name to avoid matching the sidebar "Missions section" button
	// (aria-label="Missions section") which also contains "Missions" text.
	const missionsTab = page.getByRole('button', { name: 'Missions', exact: true });
	await expect(missionsTab).toBeVisible({ timeout: 10000 });
	await missionsTab.click();
	await expect(page.locator('h2:has-text("Missions")')).toBeVisible({ timeout: 5000 });
}

async function openCreateMissionModal(
	page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<void> {
	const createButtons = page.locator('button:has-text("Create Mission")');
	await expect(createButtons.first()).toBeVisible({ timeout: 5000 });
	await createButtons.first().click();
	await expect(page.locator('#goal-title')).toBeVisible({ timeout: 5000 });
}

/** Creates a measurable mission with one metric and returns the mission title. */
async function createMeasurableMission(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	title: string
): Promise<void> {
	await openCreateMissionModal(page);
	await page.locator('#goal-title').fill(title);
	await page.locator('[data-testid="mission-type-measurable"]').click();
	await page.locator('[data-testid="add-metric-btn"]').click();
	const metricNameInput = page.locator('[aria-label="Metric 1 name"]');
	await expect(metricNameInput).toBeVisible({ timeout: 5000 });
	await metricNameInput.fill('Code Coverage');
	await page.locator('[aria-label="Metric 1 target"]').fill('80');
	await page.locator('[aria-label="Metric 1 unit"]').fill('%');
	await page.locator('button[type="submit"]:has-text("Create")').click();
	await expect(page.locator(`h4:has-text("${title}")`)).toBeVisible({ timeout: 8000 });
}

/** Creates a recurring mission with default daily schedule and returns the mission title. */
async function createRecurringMission(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	title: string
): Promise<void> {
	await openCreateMissionModal(page);
	await page.locator('#goal-title').fill(title);
	await page.locator('[data-testid="mission-type-recurring"]').click();
	await page.locator('button[type="submit"]:has-text("Create")').click();
	await expect(page.locator(`h4:has-text("${title}")`)).toBeVisible({ timeout: 8000 });
}

/** Expands a mission item by clicking its header. */
async function expandMission(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	title: string
): Promise<void> {
	// Find the goal-item-header that contains the mission title and click it
	const header = page
		.locator(`[data-testid="goal-item-header"]:has(h4:has-text("${title}"))`)
		.first();
	await expect(header).toBeVisible({ timeout: 5000 });
	await header.click();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Mission Detail Views', () => {
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

	test('should show metric progress bars in measurable mission header', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await createMeasurableMission(page, 'Coverage Mission');

		// The MetricProgress component renders in the mission header when structuredMetrics exist.
		// It shows metric name + value/target and a progress bar. Verify the metric label is visible.
		const missionHeader = page.locator('h4:has-text("Coverage Mission")').first();
		await expect(missionHeader).toBeVisible({ timeout: 5000 });

		// MetricProgress renders the metric name in a span in the header area
		await expect(page.locator('text=Code Coverage').first()).toBeVisible({ timeout: 5000 });
	});

	test('should show Metric Progress section when measurable mission is expanded', async ({
		page,
	}) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await createMeasurableMission(page, 'Expanded Coverage Mission');

		// Expand the mission by clicking the header
		await expandMission(page, 'Expanded Coverage Mission');

		// The expanded section should contain "Metric Progress" heading
		await expect(page.locator('h5:has-text("Metric Progress")')).toBeVisible({ timeout: 5000 });

		// The metric name should be visible in the expanded detail
		await expect(page.locator('text=Code Coverage').first()).toBeVisible({ timeout: 5000 });
	});

	test('should show metric value and target in expanded measurable mission', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await createMeasurableMission(page, 'Metric Values Mission');

		await expandMission(page, 'Metric Values Mission');

		// Check metric progress heading is visible
		await expect(page.locator('h5:has-text("Metric Progress")')).toBeVisible({ timeout: 5000 });

		// The metric shows current / target format: "0 % / 80 % (0%)"
		// Look for the target value in the metric display
		await expect(page.locator('text=/ 80').first()).toBeVisible({ timeout: 5000 });
	});

	test('should show execution history section when recurring mission is expanded', async ({
		page,
	}) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await createRecurringMission(page, 'Daily Cleanup');

		// Expand the mission
		await expandMission(page, 'Daily Cleanup');

		// Execution history section should appear (rendered by GoalsEditor with onListExecutions)
		await expect(page.locator('[data-testid="execution-history-section"]')).toBeVisible({
			timeout: 5000,
		});
	});

	test('should show "No executions yet" for a fresh recurring mission', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await createRecurringMission(page, 'Fresh Recurring Mission');

		// Expand the mission
		await expandMission(page, 'Fresh Recurring Mission');

		// Execution history section should appear
		await expect(page.locator('[data-testid="execution-history-section"]')).toBeVisible({
			timeout: 5000,
		});

		// Since no executions have run yet, the empty state should show
		await expect(page.locator('text=No executions yet.')).toBeVisible({ timeout: 8000 });
	});

	test('should show Schedule section when recurring mission is expanded', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await createRecurringMission(page, 'Scheduled Mission');

		// Expand the mission
		await expandMission(page, 'Scheduled Mission');

		// Schedule section should appear in the expanded detail
		await expect(page.locator('h5:has-text("Schedule")')).toBeVisible({ timeout: 5000 });
	});

	test('should show Measurable badge for measurable mission', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await createMeasurableMission(page, 'Badge Test Measurable');

		await expect(
			page.locator('[data-testid="mission-type-badge"]:has-text("Measurable")')
		).toBeVisible({ timeout: 5000 });
	});

	test('should show Recurring badge for recurring mission', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await createRecurringMission(page, 'Badge Test Recurring');

		await expect(
			page.locator('[data-testid="mission-type-badge"]:has-text("Recurring")')
		).toBeVisible({ timeout: 5000 });
	});
});
