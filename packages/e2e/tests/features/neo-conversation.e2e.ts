/**
 * Neo Conversation Flow E2E Tests (Task 11.2)
 *
 * Tests full conversational flows through the Neo UI:
 * - Panel mechanics: open, close, tabs, input
 * - Query flow: send a message and verify response
 * - Security mode switching via Settings > Neo
 * - Action flow with confirmation UI (conservative mode)
 * - Activity feed: entries with timestamps
 * - Clear session: chat history erased
 * - Undo flow: perform action, undo via chat, verify reversed
 *
 * Setup:
 * - Test rooms and skills are created via RPC in beforeEach (infrastructure pattern).
 * - NEOKAI_ENABLE_NEO_AGENT=1 is set in playwright.config.ts so the Neo agent
 *   provisions itself even under NODE_ENV=test.
 *
 * E2E Principles (from CLAUDE.md):
 * - All test actions go through UI (clicks, typing, keyboard shortcuts).
 * - All assertions verify visible DOM state.
 * - RPC is allowed only in beforeEach/afterEach for setup/teardown.
 */

import { test, expect, type Page } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import { openSettingsModal } from '../helpers/settings-modal-helpers';
import {
	NEO_PANEL_TESTID,
	NEO_CHAT_INPUT_TESTID,
	NEO_SEND_BUTTON_TESTID,
	NEO_USER_MESSAGE_TESTID,
	NEO_ASSISTANT_MESSAGE_TESTID,
	NEO_ACTIVITY_VIEW_TESTID,
	ACTIVITY_ENTRY_TESTID,
	openNeoPanel,
	closeNeoPanel,
	sendNeoMessage,
	waitForNeoUserMessage,
	waitForNeoAssistantResponse,
	isNeoAvailable,
} from '../helpers/neo-helpers';

/**
 * Navigate to the Neo Agent section in Global Settings.
 * Assumes the settings panel is already open.
 */
async function navigateToNeoSettings(page: Page): Promise<void> {
	const neoNavButton = page.locator('nav button:has-text("Neo Agent")').first();
	await neoNavButton.waitFor({ state: 'visible', timeout: 5000 });
	await neoNavButton.click();
	// Wait for the Neo settings content (security mode heading)
	await page.locator('text=Security Mode').first().waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Navigate to the Skills section in Global Settings.
 * Assumes the settings panel is already open.
 */
async function navigateToSkillsSettings(page: Page): Promise<void> {
	const skillsNavButton = page.locator('nav button:has-text("Skills")').first();
	await skillsNavButton.waitFor({ state: 'visible', timeout: 5000 });
	await skillsNavButton.click();
	await page
		.locator('text=Application-level skills are available to any room or session')
		.first()
		.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Locate the skill row in the Skills settings panel.
 * Walks up from the display name text to find the row div with a Delete button.
 */
function getSkillRow(page: Page, displayName: string) {
	return page
		.locator(
			`xpath=//*[normalize-space(text())="${displayName}"]/ancestor::div[.//button[@title="Delete"]][1]`
		)
		.first();
}

/**
 * Verify a skill's enabled state via Settings > Skills UI.
 * Navigates to skills settings, checks the toggle, returns to home.
 * Returns the boolean enabled state.
 */
async function getSkillEnabledStateViaUI(page: Page, displayName: string): Promise<boolean> {
	await openSettingsModal(page);
	await navigateToSkillsSettings(page);
	const skillRow = getSkillRow(page, displayName);
	const toggle = skillRow.locator('[role="switch"]').first();
	const checked = await toggle.getAttribute('aria-checked', { timeout: 5000 });
	// Navigate home to close settings before returning
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	return checked === 'true';
}

/**
 * Change the Neo security mode via the Settings > Neo section.
 * Assumes Settings > Neo is already open.
 */
async function changeSecurityMode(
	page: Page,
	mode: 'conservative' | 'balanced' | 'autonomous'
): Promise<void> {
	// The security mode select is a SettingsSelect wrapping a <select> element
	const modeSelect = page
		.locator('select')
		.filter({ has: page.locator('option[value="conservative"]') })
		.first();
	await modeSelect.waitFor({ state: 'visible', timeout: 5000 });
	await modeSelect.selectOption(mode);
	// Wait for toast confirming the update — use generous timeout for CI latency
	await page.locator('text=Security mode updated').waitFor({ state: 'visible', timeout: 15000 });
}

/**
 * Create a test skill via RPC (infrastructure-only, for beforeEach use).
 * Returns the created skill ID.
 */
async function createTestSkill(page: Page, name: string): Promise<string> {
	const skillId = await page.evaluate(async (skillName) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		// skill.create expects { params: CreateSkillParams }
		const slug = skillName.toLowerCase().replace(/\s+/g, '-');
		const response = await hub.request('skill.create', {
			params: {
				name: slug,
				displayName: skillName,
				description: 'E2E test skill',
				sourceType: 'plugin',
				config: { type: 'plugin', pluginPath: '/tmp/fake-plugin' },
				enabled: false,
				validationStatus: 'pending',
			},
		});
		return (response as { skill: { id: string } }).skill.id;
	}, name);
	return skillId;
}

/**
 * Delete a skill via RPC (infrastructure-only, for afterEach use).
 */
async function deleteTestSkill(page: Page, skillId: string): Promise<void> {
	await page.evaluate(async (id) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		await hub.request('skill.delete', { id }).catch(() => {});
	}, skillId);
}

/**
 * Create a test room via RPC (infrastructure-only, for beforeEach use).
 */
async function createTestRoom(page: Page, name: string): Promise<string> {
	const roomId = await page.evaluate(async (roomName) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		const systemState = await hub.request('state.system', {});
		const workspaceRoot = (systemState as { workspaceRoot: string }).workspaceRoot;
		const response = await hub.request('room.create', {
			name: roomName,
			defaultPath: workspaceRoot,
		});
		return (response as { room: { id: string } }).room.id;
	}, name);
	return roomId;
}

/**
 * Delete a test room via RPC (infrastructure-only, for afterEach use).
 */
async function deleteTestRoom(page: Page, roomId: string): Promise<void> {
	await page.evaluate(async (id) => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) throw new Error('MessageHub not available');
		await hub.request('room.delete', { id }).catch(() => {});
	}, roomId);
}

/**
 * Reset Neo security mode back to 'balanced' via RPC (cleanup helper).
 */
async function resetSecurityMode(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const hub = window.__messageHub || window.appState?.messageHub;
		if (!hub?.request) return;
		await hub.request('neo.updateSettings', { securityMode: 'balanced' }).catch(() => {});
	});
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// 1. Panel basics and tab switching
// ---------------------------------------------------------------------------

test.describe('Neo Panel – UI mechanics', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('opens via NavRail Neo button and shows Chat tab by default', async ({ page }) => {
		await openNeoPanel(page);

		// Panel is visible
		await expect(page.getByTestId(NEO_PANEL_TESTID)).toBeVisible();

		// Chat tab is active by default (aria-selected="true")
		const chatTab = page.getByTestId('neo-tab-chat');
		await expect(chatTab).toHaveAttribute('aria-selected', 'true');

		// Activity tab is inactive
		const activityTab = page.getByTestId('neo-tab-activity');
		await expect(activityTab).toHaveAttribute('aria-selected', 'false');

		// Chat input is rendered
		await expect(page.getByTestId(NEO_CHAT_INPUT_TESTID)).toBeVisible();
	});

	test('opens via Cmd+J keyboard shortcut', async ({ page }) => {
		await page.keyboard.press('Meta+j');
		await page.getByTestId(NEO_PANEL_TESTID).waitFor({ state: 'visible', timeout: 5000 });
		await expect(page.getByTestId(NEO_PANEL_TESTID)).toBeVisible();
	});

	test('closes via close button', async ({ page }) => {
		await openNeoPanel(page);
		await closeNeoPanel(page);
		// Panel uses CSS transform to go off-screen — verify via class, not toBeHidden()
		await expect(page.getByTestId(NEO_PANEL_TESTID)).toHaveClass(/-translate-x-full/);
	});

	test('closes via backdrop click', async ({ page }) => {
		await openNeoPanel(page);
		const backdrop = page.getByTestId('neo-panel-backdrop');
		await expect(backdrop).toBeVisible({ timeout: 3000 });
		// The panel is `fixed left-0 w-96` (384px) at the md breakpoint (1280px viewport).
		// The backdrop is `fixed inset-0 z-40`; the panel is z-50, so clicks inside
		// the panel's 384px width would be intercepted by the panel. Click at x=500 to
		// land clearly to the right of the panel on the visible backdrop area.
		await backdrop.click({ position: { x: 500, y: 360 } });
		// Panel uses CSS transform — wait for -translate-x-full class, not state: 'hidden'
		await expect(page.getByTestId(NEO_PANEL_TESTID)).toHaveClass(/-translate-x-full/, {
			timeout: 5000,
		});
	});

	test('closes via Escape key', async ({ page }) => {
		await openNeoPanel(page);
		// Wait for the close button to receive focus (it's focused via requestAnimationFrame
		// after the panel opens). This ensures the Preact useEffect that registers the
		// document keydown handler has already run before we press Escape.
		await expect(page.getByTestId('neo-panel-close')).toBeFocused({ timeout: 3000 });
		await page.keyboard.press('Escape');
		// Panel uses CSS transform — wait for -translate-x-full class, not state: 'hidden'
		await expect(page.getByTestId(NEO_PANEL_TESTID)).toHaveClass(/-translate-x-full/, {
			timeout: 5000,
		});
	});

	test('switches to Activity tab and back to Chat tab', async ({ page }) => {
		await openNeoPanel(page);

		// Switch to Activity tab
		const activityTab = page.getByTestId('neo-tab-activity');
		await activityTab.click();
		await expect(activityTab).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByTestId('neo-tab-chat')).toHaveAttribute('aria-selected', 'false');
		// Chat view is conditionally rendered — not present in DOM when Activity is active
		await expect(page.getByTestId('neo-chat-view')).not.toBeVisible({ timeout: 2000 });

		// Switch back to Chat tab
		const chatTab = page.getByTestId('neo-tab-chat');
		await chatTab.click();
		await expect(chatTab).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByTestId('neo-chat-view')).toBeVisible({ timeout: 2000 });
	});

	test('chat input accepts text and send button is enabled', async ({ page }) => {
		await openNeoPanel(page);

		const input = page.getByTestId(NEO_CHAT_INPUT_TESTID);
		await input.fill('Hello, Neo!');
		await expect(input).toHaveValue('Hello, Neo!');

		const sendButton = page.getByTestId(NEO_SEND_BUTTON_TESTID);
		await expect(sendButton).toBeEnabled();
	});
});

// ---------------------------------------------------------------------------
// 2. Query flow: send a message and verify response
// ---------------------------------------------------------------------------

test.describe('Neo – Query flow', () => {
	let roomId: string;
	const roomName = `E2E Room ${Date.now()}`;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		// Create a test room so Neo can answer "what rooms do I have?"
		roomId = await createTestRoom(page, roomName);
		await openNeoPanel(page);
		// Skip AI-dependent tests if Neo agent is unavailable (no API key in env)
		if (!(await isNeoAvailable(page))) {
			test.skip();
		}
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteTestRoom(page, roomId);
		}
	});

	test('send a message and receive an assistant response', async ({ page }) => {
		const message = 'what rooms do I have?';
		await sendNeoMessage(page, message);

		// User message bubble appears immediately
		await waitForNeoUserMessage(page, message);

		// A response eventually arrives
		await waitForNeoAssistantResponse(page, { timeout: 90000 });

		// At least one assistant message is visible
		await expect(page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).first()).toBeVisible();
	});

	test('user message appears immediately after sending', async ({ page }) => {
		// Verifies optimistic rendering — no AI response required to pass
		const message = 'ping test message';
		await sendNeoMessage(page, message);
		await waitForNeoUserMessage(page, message);
		await expect(
			page.getByTestId(NEO_USER_MESSAGE_TESTID).filter({ hasText: message }).first()
		).toBeVisible();
	});

	test('chat input is cleared after sending', async ({ page }) => {
		const input = page.getByTestId(NEO_CHAT_INPUT_TESTID);
		await input.fill('test clear after send');
		await input.press('Enter');
		// Input should clear as soon as the message is submitted
		await expect(input).toHaveValue('', { timeout: 3000 });
	});
});

// ---------------------------------------------------------------------------
// 3. Security mode: Settings > Neo Agent section
// ---------------------------------------------------------------------------

test.describe('Neo Settings – Security mode', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await openSettingsModal(page);
		await navigateToNeoSettings(page);
	});

	test.afterEach(async ({ page }) => {
		// Always reset to balanced so other tests aren't affected
		await resetSecurityMode(page);
	});

	test('Neo Agent section is present in settings navigation', async ({ page }) => {
		// Already navigated in beforeEach — verify content is visible
		await expect(page.locator('text=Security Mode').first()).toBeVisible();
		await expect(page.locator('text=Clear Session').first()).toBeVisible();
	});

	test('security mode selector shows all three options', async ({ page }) => {
		const modeSelect = page
			.locator('select')
			.filter({ has: page.locator('option[value="conservative"]') })
			.first();
		await expect(modeSelect).toBeVisible();

		// All three options are present
		await expect(modeSelect.locator('option[value="conservative"]')).toHaveCount(1);
		await expect(modeSelect.locator('option[value="balanced"]')).toHaveCount(1);
		await expect(modeSelect.locator('option[value="autonomous"]')).toHaveCount(1);
	});

	test('can change security mode to Conservative and back to Balanced', async ({ page }) => {
		await changeSecurityMode(page, 'conservative');

		const modeSelect = page
			.locator('select')
			.filter({ has: page.locator('option[value="conservative"]') })
			.first();
		await expect(modeSelect).toHaveValue('conservative');

		// Change back to balanced
		await modeSelect.selectOption('balanced');
		await page.locator('text=Security mode updated').waitFor({ state: 'visible', timeout: 15000 });
		await expect(modeSelect).toHaveValue('balanced');
	});

	test('can change security mode to Autonomous', async ({ page }) => {
		await changeSecurityMode(page, 'autonomous');

		const modeSelect = page
			.locator('select')
			.filter({ has: page.locator('option[value="conservative"]') })
			.first();
		await expect(modeSelect).toHaveValue('autonomous');
	});

	test('security mode persists: reload shows saved value', async ({ page }) => {
		await changeSecurityMode(page, 'conservative');

		// Reload and navigate back to Neo settings
		await page.reload();
		await waitForWebSocketConnected(page);
		await openSettingsModal(page);
		await navigateToNeoSettings(page);

		const modeSelect = page
			.locator('select')
			.filter({ has: page.locator('option[value="conservative"]') })
			.first();
		await expect(modeSelect).toHaveValue('conservative');
	});
});

// ---------------------------------------------------------------------------
// 4. Action flow: conservative mode confirmation card
// ---------------------------------------------------------------------------

test.describe('Neo – Action flow with confirmation (conservative mode)', () => {
	let skillId: string;
	const skillName = `E2E Skill ${Date.now()}`;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a skill to enable/disable (starts disabled)
		skillId = await createTestSkill(page, skillName);

		// Set security mode to conservative so ALL actions require confirmation
		await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			await hub.request('neo.updateSettings', { securityMode: 'conservative' });
		});

		await openNeoPanel(page);

		// Skip if Neo agent is unavailable
		if (!(await isNeoAvailable(page))) {
			test.skip();
		}
	});

	test.afterEach(async ({ page }) => {
		await resetSecurityMode(page);
		if (skillId) {
			await deleteTestSkill(page, skillId);
		}
	});

	test('action in conservative mode shows confirmation card, cancel preserves state', async ({
		page,
	}) => {
		const message = `enable the skill named ${skillName}`;
		await sendNeoMessage(page, message);
		await waitForNeoUserMessage(page, message);

		// In conservative mode, Neo presents a confirmation card before acting
		const confirmationCard = page.getByTestId('neo-confirmation-card');
		await confirmationCard.waitFor({ state: 'visible', timeout: 90000 });
		await expect(confirmationCard).toBeVisible();

		// Click Cancel to dismiss without executing
		const cancelButton = page.getByTestId('neo-cancel-button');
		await cancelButton.waitFor({ state: 'visible', timeout: 5000 });
		await cancelButton.click();

		// Confirmation card disappears after cancel
		await confirmationCard.waitFor({ state: 'hidden', timeout: 10000 });
		await expect(confirmationCard).toBeHidden();

		// Verify skill remains disabled via the Skills settings UI
		await closeNeoPanel(page);
		const enabled = await getSkillEnabledStateViaUI(page, skillName);
		expect(enabled).toBe(false);
	});

	test('action in conservative mode can be confirmed and skill becomes enabled', async ({
		page,
	}) => {
		const message = `enable the skill named ${skillName}`;
		await sendNeoMessage(page, message);
		await waitForNeoUserMessage(page, message);

		// Wait for confirmation card
		const confirmationCard = page.getByTestId('neo-confirmation-card');
		await confirmationCard.waitFor({ state: 'visible', timeout: 90000 });

		// Click Confirm to execute the action
		const confirmButton = page.getByTestId('neo-confirm-button');
		await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
		await confirmButton.click();

		// Confirmation card disappears after confirmation
		await confirmationCard.waitFor({ state: 'hidden', timeout: 10000 });

		// A result message appears from Neo
		await waitForNeoAssistantResponse(page, { timeout: 30000 });

		// Verify skill is now enabled via the Skills settings UI
		await closeNeoPanel(page);
		const enabled = await getSkillEnabledStateViaUI(page, skillName);
		expect(enabled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 5. Activity feed: entries with timestamps
// ---------------------------------------------------------------------------

test.describe('Neo – Activity feed', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		await openNeoPanel(page);
	});

	test('Activity tab shows empty state when no actions have been performed', async ({ page }) => {
		const activityTab = page.getByTestId('neo-tab-activity');
		await activityTab.click();

		// Isolated DB per test run — activity should be empty initially.
		// The NeoActivityView renders data-testid="neo-activity-empty" when there are no entries.
		await page.getByTestId('neo-activity-empty').waitFor({ state: 'visible', timeout: 5000 });
		await expect(page.getByTestId('neo-activity-empty')).toBeVisible();
	});

	test('Activity tab switches to activity view and back to chat', async ({ page }) => {
		// Switch to Activity
		const activityTab = page.getByTestId('neo-tab-activity');
		await activityTab.click();
		await expect(page.getByTestId(NEO_ACTIVITY_VIEW_TESTID)).toBeVisible();
		await expect(page.getByTestId('neo-chat-view')).toBeHidden();

		// Switch back to Chat
		const chatTab = page.getByTestId('neo-tab-chat');
		await chatTab.click();
		await expect(page.getByTestId('neo-chat-view')).toBeVisible();
		await expect(page.getByTestId(NEO_ACTIVITY_VIEW_TESTID)).toBeHidden();
	});

	test('activity entries with timestamps appear after Neo performs a tool call', async ({
		page,
	}) => {
		// Skip if Neo agent is unavailable
		if (!(await isNeoAvailable(page))) {
			test.skip();
			return;
		}

		// Send a message that triggers a tool call (list rooms)
		await sendNeoMessage(page, 'list all my rooms');
		await waitForNeoUserMessage(page, 'list all my rooms');
		await waitForNeoAssistantResponse(page, { timeout: 90000 });

		// Switch to Activity tab
		const activityTab = page.getByTestId('neo-tab-activity');
		await activityTab.click();
		await expect(page.getByTestId(NEO_ACTIVITY_VIEW_TESTID)).toBeVisible();

		// At least one activity entry is present (Neo used the list_rooms tool)
		const firstEntry = page.getByTestId(ACTIVITY_ENTRY_TESTID).first();
		await firstEntry.waitFor({ state: 'visible', timeout: 15000 });
		const entryCount = await page.getByTestId(ACTIVITY_ENTRY_TESTID).count();
		expect(entryCount).toBeGreaterThan(0);

		// Each entry shows a relative timestamp (e.g., "just now", "1m ago")
		await expect(firstEntry.locator('text=/just now|\\d+[mhd] ago/')).toBeVisible({
			timeout: 5000,
		});
	});
});

// ---------------------------------------------------------------------------
// 6. Clear session: erase chat history
// ---------------------------------------------------------------------------

test.describe('Neo Settings – Clear session', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
	});

	test('clear session button shows confirmation dialog and cancels cleanly', async ({ page }) => {
		await openSettingsModal(page);
		await navigateToNeoSettings(page);

		// Click "Clear Session" button to reveal confirmation dialog
		const clearButton = page.locator('button:has-text("Clear Session")').first();
		await clearButton.waitFor({ state: 'visible', timeout: 5000 });
		await clearButton.click();

		// Confirmation prompt appears
		await expect(page.locator('text=Are you sure?')).toBeVisible({ timeout: 5000 });

		// Click Cancel via its dedicated testid (added to NeoSettings.tsx)
		const cancelButton = page.getByTestId('neo-settings-cancel-clear');
		await cancelButton.waitFor({ state: 'visible', timeout: 5000 });
		await cancelButton.click();

		// Confirmation prompt disappears cleanly
		await expect(page.locator('text=Are you sure?')).toBeHidden({ timeout: 5000 });
	});

	test('clear session erases chat history', async ({ page }) => {
		// First: open Neo panel and send a message through the UI to create history
		await openNeoPanel(page);
		await sendNeoMessage(page, 'test message for clear session test');
		await waitForNeoUserMessage(page, 'test message for clear session test');

		// Navigate to Settings > Neo to clear session
		await closeNeoPanel(page);
		await openSettingsModal(page);
		await navigateToNeoSettings(page);

		const clearButton = page.locator('button:has-text("Clear Session")').first();
		await clearButton.click();
		await expect(page.locator('text=Are you sure?')).toBeVisible({ timeout: 5000 });

		// Confirm the clear
		const confirmButton = page.locator('button:has-text("Confirm")').first();
		await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
		await confirmButton.click();

		// Success toast appears
		await page.locator('text=Neo session cleared').waitFor({ state: 'visible', timeout: 10000 });
		await expect(page.locator('text=Neo session cleared')).toBeVisible();

		// Navigate home and reopen Neo panel — chat should be empty
		await page.getByRole('button', { name: 'Home', exact: true }).click();
		await openNeoPanel(page);

		// No user or assistant message bubbles remain
		const userMessages = page.getByTestId(NEO_USER_MESSAGE_TESTID);
		const assistantMessages = page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID);
		const totalMessages = (await userMessages.count()) + (await assistantMessages.count());
		expect(totalMessages).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 7. Undo flow: perform undoable action, undo via Neo chat
// ---------------------------------------------------------------------------

test.describe('Neo – Undo flow', () => {
	let skillId: string;
	const skillName = `E2E Undo Skill ${Date.now()}`;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);

		// Create a skill to enable (starts disabled)
		skillId = await createTestSkill(page, skillName);

		// Use autonomous mode so the enable action executes without confirmation
		await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			await hub.request('neo.updateSettings', { securityMode: 'autonomous' });
		});

		await openNeoPanel(page);

		// Skip if Neo agent is unavailable
		if (!(await isNeoAvailable(page))) {
			test.skip();
		}
	});

	test.afterEach(async ({ page }) => {
		await resetSecurityMode(page);
		if (skillId) {
			await deleteTestSkill(page, skillId);
		}
	});

	test('undo reverses the last action: enable skill then undo disables it', async ({ page }) => {
		// ── Step 1: Enable the skill via Neo ──────────────────────────────────

		const enableMessage = `enable the skill named ${skillName}`;
		await sendNeoMessage(page, enableMessage);
		await waitForNeoUserMessage(page, enableMessage);
		// In autonomous mode the action executes immediately without confirmation
		await waitForNeoAssistantResponse(page, { timeout: 90000 });

		// Verify skill is now enabled via Settings > Skills UI
		await closeNeoPanel(page);
		const enabledAfterAction = await getSkillEnabledStateViaUI(page, skillName);
		expect(enabledAfterAction).toBe(true);

		// ── Step 2: Undo the action via Neo ──────────────────────────────────

		await openNeoPanel(page);
		const undoMessage = 'undo the last action';
		await sendNeoMessage(page, undoMessage);
		await waitForNeoUserMessage(page, undoMessage);
		// Undo is high-risk in conservative mode but autonomous here → auto-executes
		await waitForNeoAssistantResponse(page, { timeout: 90000 });

		// ── Step 3: Verify skill is disabled again ────────────────────────────

		await closeNeoPanel(page);
		const enabledAfterUndo = await getSkillEnabledStateViaUI(page, skillName);
		expect(enabledAfterUndo).toBe(false);
	});
});
