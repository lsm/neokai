/**
 * Automation Runtime E2E
 *
 * Covers the production task-system behaviors that are visible to users:
 * - Room automations expose run history with scheduler events.
 * - Repeated runtime failures pause the automation instead of flooding review.
 * - Non-code Room task automations can be created for rooms without a Git repo.
 *
 * Setup uses RPC only to create isolated rooms/automation definitions. User
 * actions and assertions go through the UI.
 */

import { test, expect } from '../../fixtures';
import { createRoom, deleteRoom, openMissionsTab } from '../helpers/room-helpers';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

async function createRoomAutomation(
	page: Parameters<typeof waitForWebSocketConnected>[0],
	roomId: string,
	params: Record<string, unknown>
): Promise<string> {
	return page.evaluate(
		async ({ rId, automation }) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('automation.create', {
				ownerType: 'room',
				ownerId: rId,
				...automation,
			});
			return (res as { automation: { id: string } }).automation.id;
		},
		{ rId: roomId, automation: params }
	);
}

test.describe('Automation Runtime', () => {
	let roomId = '';

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'E2E Automation Runtime Room');
	});

	test.afterEach(async ({ page }) => {
		await deleteRoom(page, roomId);
		roomId = '';
	});

	test('shows run event history for a non-code room task automation', async ({ page }) => {
		await createRoomAutomation(page, roomId, {
			title: 'Research monitor',
			description: 'Create a research task from automation.',
			triggerType: 'manual',
			targetType: 'room_task',
			targetConfig: {
				roomId,
				titleTemplate: 'Research latest signal',
				descriptionTemplate: 'Collect current public information and summarize it.',
				taskType: 'research',
				assignedAgent: 'general',
			},
		});

		await page.goto(`/room/${roomId}/goals`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await expect(page.getByText('Research monitor')).toBeVisible({ timeout: 10000 });

		const card = page
			.locator('div:has-text("Research monitor")')
			.filter({ hasText: 'Run' })
			.first();
		await card.getByRole('button', { name: 'Run', exact: true }).click();
		await card.getByRole('button', { name: 'History', exact: true }).click();

		await expect(page.getByText('target_launch_started')).toBeVisible({ timeout: 10000 });
		await expect(page.getByText('target_launch_succeeded')).toBeVisible({ timeout: 10000 });
	});

	test('pauses an automation after repeated identical failures', async ({ page }) => {
		await createRoomAutomation(page, roomId, {
			title: 'Broken mission automation',
			description: 'Intentionally points to a missing mission.',
			triggerType: 'manual',
			targetType: 'room_mission',
			targetConfig: {
				roomId,
				goalId: 'missing-goal',
				action: 'trigger',
			},
		});

		await page.goto(`/room/${roomId}/goals`);
		await waitForWebSocketConnected(page);
		await openMissionsTab(page);
		await expect(page.getByText('Broken mission automation')).toBeVisible({ timeout: 10000 });

		const card = page
			.locator('div:has-text("Broken mission automation")')
			.filter({ hasText: 'Run' })
			.first();
		for (let index = 0; index < 3; index++) {
			await card.getByRole('button', { name: 'Run', exact: true }).click();
		}
		await page.getByRole('button', { name: /Attention/ }).click();
		const attentionCard = page.locator('div:has-text("Broken mission automation")').first();
		await attentionCard.getByRole('button', { name: 'History', exact: true }).click();

		await expect(page.getByText('Paused after 3 consecutive automation failures')).toBeVisible({
			timeout: 10000,
		});
		await expect(page.getByText('circuit_breaker_paused')).toBeVisible({ timeout: 10000 });
	});
});
