/**
 * Draft Persistence E2E Tests
 *
 * Tests that input draft text is persisted across sessions, tabs, and page refreshes.
 * Verifies the following behaviors:
 * - Draft is saved while typing (with 250ms debounce)
 * - Draft is loaded when switching sessions
 * - Draft is cleared after sending a message
 * - Draft persists across page refreshes
 * - Draft syncs across multiple browser tabs
 * - Empty drafts are properly cleared from database
 */

import { test, expect } from '@playwright/test';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForMessageSent,
	cleanupTestSession,
	waitForElement,
} from './helpers/wait-helpers';

test.describe('Draft Persistence', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should save draft while typing', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);
		expect(sessionId).toBeTruthy();

		// Type some draft text
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		const draftText = 'This is a draft message';
		await messageInput.fill(draftText);

		// Wait for debounce (250ms) + a small buffer for processing
		await page.waitForTimeout(400);

		// Reload the page to verify persistence
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to the session
		await page.goto(`/${sessionId}`);

		// Wait for message input to be ready
		const reloadedInput = page.locator('textarea[placeholder*="Ask"]').first();
		await reloadedInput.waitFor({ state: 'visible', timeout: 10000 });

		// Wait for draft to be loaded (via useEffect)
		await page.waitForFunction(
			(expectedText) => {
				const textarea = document.querySelector(
					'textarea[placeholder*="Ask"]'
				) as HTMLTextAreaElement;
				return textarea && textarea.value === expectedText;
			},
			draftText,
			{ timeout: 5000 }
		);

		// Verify the draft is still in the textarea
		const draftValue = await reloadedInput.inputValue();
		expect(draftValue).toBe(draftText);
	});

	test('should load draft when switching sessions', async ({ page }) => {
		// Create first session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		const sessionIdA = await waitForSessionCreated(page);
		expect(sessionIdA).toBeTruthy();

		// Type draft in session A
		const messageInputA = page.locator('textarea[placeholder*="Ask"]').first();
		const draftA = 'Draft A';
		await messageInputA.fill(draftA);

		// Wait for save (250ms debounce + buffer)
		await page.waitForTimeout(400);

		// Create second session
		await newSessionButton.click();

		const sessionIdB = await waitForSessionCreated(page);
		expect(sessionIdB).toBeTruthy();
		expect(sessionIdB).not.toBe(sessionIdA);

		// Type draft in session B
		const messageInputB = page.locator('textarea[placeholder*="Ask"]').first();
		const draftB = 'Draft B';
		await messageInputB.fill(draftB);

		// Wait for save
		await page.waitForTimeout(400);

		// Switch back to session A by clicking it in the sidebar
		const sessionAButton = page.locator(`button[data-session-id="${sessionIdA}"]`);
		await sessionAButton.click();

		// Wait for navigation
		await page.waitForURL(`/${sessionIdA}`, { timeout: 5000 });

		// Wait for draft A to be loaded
		await page.waitForFunction(
			(expectedText) => {
				const textarea = document.querySelector(
					'textarea[placeholder*="Ask"]'
				) as HTMLTextAreaElement;
				return textarea && textarea.value === expectedText;
			},
			draftA,
			{ timeout: 5000 }
		);

		// Verify draft A is loaded
		const inputA = page.locator('textarea[placeholder*="Ask"]').first();
		const valueA = await inputA.inputValue();
		expect(valueA).toBe(draftA);

		// Switch to session B
		const sessionBButton = page.locator(`button[data-session-id="${sessionIdB}"]`);
		await sessionBButton.click();

		// Wait for navigation
		await page.waitForURL(`/${sessionIdB}`, { timeout: 5000 });

		// Wait for draft B to be loaded
		await page.waitForFunction(
			(expectedText) => {
				const textarea = document.querySelector(
					'textarea[placeholder*="Ask"]'
				) as HTMLTextAreaElement;
				return textarea && textarea.value === expectedText;
			},
			draftB,
			{ timeout: 5000 }
		);

		// Verify draft B is loaded
		const inputB = page.locator('textarea[placeholder*="Ask"]').first();
		const valueB = await inputB.inputValue();
		expect(valueB).toBe(draftB);

		// Clean up both sessions
		sessionId = sessionIdA; // Will be cleaned in afterEach
		await cleanupTestSession(page, sessionIdB);
	});

	test('should clear draft after sending message', async ({ page }) => {
		// Create session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Type draft text
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		const draftText = 'This draft will be sent';
		await messageInput.fill(draftText);

		// Wait for draft to be saved
		await page.waitForTimeout(400);

		// Send the message (press Enter)
		await messageInput.press('Enter');

		// Wait for message to be sent (appears in UI)
		await waitForMessageSent(page, draftText);

		// Verify textarea is now empty
		const emptyValue = await messageInput.inputValue();
		expect(emptyValue).toBe('');

		// Reload page to verify draft was cleared from database
		await page.reload();

		// Wait for reconnection
		await waitForElement(page, 'text=Online');

		// Navigate back to session
		await page.goto(`/${sessionId}`);

		// Wait for message input
		const reloadedInput = page.locator('textarea[placeholder*="Ask"]').first();
		await reloadedInput.waitFor({ state: 'visible', timeout: 10000 });

		// Wait a bit for draft loading to complete
		await page.waitForTimeout(500);

		// Verify textarea is still empty (draft was cleared)
		const finalValue = await reloadedInput.inputValue();
		expect(finalValue).toBe('');
	});

	test('should preserve draft during conversation', async ({ page }) => {
		// Create session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Type and send a message
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Hello');
		await messageInput.press('Enter');

		// Wait for message to be sent
		await waitForMessageSent(page, 'Hello');

		// Verify input is cleared
		let currentValue = await messageInput.inputValue();
		expect(currentValue).toBe('');

		// Now type a new draft (next message)
		const nextDraft = 'next message';
		await messageInput.fill(nextDraft);

		// Wait for draft to be saved
		await page.waitForTimeout(400);

		// Send a different message (clear input, type different text, send)
		await messageInput.fill('Different message');
		await messageInput.press('Enter');

		// Wait for the different message to be sent
		await waitForMessageSent(page, 'Different message');

		// The draft "next message" should be cleared now (because we sent a message)
		currentValue = await messageInput.inputValue();
		expect(currentValue).toBe('');

		// Reload to verify draft was cleared
		await page.reload();
		await waitForElement(page, 'text=Online');
		await page.goto(`/${sessionId}`);

		const reloadedInput = page.locator('textarea[placeholder*="Ask"]').first();
		await reloadedInput.waitFor({ state: 'visible', timeout: 10000 });

		// Wait for draft loading
		await page.waitForTimeout(500);

		// Should be empty (draft was cleared when message was sent)
		const finalValue = await reloadedInput.inputValue();
		expect(finalValue).toBe('');
	});

	test('should not restore sent message as draft after session switch', async ({ page }) => {
		// This test explicitly covers the bug: sent message reappearing as draft after session switch
		// Create first session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		const sessionIdA = await waitForSessionCreated(page);

		// Type and send a message in session A
		const messageInputA = page.locator('textarea[placeholder*="Ask"]').first();
		const messageToSend = 'This message should not reappear as draft';
		await messageInputA.fill(messageToSend);

		// Wait for draft to be saved (race condition setup)
		await page.waitForTimeout(400);

		// Send the message (press Enter)
		await messageInputA.press('Enter');

		// Wait for message to be sent
		await waitForMessageSent(page, messageToSend);

		// Verify textarea is cleared
		let currentValue = await messageInputA.inputValue();
		expect(currentValue).toBe('');

		// Create second session to switch away
		await newSessionButton.click();

		const sessionIdB = await waitForSessionCreated(page);
		expect(sessionIdB).not.toBe(sessionIdA);

		// Type something in session B (to ensure session B is active)
		const messageInputB = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInputB.fill('Different session');

		// Wait for save
		await page.waitForTimeout(400);

		// Switch back to session A
		const sessionAButton = page.locator(`button[data-session-id="${sessionIdA}"]`);
		await sessionAButton.click();

		// Wait for navigation
		await page.waitForURL(`/${sessionIdA}`, { timeout: 5000 });

		// Wait for draft loading to complete
		await page.waitForTimeout(500);

		// THE BUG: Previously, the sent message would reappear here
		// With the fix, the textarea should be empty
		const finalInput = page.locator('textarea[placeholder*="Ask"]').first();
		const finalValue = await finalInput.inputValue();
		expect(finalValue).toBe('');

		// Clean up both sessions
		sessionId = sessionIdA;
		await cleanupTestSession(page, sessionIdB);
	});

	test('should handle empty drafts', async ({ page }) => {
		// Create session
		const newSessionButton = page.locator("button:has-text('New Session')");
		await newSessionButton.click();

		sessionId = await waitForSessionCreated(page);

		// Type some text
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Some text');

		// Wait for save
		await page.waitForTimeout(400);

		// Now delete all text
		await messageInput.fill('');

		// Wait for save (empty draft should be cleared)
		await page.waitForTimeout(400);

		// Reload page
		await page.reload();
		await waitForElement(page, 'text=Online');
		await page.goto(`/${sessionId}`);

		// Wait for input
		const reloadedInput = page.locator('textarea[placeholder*="Ask"]').first();
		await reloadedInput.waitFor({ state: 'visible', timeout: 10000 });

		// Wait for draft loading
		await page.waitForTimeout(500);

		// Verify textarea is empty (empty draft was cleared from DB)
		const finalValue = await reloadedInput.inputValue();
		expect(finalValue).toBe('');
	});

	test('should sync draft across multiple tabs', async ({ browser }) => {
		// Create two browser tabs (sharing same context for session access)
		const context = await browser.newContext();
		const tabA = await context.newPage();
		const tabB = await context.newPage();

		try {
			// Setup both tabs
			await tabA.goto('http://localhost:9283');
			await tabB.goto('http://localhost:9283');

			// Wait for connection in both tabs
			await Promise.all([waitForElement(tabA, 'text=Online'), waitForElement(tabB, 'text=Online')]);

			// Create session in tab A
			const newSessionButtonA = tabA.locator("button:has-text('New Session')");
			await newSessionButtonA.click();

			const createdSessionId = await waitForSessionCreated(tabA);
			sessionId = createdSessionId; // Store for cleanup
			expect(sessionId).toBeTruthy();

			// Type draft in tab A
			const messageInputA = tabA.locator('textarea[placeholder*="Ask"]').first();
			const draftText = 'Draft from tab A';
			await messageInputA.fill(draftText);

			// Wait for draft to be saved (250ms debounce + buffer)
			await tabA.waitForTimeout(400);

			// Open same session in tab B
			await tabB.goto(`http://localhost:9283/${sessionId}`);

			// Wait for input to be ready in tab B
			const messageInputB = tabB.locator('textarea[placeholder*="Ask"]').first();
			await messageInputB.waitFor({ state: 'visible', timeout: 10000 });

			// Wait for draft to be loaded in tab B
			await tabB.waitForFunction(
				(expectedText) => {
					const textarea = document.querySelector(
						'textarea[placeholder*="Ask"]'
					) as HTMLTextAreaElement;
					return textarea && textarea.value === expectedText;
				},
				draftText,
				{ timeout: 5000 }
			);

			// Verify draft appears in tab B
			const draftValueB = await messageInputB.inputValue();
			expect(draftValueB).toBe(draftText);

			// Cleanup: Use tabA for cleanup since we have sessionId
			await cleanupTestSession(tabA, sessionId);
			sessionId = null; // Prevent double cleanup
		} finally {
			await context.close();
		}
	});
});
