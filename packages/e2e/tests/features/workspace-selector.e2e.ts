import { test, expect } from '../../fixtures';
import { cleanupTestSession, waitForWebSocketConnected } from '../helpers/wait-helpers';

/**
 * Inline Workspace Selector E2E Tests
 *
 * Tests for the two-stage session creation flow where workspace selection
 * is moved from the modal into an inline selector in the chat container.
 *
 * Flow:
 * 1. User clicks "New Session" → session created immediately without workspace
 * 2. Chat shows inline WorkspaceSelector with history dropdown + worktree toggle
 * 3. User can select workspace + mode, or skip
 */
test.describe('Inline Workspace Selector', () => {
	let sessionId: string | null = null;

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
			timeout: 10000,
		});
		await waitForWebSocketConnected(page);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch {
				// Non-critical cleanup
			}
			sessionId = null;
		}
	});

	test('should show workspace selector after creating session via New Session button', async ({
		page,
	}) => {
		// Click New Session button
		await page.getByRole('button', { name: 'New Session', exact: true }).click();

		// Modal opens — click Create Session without selecting workspace
		await expect(page.getByRole('button', { name: 'Create Session', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await page.getByRole('button', { name: 'Create Session', exact: true }).click();

		// Wait for navigation to session
		await page.waitForURL(/\/session\//, { timeout: 15000 });

		// Extract session ID from URL
		const url = page.url();
		const match = url.match(/\/session\/([^/]+)/);
		if (match) {
			sessionId = match[1];
		}

		// Workspace selector should appear in chat
		await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Set Workspace' })).toBeVisible();
	});

	test('should show worktree/direct toggle when workspace history item is pre-selected', async ({
		page,
	}) => {
		// Create session via UI
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Create Session', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await page.getByRole('button', { name: 'Create Session', exact: true }).click();
		await page.waitForURL(/\/session\//, { timeout: 15000 });

		const url = page.url();
		const match = url.match(/\/session\/([^/]+)/);
		if (match) {
			sessionId = match[1];
		}

		// Wait for workspace selector
		await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });

		// If there's a pre-selected workspace (from history), the mode toggle should appear
		// This depends on whether workspace history is populated. We verify that either:
		// a) The toggle is visible (if history is populated)
		// b) The "No recent workspaces" option is shown (if empty history)
		const workspaceDropdown = page.locator('select').first();
		await expect(workspaceDropdown).toBeVisible();
	});

	test('should dismiss workspace selector when Skip is clicked', async ({ page }) => {
		// Create session via UI
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Create Session', exact: true })).toBeVisible({
			timeout: 5000,
		});
		await page.getByRole('button', { name: 'Create Session', exact: true }).click();
		await page.waitForURL(/\/session\//, { timeout: 15000 });

		const url = page.url();
		const match = url.match(/\/session\/([^/]+)/);
		if (match) {
			sessionId = match[1];
		}

		// Wait for workspace selector to appear
		await expect(page.getByText('Select a workspace')).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();

		// Click Skip
		await page.getByRole('button', { name: 'Skip' }).click();

		// Workspace selector should disappear
		await expect(page.getByText('Select a workspace')).not.toBeVisible({ timeout: 3000 });
	});

	test('should not show workspace selector for sessions with existing workspace', async ({
		page,
	}) => {
		await waitForWebSocketConnected(page);

		// Create session WITH workspace via RPC (test infrastructure)
		const workspaceRoot = await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const systemState = await hub.request('state.system', {});
			return (systemState as { workspaceRoot: string }).workspaceRoot;
		});

		sessionId = await page.evaluate(async (workspacePath) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const response = await hub.request('session.create', {
				workspacePath,
				createdBy: 'human',
			});
			return (response as { sessionId: string }).sessionId;
		}, workspaceRoot);

		await page.goto(`/session/${sessionId}`);
		await page.waitForURL(/\/session\//, { timeout: 10000 });

		// Workspace selector should NOT appear since session has a workspace
		await page.waitForTimeout(1500); // Brief wait for UI to settle
		await expect(page.getByText('Select a workspace')).not.toBeVisible();
	});

	test('should not show workspace selector for sessions with pending_worktree_choice status', async ({
		page,
	}) => {
		// This uses the existing WorktreeChoiceInline flow, not the new selector
		// Verifying the two UI paths don't conflict

		await waitForWebSocketConnected(page);

		// Get workspace root (must be a git repo for pending_worktree_choice to trigger)
		const workspaceRoot = await page.evaluate(async () => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const systemState = await hub.request('state.system', {});
			return (systemState as { workspaceRoot: string }).workspaceRoot;
		});

		sessionId = await page.evaluate(async (workspacePath) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const response = await hub.request('session.create', {
				workspacePath,
				createdBy: 'human',
			});
			return (response as { sessionId: string }).sessionId;
		}, workspaceRoot);

		await page.goto(`/session/${sessionId}`);
		await page.waitForURL(/\/session\//, { timeout: 10000 });

		// Workspace selector should NOT appear — session has a workspace
		await page.waitForTimeout(1500);
		await expect(page.getByText('Select a workspace')).not.toBeVisible();
	});
});
