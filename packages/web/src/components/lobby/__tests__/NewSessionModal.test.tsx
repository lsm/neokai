// @ts-nocheck
/**
 * Tests for NewSessionModal — provider-aware session creation
 */

import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NewSessionModal } from '../NewSessionModal';

// Mock Portal to render inline
vi.mock('../../ui/Portal.tsx', () => ({
	Portal: ({ children }) => <div data-portal="true">{children}</div>,
}));

// Mock connection manager — controls what models.list returns
const mockRequest = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: () => ({ request: mockRequest }),
	},
}));

const DEFAULT_PROPS = {
	isOpen: true,
	onClose: vi.fn(),
	onSubmit: vi.fn().mockResolvedValue(undefined),
	recentPaths: [],
	rooms: [],
};

const MOCK_MODELS = [
	{ id: 'claude-opus-4-6', display_name: 'Claude Opus', description: '', provider: 'anthropic' },
	{
		id: 'claude-sonnet-4-6',
		display_name: 'Claude Sonnet',
		description: '',
		provider: 'anthropic',
	},
	{
		id: 'copilot-claude-sonnet',
		display_name: 'Copilot Sonnet',
		description: '',
		provider: 'anthropic-copilot',
	},
	{
		id: 'codex-claude-sonnet',
		display_name: 'Codex Sonnet',
		description: '',
		provider: 'anthropic-codex',
	},
];

const ALL_AUTH_OK = {
	providers: [
		{ id: 'anthropic', displayName: 'Anthropic', isAuthenticated: true },
		{ id: 'anthropic-copilot', displayName: 'Copilot', isAuthenticated: true },
		{ id: 'anthropic-codex', displayName: 'Codex', isAuthenticated: true },
	],
};

describe('NewSessionModal — provider-aware session creation', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		mockRequest.mockImplementation((method: string) => {
			if (method === 'models.list') return Promise.resolve({ models: MOCK_MODELS });
			if (method === 'auth.providers') return Promise.resolve(ALL_AUTH_OK);
			return Promise.resolve(null);
		});
	});

	afterEach(() => {
		cleanup();
		vi.resetAllMocks();
	});

	describe('model picker rendering', () => {
		it('shows model selector when models are available', async () => {
			render(<NewSessionModal {...DEFAULT_PROPS} />);
			await waitFor(() => {
				const select = document.querySelector('select[class*="cursor-pointer"]');
				expect(select).toBeTruthy();
			});
			// Should have optgroups for each provider
			const optgroups = document.querySelectorAll('optgroup');
			expect(optgroups.length).toBeGreaterThan(0);
		});

		it('renders provider optgroup labels for anthropic, copilot, and codex', async () => {
			render(<NewSessionModal {...DEFAULT_PROPS} />);
			await waitFor(() => {
				const optgroups = document.querySelectorAll('optgroup');
				const labels = Array.from(optgroups).map((g) => g.getAttribute('label'));
				expect(labels).toContain('Anthropic');
				expect(labels).toContain('Copilot');
				expect(labels).toContain('Codex');
			});
		});

		it('has "Default (server setting)" as the first option', async () => {
			render(<NewSessionModal {...DEFAULT_PROPS} />);
			await waitFor(() => {
				const modelSelect = Array.from(document.querySelectorAll('select')).find((s) =>
					s.querySelector('option[value=""]')
				);
				expect(modelSelect).toBeTruthy();
				const defaultOption = modelSelect?.querySelector('option[value=""]');
				expect(defaultOption?.textContent).toBe('Default (server setting)');
			});
		});

		it('does not show model selector when no models returned', async () => {
			mockRequest.mockResolvedValue({ models: [] });
			render(<NewSessionModal {...DEFAULT_PROPS} />);
			// Wait for the fetch attempt to complete
			await new Promise((r) => setTimeout(r, 50));
			// No optgroup means no model picker rendered
			const optgroups = document.querySelectorAll('optgroup');
			expect(optgroups.length).toBe(0);
		});
	});

	describe('onSubmit with model selection', () => {
		it('calls onSubmit without model when default is selected', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<NewSessionModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			// Set workspace path
			const pathInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: '/home/user/project' } });

			// Submit without changing model selection
			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith(
					expect.objectContaining({
						workspacePath: '/home/user/project',
						model: undefined,
					})
				);
			});
		});

		it('calls onSubmit with copilot model and provider when copilot model selected', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<NewSessionModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			// Wait for models to load
			await waitFor(() => {
				const optgroups = document.querySelectorAll('optgroup');
				expect(optgroups.length).toBeGreaterThan(0);
			});

			// Select copilot model
			const modelSelects = Array.from(document.querySelectorAll('select'));
			const modelSelect = modelSelects.find((s) =>
				Array.from(s.options).some((o) => o.value.includes('anthropic-copilot'))
			);
			expect(modelSelect).toBeTruthy();
			fireEvent.change(modelSelect!, {
				target: { value: 'anthropic-copilot:copilot-claude-sonnet' },
			});

			// Set workspace path
			const pathInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: '/home/user/project' } });

			// Submit
			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith(
					expect.objectContaining({
						workspacePath: '/home/user/project',
						model: expect.objectContaining({
							id: 'copilot-claude-sonnet',
							provider: 'anthropic-copilot',
						}),
					})
				);
			});
		});

		it('calls onSubmit with codex model and provider when codex model selected', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<NewSessionModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			await waitFor(() => {
				const optgroups = document.querySelectorAll('optgroup');
				expect(optgroups.length).toBeGreaterThan(0);
			});

			const modelSelects = Array.from(document.querySelectorAll('select'));
			const modelSelect = modelSelects.find((s) =>
				Array.from(s.options).some((o) => o.value.includes('anthropic-codex'))
			);
			fireEvent.change(modelSelect!, {
				target: { value: 'anthropic-codex:codex-claude-sonnet' },
			});

			const pathInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: '/home/user/project' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith(
					expect.objectContaining({
						workspacePath: '/home/user/project',
						model: expect.objectContaining({
							id: 'codex-claude-sonnet',
							provider: 'anthropic-codex',
						}),
					})
				);
			});
		});

		it('calls onSubmit with anthropic model when anthropic model selected', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<NewSessionModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			await waitFor(() => {
				const optgroups = document.querySelectorAll('optgroup');
				expect(optgroups.length).toBeGreaterThan(0);
			});

			const modelSelects = Array.from(document.querySelectorAll('select'));
			const modelSelect = modelSelects.find((s) =>
				Array.from(s.options).some((o) => o.value === 'anthropic:claude-opus-4-6')
			);
			fireEvent.change(modelSelect!, {
				target: { value: 'anthropic:claude-opus-4-6' },
			});

			const pathInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: '/home/user/project' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect(onSubmit).toHaveBeenCalledWith(
					expect.objectContaining({
						model: expect.objectContaining({
							id: 'claude-opus-4-6',
							provider: 'anthropic',
						}),
					})
				);
			});
		});
	});

	describe('form reset', () => {
		it('resets model selection after successful submit', async () => {
			const onSubmit = vi.fn().mockResolvedValue(undefined);
			render(<NewSessionModal {...DEFAULT_PROPS} onSubmit={onSubmit} />);

			await waitFor(() => {
				const optgroups = document.querySelectorAll('optgroup');
				expect(optgroups.length).toBeGreaterThan(0);
			});

			const modelSelects = Array.from(document.querySelectorAll('select'));
			const modelSelect = modelSelects.find((s) =>
				Array.from(s.options).some((o) => o.value.includes('anthropic-copilot'))
			);
			fireEvent.change(modelSelect!, {
				target: { value: 'anthropic-copilot:copilot-claude-sonnet' },
			});

			expect((modelSelect as HTMLSelectElement).value).toBe(
				'anthropic-copilot:copilot-claude-sonnet'
			);

			const pathInput = document.querySelector('input[type="text"]') as HTMLInputElement;
			fireEvent.input(pathInput, { target: { value: '/home/user/project' } });

			const form = document.querySelector('form') as HTMLFormElement;
			fireEvent.submit(form);

			await waitFor(() => {
				expect((modelSelect as HTMLSelectElement).value).toBe('');
			});
		});
	});

	describe('auth-based model filtering', () => {
		it('hides optgroup for unauthenticated provider', async () => {
			mockRequest.mockImplementation((method: string) => {
				if (method === 'models.list') return Promise.resolve({ models: MOCK_MODELS });
				if (method === 'auth.providers') {
					return Promise.resolve({
						providers: [
							{ id: 'anthropic', displayName: 'Anthropic', isAuthenticated: true },
							{ id: 'anthropic-copilot', displayName: 'Copilot', isAuthenticated: false },
							{ id: 'anthropic-codex', displayName: 'Codex', isAuthenticated: true },
						],
					});
				}
				return Promise.resolve(null);
			});

			render(<NewSessionModal {...DEFAULT_PROPS} />);
			await waitFor(() => {
				const optgroups = document.querySelectorAll('optgroup');
				const labels = Array.from(optgroups).map((g) => g.getAttribute('label'));
				// Copilot is unauthenticated — must not appear
				expect(labels).not.toContain('Copilot');
				// Anthropic and Codex are authenticated — must appear
				expect(labels).toContain('Anthropic');
				expect(labels).toContain('Codex');
			});
		});

		it('shows needsRefresh provider with warning label', async () => {
			mockRequest.mockImplementation((method: string) => {
				if (method === 'models.list') return Promise.resolve({ models: MOCK_MODELS });
				if (method === 'auth.providers') {
					return Promise.resolve({
						providers: [
							{ id: 'anthropic', displayName: 'Anthropic', isAuthenticated: true },
							{
								id: 'anthropic-copilot',
								displayName: 'Copilot',
								isAuthenticated: true,
								needsRefresh: true,
							},
						],
					});
				}
				return Promise.resolve(null);
			});

			render(<NewSessionModal {...DEFAULT_PROPS} />);
			await waitFor(() => {
				const optgroups = document.querySelectorAll('optgroup');
				const labels = Array.from(optgroups).map((g) => g.getAttribute('label'));
				// Copilot is expiring — shown but with warning label
				expect(labels.some((l) => l?.includes('Copilot') && l.includes('⚠'))).toBe(true);
				// Anthropic is healthy — no warning
				expect(labels.some((l) => l === 'Anthropic')).toBe(true);
			});
		});

		it('does not show stale models from previous open when auth fails on re-open', async () => {
			// First open: both succeed — models populate
			let resolveAuth!: (v: unknown) => void;
			mockRequest.mockImplementation((method: string) => {
				if (method === 'models.list') return Promise.resolve({ models: MOCK_MODELS });
				if (method === 'auth.providers') return Promise.resolve(ALL_AUTH_OK);
				return Promise.resolve(null);
			});

			const { rerender } = render(<NewSessionModal {...DEFAULT_PROPS} isOpen={true} />);
			await waitFor(() => {
				expect(document.querySelectorAll('optgroup').length).toBeGreaterThan(0);
			});

			// Close modal
			rerender(<NewSessionModal {...DEFAULT_PROPS} isOpen={false} />);

			// Second open: auth fails — model picker must stay hidden
			mockRequest.mockImplementation((method: string) => {
				if (method === 'models.list') return Promise.resolve({ models: MOCK_MODELS });
				if (method === 'auth.providers') return Promise.reject(new Error('auth gone'));
				return Promise.resolve(null);
			});

			rerender(<NewSessionModal {...DEFAULT_PROPS} isOpen={true} />);
			await new Promise((r) => setTimeout(r, 50));

			// Stale models from first open must not re-appear
			expect(document.querySelectorAll('optgroup').length).toBe(0);
		});

		it('hides model picker entirely when auth.providers fetch fails', async () => {
			// auth.providers rejects — models.list resolves normally.
			// With Promise.all both outcomes are atomic: if auth fails the model picker
			// must not appear even though models resolved successfully.
			mockRequest.mockImplementation((method: string) => {
				if (method === 'models.list') return Promise.resolve({ models: MOCK_MODELS });
				if (method === 'auth.providers') return Promise.reject(new Error('unavailable'));
				return Promise.resolve(null);
			});

			render(<NewSessionModal {...DEFAULT_PROPS} />);
			// Give both promises time to settle
			await new Promise((r) => setTimeout(r, 50));
			// Model picker uses optgroups — none should exist when auth failed
			expect(document.querySelectorAll('optgroup').length).toBe(0);
			// The "Model (optional)" label must not be visible
			const labels = Array.from(document.querySelectorAll('label'));
			expect(labels.some((l) => l.textContent?.includes('Model'))).toBe(false);
		});
	});
});
