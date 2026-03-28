/**
 * Neo Chat Rendering E2E Tests
 *
 * Verifies that the Neo chat panel renders messages correctly as readable text,
 * not as raw JSON or structured data tables.
 *
 * Test scenarios:
 * 1. Empty state shows correctly before any messages
 * 2. Chat/Activity tab switching works
 * 3. User messages appear in the correct bubble style (right-aligned blue bubble)
 * 4. Neo sparkle avatar appears next to assistant messages
 * 5. Assistant messages render as readable text, NOT a "Structured data" card
 *
 * E2E Principles (from CLAUDE.md):
 * - All test actions go through UI (clicks, typing, keyboard shortcuts).
 * - All assertions verify visible DOM state.
 * - RPC is allowed only in beforeEach/afterEach for setup/teardown.
 * - NEOKAI_ENABLE_NEO_AGENT=1 is set in playwright.config.ts.
 */

import { test, expect, type Page } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';

// ─── Constants ────────────────────────────────────────────────────────────────

const NEO_PANEL_TESTID = 'neo-panel';
const NEO_CHAT_INPUT_TESTID = 'neo-chat-input';
const NEO_USER_MESSAGE_TESTID = 'neo-user-message';
const NEO_ASSISTANT_MESSAGE_TESTID = 'neo-assistant-message';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Open the Neo panel by clicking the Neo NavRail button.
 */
async function openNeoPanel(page: Page): Promise<void> {
	const neoButton = page.getByRole('button', { name: 'Neo (⌘J)', exact: true });
	await neoButton.waitFor({ state: 'visible', timeout: 5000 });
	await neoButton.click();
	await page.getByTestId(NEO_PANEL_TESTID).waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Send a message in the Neo chat input.
 */
async function sendNeoMessage(page: Page, text: string): Promise<void> {
	const input = page.getByTestId(NEO_CHAT_INPUT_TESTID);
	await input.waitFor({ state: 'visible', timeout: 5000 });
	await input.fill(text);
	await input.press('Enter');
}

/**
 * Wait for a new Neo assistant response to appear (any content).
 * Uses count-based detection so previous responses don't trigger a false positive.
 */
async function waitForNeoAssistantResponse(
	page: Page,
	options: { timeout?: number } = {}
): Promise<void> {
	const timeout = options.timeout ?? 90000;
	const initialCount = await page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).count();
	await page.waitForFunction(
		(expected) =>
			document.querySelectorAll('[data-testid="neo-assistant-message"]').length > expected,
		initialCount,
		{ timeout }
	);
	// Also wait for the input to be re-enabled (loading state cleared)
	await page.getByTestId(NEO_CHAT_INPUT_TESTID).waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Check whether the Neo agent is provisioned (not showing an error card).
 * Must be called with the Neo panel already open so error cards are rendered.
 */
async function isNeoAvailable(page: Page): Promise<boolean> {
	const hasNoCredentials = await page
		.getByTestId('neo-error-no-credentials')
		.isVisible()
		.catch(() => false);
	const hasProviderError = await page
		.getByTestId('neo-error-provider-unavailable')
		.isVisible()
		.catch(() => false);
	return !hasNoCredentials && !hasProviderError;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Neo Chat Rendering', () => {
	test.use({ viewport: { width: 1280, height: 720 } });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		// Clear persisted panel state so tests start with panel closed
		await page.evaluate(() => localStorage.removeItem('neo:panelOpen'));
		await page.reload();
		await waitForWebSocketConnected(page);
	});

	// ── 1. Empty state ─────────────────────────────────────────────────────────

	test('shows empty state with Neo introduction before any messages', async ({ page }) => {
		await openNeoPanel(page);

		// Chat view is rendered
		await expect(page.getByTestId('neo-chat-view')).toBeVisible();

		// Empty state is visible
		const emptyState = page.getByTestId('neo-empty-state');
		await expect(emptyState).toBeVisible();

		// Shows the "Hi, I'm Neo" greeting text
		await expect(emptyState).toContainText("Hi, I'm Neo");

		// Shows helper prompt text
		await expect(emptyState).toContainText('Ask me anything');

		// No messages rendered yet
		await expect(page.getByTestId(NEO_USER_MESSAGE_TESTID)).toHaveCount(0);
		await expect(page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID)).toHaveCount(0);
	});

	// ── 2. Tab switching ───────────────────────────────────────────────────────

	test('Chat/Activity tabs switch correctly', async ({ page }) => {
		await openNeoPanel(page);

		const chatTab = page.getByTestId('neo-tab-chat');
		const activityTab = page.getByTestId('neo-tab-activity');

		// Chat tab is active by default
		await expect(chatTab).toHaveAttribute('aria-selected', 'true');
		await expect(activityTab).toHaveAttribute('aria-selected', 'false');

		// Chat view is visible, activity view is not
		await expect(page.getByTestId('neo-chat-view')).toBeVisible();
		await expect(page.getByTestId('neo-activity-view')).not.toBeVisible();

		// Click Activity tab
		await activityTab.click();

		// Activity tab is now active
		await expect(activityTab).toHaveAttribute('aria-selected', 'true');
		await expect(chatTab).toHaveAttribute('aria-selected', 'false');

		// Activity view is visible, chat view is not
		await expect(page.getByTestId('neo-activity-view')).toBeVisible();
		await expect(page.getByTestId('neo-chat-view')).not.toBeVisible();

		// Switch back to Chat tab
		await chatTab.click();

		// Chat tab is active again
		await expect(chatTab).toHaveAttribute('aria-selected', 'true');
		await expect(page.getByTestId('neo-chat-view')).toBeVisible();
	});

	// ── 3. User message bubble style ───────────────────────────────────────────

	test('user messages appear in right-aligned blue bubble after sending', async ({ page }) => {
		await openNeoPanel(page);

		// Need Neo available to send a message
		if (!(await isNeoAvailable(page))) {
			test.skip();
			return;
		}

		await sendNeoMessage(page, 'Hello Neo');

		// User message bubble appears
		const userMsg = page
			.getByTestId(NEO_USER_MESSAGE_TESTID)
			.filter({ hasText: 'Hello Neo' })
			.first();
		await userMsg.waitFor({ state: 'visible', timeout: 10000 });

		// The outer wrapper is right-aligned (justify-end)
		await expect(userMsg).toHaveClass(/justify-end/);

		// The inner bubble has blue background styling
		const bubble = userMsg.locator('div').first();
		await expect(bubble).toHaveClass(/bg-blue-600/);
		await expect(bubble).toHaveClass(/text-white/);

		// The text content is readable
		await expect(userMsg).toContainText('Hello Neo');
	});

	// ── 4. Sparkle avatar next to assistant messages ───────────────────────────

	test('Neo sparkle avatar appears next to assistant messages', async ({ page }) => {
		await openNeoPanel(page);

		if (!(await isNeoAvailable(page))) {
			test.skip();
			return;
		}

		await sendNeoMessage(page, 'Say hi back');
		await waitForNeoAssistantResponse(page);

		// The assistant message container is present
		const assistantMsg = page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).first();
		await expect(assistantMsg).toBeVisible();

		// The sparkle SVG avatar is inside the assistant message
		// It's rendered as an aria-hidden SVG inside a violet-tinted rounded circle
		const avatar = assistantMsg.locator('div.rounded-full.bg-violet-600\\/20').first();
		await expect(avatar).toBeVisible();

		// The sparkle icon SVG is present inside the avatar
		const sparkle = avatar.locator('svg[aria-hidden="true"]').first();
		await expect(sparkle).toBeAttached();
	});

	// ── 5. Assistant messages render as readable text, not raw JSON ─────────────

	test('assistant messages render as readable text, not raw JSON or structured data', async ({
		page,
	}) => {
		await openNeoPanel(page);

		if (!(await isNeoAvailable(page))) {
			test.skip();
			return;
		}

		await sendNeoMessage(page, 'What time is it roughly?');
		await waitForNeoAssistantResponse(page);

		const assistantMsg = page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).last();
		await expect(assistantMsg).toBeVisible();

		// The message content area should not show a "Structured data" heading —
		// which would indicate the old broken StructuredDataCard path is being used
		await expect(assistantMsg).not.toContainText('Structured data');

		// The message should not display raw JSON characters that would indicate
		// unparsed SDK message content leaking through
		const text = await assistantMsg.textContent();
		expect(text).not.toMatch(/^\s*\{/); // should not start with `{`
		expect(text).not.toContain('"type":"assistant"');
		expect(text).not.toContain('"content":[');

		// The parse-error fallback should not be shown
		await expect(page.getByTestId('neo-message-parse-error')).not.toBeVisible();

		// The message should contain some actual readable text (non-empty)
		expect((text ?? '').trim().length).toBeGreaterThan(0);
	});

	// ── 6. No parse errors for valid responses ─────────────────────────────────

	test('assistant messages do not show parse-error fallback for valid responses', async ({
		page,
	}) => {
		await openNeoPanel(page);

		if (!(await isNeoAvailable(page))) {
			test.skip();
			return;
		}

		await sendNeoMessage(page, 'Hello');
		await waitForNeoAssistantResponse(page);

		// SDKMessageRenderer is used, not the parse-error fallback
		await expect(page.getByTestId('neo-message-parse-error')).not.toBeVisible();

		// An assistant message is present and visible
		await expect(page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).last()).toBeVisible();
	});

	// ── 7. Empty state disappears after first message ──────────────────────────

	test('empty state disappears once a message is sent', async ({ page }) => {
		await openNeoPanel(page);

		if (!(await isNeoAvailable(page))) {
			test.skip();
			return;
		}

		// Empty state is shown initially
		await expect(page.getByTestId('neo-empty-state')).toBeVisible();

		await sendNeoMessage(page, 'Hi');

		// Empty state disappears once the user message appears
		const userMsg = page.getByTestId(NEO_USER_MESSAGE_TESTID).first();
		await userMsg.waitFor({ state: 'visible', timeout: 10000 });

		await expect(page.getByTestId('neo-empty-state')).not.toBeVisible();
	});
});
