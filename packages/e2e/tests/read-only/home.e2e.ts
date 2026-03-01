import { test, expect } from '../../fixtures';

test.describe('Home Page', () => {
	test('should display the welcome screen when no session is selected', async ({ page }) => {
		await page.goto('/');

		// Check for lobby heading
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();

		// Check for lobby subtitle (desktop only)
		await expect(page.locator('text=Manage your AI-powered workspaces')).toBeVisible();
	});

	test('should have a sidebar visible', async ({ page }) => {
		await page.goto('/');

		// NavRail should be visible - look for the Home button
		await expect(page.getByRole('button', { name: 'Home' })).toBeVisible();

		// Check for New Session button
		await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible();
	});

	test('should have proper page title', async ({ page }) => {
		await page.goto('/');

		// Check page title
		await expect(page).toHaveTitle(/NeoKai/i);
	});

	test('should apply dark theme styles', async ({ page }) => {
		await page.goto('/');

		// Check that dark background is applied
		const mainContainer = page.locator('.bg-dark-950').first();
		await expect(mainContainer).toBeVisible();
	});

	test('should be responsive on mobile', async ({ page, isMobile }) => {
		await page.goto('/');

		// The page should load without errors on mobile
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();

		// Check viewport is mobile-friendly
		if (isMobile) {
			const viewport = page.viewportSize();
			expect(viewport?.width).toBeLessThan(768);
		}
	});
});
