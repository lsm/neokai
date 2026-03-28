/**
 * Neo Chat Rendering E2E Tests
 *
 * Verifies that the Neo chat panel renders messages correctly as readable text,
 * not as raw JSON or structured data tables.
 *
 * Test scenarios:
 * 1. Empty state shows correctly before any messages
 * 2. User messages appear in the correct bubble style (right-aligned blue bubble)
 * 3. Neo sparkle avatar appears next to assistant messages
 * 4. Assistant messages render as readable text, NOT a "Structured data" card
 * 5. No parse-error fallback for valid responses
 * 6. Empty state disappears once a message is sent
 *
 * E2E Principles (from CLAUDE.md):
 * - All test actions go through UI (clicks, typing, keyboard shortcuts).
 * - All assertions verify visible DOM state.
 * - RPC is allowed only in beforeEach/afterEach for setup/teardown.
 * - NEOKAI_ENABLE_NEO_AGENT=1 is set in playwright.config.ts.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected } from '../helpers/wait-helpers';
import {
	NEO_USER_MESSAGE_TESTID,
	NEO_ASSISTANT_MESSAGE_TESTID,
	openNeoPanel,
	sendNeoMessage,
	waitForNeoAssistantResponse,
	isNeoAvailable,
} from '../helpers/neo-helpers';

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
		await expect(emptyState).toContainText('Ask me anything about your rooms, sessions, or goals');

		// No messages rendered yet
		await expect(page.getByTestId(NEO_USER_MESSAGE_TESTID)).toHaveCount(0);
		await expect(page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID)).toHaveCount(0);
	});

	// ── AI-dependent tests: skip when Neo credentials are not configured ────────

	test.describe('Neo Chat — AI-dependent rendering', () => {
		test.beforeEach(async ({ page }) => {
			await openNeoPanel(page);
			if (!(await isNeoAvailable(page))) {
				test.skip();
			}
		});

		// ── 2. User message bubble style ─────────────────────────────────────────

		test('user messages appear in right-aligned blue bubble after sending', async ({ page }) => {
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

		// ── 3. Sparkle avatar next to assistant messages ──────────────────────────

		test('Neo sparkle avatar appears next to assistant messages', async ({ page }) => {
			await sendNeoMessage(page, 'Say hi back');
			await waitForNeoAssistantResponse(page);

			// The assistant message container is present
			const assistantMsg = page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).first();
			await expect(assistantMsg).toBeVisible();

			// The sparkle avatar is inside the assistant message via its test ID
			const avatar = assistantMsg.getByTestId('neo-sparkle-avatar').first();
			await expect(avatar).toBeVisible();

			// The sparkle icon SVG is present inside the avatar
			const sparkle = avatar.locator('svg[aria-hidden="true"]').first();
			await expect(sparkle).toBeAttached();
		});

		// ── 4. Assistant messages render as readable text, not raw JSON ────────────

		test('assistant messages render as readable text, not raw JSON or structured data', async ({
			page,
		}) => {
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

		// ── 5. No parse errors for valid responses ────────────────────────────────

		test('assistant messages do not show parse-error fallback for valid responses', async ({
			page,
		}) => {
			await sendNeoMessage(page, 'Hello');
			await waitForNeoAssistantResponse(page);

			// SDKMessageRenderer is used, not the parse-error fallback
			await expect(page.getByTestId('neo-message-parse-error')).not.toBeVisible();

			// An assistant message is present and visible
			await expect(page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).last()).toBeVisible();
		});

		// ── 6. Empty state disappears after first message ─────────────────────────

		test('empty state disappears once a message is sent', async ({ page }) => {
			// Empty state is shown initially (panel opened in beforeEach)
			await expect(page.getByTestId('neo-empty-state')).toBeVisible();

			await sendNeoMessage(page, 'Hi');

			// Empty state disappears once the user message appears
			const userMsg = page.getByTestId(NEO_USER_MESSAGE_TESTID).first();
			await userMsg.waitFor({ state: 'visible', timeout: 10000 });

			await expect(page.getByTestId('neo-empty-state')).not.toBeVisible();
		});
	});
});
