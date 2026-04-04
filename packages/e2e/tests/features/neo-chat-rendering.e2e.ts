/**
 * Neo Chat Rendering E2E Tests
 *
 * Verifies that the Neo chat panel renders messages correctly as readable text,
 * not as raw JSON or structured data tables.
 *
 * Test scenarios:
 * 1. Empty state shows correctly before any messages
 * 2. User messages appear in the correct bubble style (right-aligned blue bubble)
 * 3. Empty state disappears once a message is sent
 * 4. Neo sparkle avatar appears next to assistant messages  [AI-dependent]
 * 5. Assistant messages render as readable text, NOT a "Structured data" card  [AI-dependent]
 *
 * Tests 1–3 require only a working server connection (no AI credentials).
 * Tests 4–5 require Neo credentials and are skipped when not available.
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
	waitForNeoUserMessage,
	waitForNeoAssistantResponse,
	isNeoAvailable,
} from '../helpers/neo-helpers';

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Neo Chat Rendering', () => {
	// Serial mode: all tests share the singleton neo:global session. Parallel
	// execution causes cross-worker interference — e.g., test 2 (sendNeoMessage)
	// stores an SDK message that the LiveQuery pushes to test 1's frontend,
	// breaking the empty-state assertion. Running serially avoids this.
	test.describe.configure({ mode: 'serial' });
	test.use({ viewport: { width: 1280, height: 720 } });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		// Clear persisted panel state so tests start with panel closed
		await page.evaluate(() => localStorage.removeItem('neo:panelOpen'));
		// Clear the Neo session so each test starts with an empty chat history.
		// This is infrastructure setup (allowed in beforeEach per E2E rules) and
		// ensures tests 1 and 3 reliably see the empty state on first open.
		await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (hub?.request) {
				await hub.request('neo.clearSession', {}).catch(() => {});
			}
		});
		await page.reload();
		await waitForWebSocketConnected(page);
		// Clear session a second time after reload to eliminate any auto-initialized
		// messages (e.g. "Invalid API key" error messages from parallel test interference
		// or session auto-init). The session may be re-created on WS reconnect.
		await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (hub?.request) {
				await hub.request('neo.clearSession', {}).catch(() => {});
			}
		});
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

	// ── 2. User message bubble style ─────────────────────────────────────────────
	// Does not require an AI response — only verifies that the user message
	// bubble is rendered correctly after sendNeoMessage() creates it via RPC.

	test('user messages appear in right-aligned blue bubble after sending', async ({ page }) => {
		await openNeoPanel(page);

		await sendNeoMessage(page, 'Hello Neo');

		// Wait for user message bubble to appear
		await waitForNeoUserMessage(page, 'Hello Neo');
		const userMsg = page
			.getByTestId(NEO_USER_MESSAGE_TESTID)
			.filter({ hasText: 'Hello Neo' })
			.first();

		// The outer wrapper is right-aligned (justify-end)
		await expect(userMsg).toHaveClass(/justify-end/);

		// The inner bubble has blue background styling
		const bubble = userMsg.locator('div').first();
		await expect(bubble).toHaveClass(/bg-blue-600/);
		await expect(bubble).toHaveClass(/text-white/);

		// The text content is readable
		await expect(userMsg).toContainText('Hello Neo');
	});

	// ── 3. Empty state disappears after first message ──────────────────────────
	// Does not require an AI response — only verifies the empty state hides
	// once a user message is in the DOM.

	test('empty state disappears once a message is sent', async ({ page }) => {
		await openNeoPanel(page);

		// Empty state is shown initially (session cleared in beforeEach)
		await expect(page.getByTestId('neo-empty-state')).toBeVisible();

		await sendNeoMessage(page, 'Hi');

		// Wait for user message to appear, then verify empty state is gone
		await waitForNeoUserMessage(page, 'Hi');
		await expect(page.getByTestId('neo-empty-state')).not.toBeVisible();
	});

	// ── AI-dependent tests: skip when Neo credentials are not configured ────────

	test.describe('Neo Chat — AI-dependent rendering', () => {
		test.beforeEach(async ({ page }) => {
			await openNeoPanel(page);
			if (!(await isNeoAvailable(page))) {
				test.skip();
			}
		});

		// ── 4. Sparkle avatar next to assistant messages ──────────────────────────

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

		// ── 5. Assistant messages render as readable text, not raw JSON ────────────

		test('assistant messages render as readable text, not raw JSON or structured data', async ({
			page,
		}) => {
			await sendNeoMessage(page, 'What time is it roughly?');
			await waitForNeoAssistantResponse(page);

			const assistantMsg = page.getByTestId(NEO_ASSISTANT_MESSAGE_TESTID).last();
			await expect(assistantMsg).toBeVisible();

			// No "Structured data" heading — that would indicate the broken StructuredDataCard path
			await expect(assistantMsg).not.toContainText('Structured data');

			// No raw JSON leaking through (unparsed SDK message content)
			const text = await assistantMsg.textContent();
			expect(text).not.toMatch(/^\s*\{/); // should not start with `{`
			expect(text).not.toContain('"type":"assistant"');
			expect(text).not.toContain('"content":[');

			// The parse-error fallback must not be shown for valid responses
			await expect(page.getByTestId('neo-message-parse-error')).not.toBeVisible();

			// Message contains actual readable text (non-empty)
			expect((text ?? '').trim().length).toBeGreaterThan(0);
		});
	});
});
