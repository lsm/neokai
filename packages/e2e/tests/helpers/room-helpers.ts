/**
 * Room E2E Test Helpers
 *
 * Helper functions for room-related E2E tests.
 */

import { expect, type Page } from '@playwright/test';

/**
 * Navigate to rooms page
 */
export async function navigateToRooms(page: Page): Promise<void> {
	await page.goto('/');
	await page.waitForLoadState('networkidle');

	// Click on "Rooms" navigation button
	const roomsButton = page.getByRole('button', { name: 'Rooms' });
	await expect(roomsButton).toBeVisible();
	await roomsButton.click();

	// Wait for rooms page to load (use h3 which is the main page heading)
	await expect(page.getByRole('heading', { level: 3, name: 'Rooms' })).toBeVisible();
}

/**
 * Create a new room
 * @returns The room ID (extracted from URL)
 */
export async function createRoom(page: Page, name?: string): Promise<string> {
	// Click "Create Room" button (use first one with exact match)
	const createRoomButton = page.getByRole('button', { name: 'Create Room', exact: true }).first();
	await expect(createRoomButton).toBeVisible();
	await createRoomButton.click();

	// Wait for room page to load (should show "Agent stopped")
	await expect(page.getByText('Agent stopped')).toBeVisible({ timeout: 10000 });

	// Extract room ID from URL
	const roomId = page.url().split('/room/')[1]?.split('?')[0];
	if (!roomId) {
		throw new Error('Room ID not found in URL after room creation');
	}

	return roomId;
}

/**
 * Send a message in the room chat
 */
export async function sendRoomChatMessage(page: Page, message: string): Promise<void> {
	const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
	await expect(messageInput).toBeVisible();
	await messageInput.fill(message);

	const sendButton = page.getByRole('button', { name: 'Send message' });
	await expect(sendButton).toBeEnabled();
	await sendButton.click();

	// Wait for message to appear
	await expect(page.getByText(message)).toBeVisible();
}

/**
 * Wait for assistant response
 */
export async function waitForAssistantResponse(page: Page): Promise<void> {
	// Wait for the "Send message" button to be enabled again (indicates response complete)
	const sendButton = page.getByRole('button', { name: 'Send message' });
	await expect(sendButton).toBeEnabled({ timeout: 30000 });
}

/**
 * Navigate to a specific room
 */
export async function navigateToRoom(page: Page, roomId: string): Promise<void> {
	await page.goto(`/room/${roomId}`);
	await page.waitForLoadState('networkidle');

	// Wait for room page to load
	await expect(page.getByText('Agent stopped').or(page.getByText('Agent started'))).toBeVisible({
		timeout: 10000,
	});
}

/**
 * Get room chat panel element
 */
export function getRoomChatPanel(page: Page) {
	return page.locator('.w-96.border-l').or(page.locator('[class*="room-chat"]'));
}

/**
 * Verify room MCP tools are available
 */
export async function verifyRoomMcpToolsAvailable(page: Page): Promise<boolean> {
	// Send a message asking to list MCP tools
	const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
	await expect(messageInput).toBeVisible();
	await messageInput.fill('List all available MCP tools including room-agent-tools');

	const sendButton = page.getByRole('button', { name: 'Send message' });
	await expect(sendButton).toBeEnabled();
	await sendButton.click();

	// Wait for response and check if room-agent-tools are mentioned
	await waitForAssistantResponse(page);

	const pageContent = await page.content();
	return (
		pageContent.includes('room-agent-tools') ||
		pageContent.includes('room_create_task') ||
		pageContent.includes('room_list_goals')
	);
}

/**
 * Delete a room (via Settings tab)
 */
export async function deleteRoom(page: Page, roomId: string): Promise<void> {
	await navigateToRoom(page, roomId);

	// Click on Settings tab (use the one in the tab bar, not the header)
	const settingsTab = page.locator('button').filter({ hasText: 'Settings' }).nth(1);
	await expect(settingsTab).toBeVisible();
	await settingsTab.click();

	// Click "Delete Room" button
	const deleteButton = page.getByRole('button', { name: /delete room/i });
	await expect(deleteButton).toBeVisible();
	await deleteButton.click();

	// Confirm deletion (if there's a confirmation dialog)
	const confirmButton = page.getByRole('button', { name: /delete|confirm/i }).first();
	if (await confirmButton.isVisible({ timeout: 5000 }).catch(() => false)) {
		await confirmButton.click();
	}

	// Should be redirected to home page
	await expect(page).toHaveURL('/');
}

/**
 * Cleanup test room
 */
export async function cleanupTestRoom(page: Page, roomId: string): Promise<void> {
	try {
		await deleteRoom(page, roomId);
	} catch (error) {
		console.warn(`Failed to cleanup room ${roomId}:`, error);
	}
}
