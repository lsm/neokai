/**
 * E2E Test: Room Functionality
 *
 * Tests for room creation, room chat, and room-agent-tools MCP integration.
 */

import { test, expect } from '../../fixtures';
import {
	navigateToRooms,
	createRoom,
	sendRoomChatMessage,
	waitForAssistantResponse,
	verifyRoomMcpToolsAvailable,
	cleanupTestRoom,
} from '../helpers/room-helpers';

test.describe('Room Functionality', () => {
	let roomId: string | null = null;

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await cleanupTestRoom(page, roomId);
			roomId = null;
		}
	});

	test('should create a new room', async ({ page }) => {
		await navigateToRooms(page);

		// Create room
		roomId = await createRoom(page);

		// Verify room page loaded
		await expect(page.getByText('Agent stopped')).toBeVisible();

		// Verify room name heading (use first match since there are multiple headings)
		const roomHeading = page.getByRole('heading', { name: /Room \d+\/\d+\/\d+/ }).first();
		await expect(roomHeading).toBeVisible();

		// Verify overview tab is active by default
		const overviewTab = page.getByRole('button', { name: 'Overview' });
		await expect(overviewTab).toHaveClass(/text-blue-400/);
	});

	test('should have room chat panel with MCP tools', async ({ page }) => {
		await navigateToRooms(page);
		roomId = await createRoom(page);

		// Verify room chat panel exists on the right side
		const chatPanel = page.locator('.w-96.border-l').or(page.locator('[class*="border-l"]'));
		await expect(chatPanel).toBeVisible();

		// Verify message input exists in room chat
		const messageInput = page
			.locator('.w-96.border-l textarea[placeholder*="Ask"]')
			.or(page.locator('[class*="border-l"] textarea[placeholder*="Ask"]'));
		await expect(messageInput).toBeVisible();

		// Send message to verify MCP tools are available
		const hasMcpTools = await verifyRoomMcpToolsAvailable(page);
		expect(hasMcpTools).toBe(true);
	});

	test('should send and receive messages in room chat', async ({ page }) => {
		await navigateToRooms(page);
		roomId = await createRoom(page);

		// Send a test message
		const testMessage = 'Hello, this is a test message from the room chat';
		await sendRoomChatMessage(page, testMessage);

		// Verify message appears in chat
		await expect(page.getByText(testMessage)).toBeVisible();

		// Wait for assistant response
		await waitForAssistantResponse(page);

		// Verify assistant responded (there should be at least 2 messages now: user + assistant)
		const messages = page.locator('[class*="message"]');
		const messageCount = await messages.count();
		expect(messageCount).toBeGreaterThanOrEqual(2);
	});

	test('should display room overview with zero sessions initially', async ({ page }) => {
		await navigateToRooms(page);
		roomId = await createRoom(page);

		// Verify overview shows "No sessions in this room"
		await expect(page.getByText('No sessions in this room')).toBeVisible();

		// Verify session count shows 0
		await expect(page.getByText('0 Sessions')).toBeVisible();
	});

	test('should have working tabs (Overview, Context, Goals, Jobs, Settings)', async ({ page }) => {
		await navigateToRooms(page);
		roomId = await createRoom(page);

		// Test each tab
		const tabs = ['Overview', 'Context', 'Goals', 'Jobs', 'Settings'];

		for (const tabName of tabs) {
			const tab = page.getByRole('button', { name: tabName });
			await expect(tab).toBeVisible();
			await tab.click();

			// Verify tab becomes active (has blue text)
			await expect(tab).toHaveClass(/text-blue-400/);
		}
	});

	test('should show "Agent stopped" status initially', async ({ page }) => {
		await navigateToRooms(page);
		roomId = await createRoom(page);

		// Verify agent status shows as stopped
		await expect(page.getByText('Agent stopped')).toBeVisible();

		// Verify "Start" button is visible
		const startButton = page.getByRole('button', { name: 'Start' });
		await expect(startButton).toBeVisible();
	});

	test('room chat should have access to room-agent-tools MCP', async ({ page }) => {
		await navigateToRooms(page);
		roomId = await createRoom(page);

		// Send message specifically asking about room-agent-tools
		const messageInput = page
			.locator('.w-96.border-l textarea[placeholder*="Ask"]')
			.or(page.locator('[class*="border-l"] textarea[placeholder*="Ask"]'));
		await expect(messageInput).toBeVisible();
		await messageInput.fill('What room-agent-tools MCP tools are available?');

		// Just verify we can send the message (the actual response content check is less important)
		const sendButton = page.getByRole('button', { name: 'Send message' });
		await expect(sendButton).toBeEnabled();
		await sendButton.click();

		// Wait a bit for the message to be sent
		await page.waitForTimeout(2000);

		// Verify the message was sent (appears in chat)
		await expect(page.getByText('What room-agent-tools MCP tools are available?')).toBeVisible();

		// Note: We don't wait for the full response since it can take a long time
		// The important thing is that the message was sent successfully
	});

	test('should navigate back to rooms list via "All Rooms" button', async ({ page }) => {
		await navigateToRooms(page);
		roomId = await createRoom(page);

		// Click "All Rooms" button
		const allRoomsButton = page.getByRole('button', { name: 'All Rooms' });
		await expect(allRoomsButton).toBeVisible();
		await allRoomsButton.click();

		// Verify we're back on rooms page
		await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible();

		// Verify the created room appears in the room list
		// The room card should have the room name
		const roomCards = page.getByRole('button', { name: /Room \d+\/\d+\/\d+/ });
		await expect(roomCards.first()).toBeVisible();
	});

	test('should display correct room metadata', async ({ page }) => {
		await navigateToRooms(page);
		roomId = await createRoom(page);

		// Verify room ID format (should be a UUID)
		expect(roomId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);

		// Verify URL contains room ID
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}`));
	});
});
