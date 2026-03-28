/**
 * Tests for NeoSettings component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockRequest, mockGetHub, mockClearSession, mockToastError, mockToastSuccess } = vi.hoisted(
	() => {
		const mockRequest = vi.fn();
		const mockGetHub = vi.fn();
		const mockClearSession = vi.fn();
		const mockToastError = vi.fn();
		const mockToastSuccess = vi.fn();
		return { mockRequest, mockGetHub, mockClearSession, mockToastError, mockToastSuccess };
	}
);

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		getHub: () => mockGetHub(),
	},
}));

vi.mock('../../../lib/neo-store', () => ({
	neoStore: {
		clearSession: () => mockClearSession(),
	},
}));

vi.mock('../../../lib/toast.ts', () => ({
	toast: {
		error: (msg: string) => mockToastError(msg),
		success: (msg: string) => mockToastSuccess(msg),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHub(requestImpl?: (method: string, params: unknown) => unknown) {
	return {
		request: requestImpl ? vi.fn().mockImplementation(requestImpl) : mockRequest,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { NeoSettings } from '../NeoSettings.tsx';

describe('NeoSettings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: getSettings returns balanced + null model
		const hub = makeHub((method) => {
			if (method === 'neo.getSettings') {
				return Promise.resolve({ securityMode: 'balanced', model: null });
			}
			return Promise.resolve({ success: true, securityMode: 'balanced', model: null });
		});
		mockGetHub.mockResolvedValue(hub);
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the Neo Agent section heading', async () => {
		render(<NeoSettings />);
		await waitFor(() => {
			expect(screen.getByText('Neo Agent')).toBeTruthy();
		});
	});

	it('renders security mode selector', async () => {
		render(<NeoSettings />);
		await waitFor(() => {
			expect(screen.getByText('Security Mode')).toBeTruthy();
		});
	});

	it('renders model selector', async () => {
		render(<NeoSettings />);
		await waitFor(() => {
			expect(screen.getByText('Model')).toBeTruthy();
		});
	});

	it('renders clear session button', async () => {
		render(<NeoSettings />);
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Clear Session' })).toBeTruthy();
		});
	});

	it('loads settings on mount and sets security mode', async () => {
		const hub = makeHub((method) => {
			if (method === 'neo.getSettings') {
				return Promise.resolve({ securityMode: 'conservative', model: null });
			}
			return Promise.resolve({});
		});
		mockGetHub.mockResolvedValue(hub);

		render(<NeoSettings />);

		await waitFor(() => {
			const selects = screen.getAllByRole('combobox');
			// First select is security mode
			expect((selects[0] as HTMLSelectElement).value).toBe('conservative');
		});
	});

	it('loads settings on mount and sets model', async () => {
		const hub = makeHub((method) => {
			if (method === 'neo.getSettings') {
				return Promise.resolve({ securityMode: 'balanced', model: 'opus' });
			}
			return Promise.resolve({});
		});
		mockGetHub.mockResolvedValue(hub);

		render(<NeoSettings />);

		await waitFor(() => {
			const selects = screen.getAllByRole('combobox');
			const modelSelect = selects[1] as HTMLSelectElement;
			expect(modelSelect.value).toBe('opus');
		});
	});

	it('calls neo.updateSettings when security mode changes', async () => {
		const requestFn = vi.fn().mockImplementation((method) => {
			if (method === 'neo.getSettings') {
				return Promise.resolve({ securityMode: 'balanced', model: null });
			}
			return Promise.resolve({ success: true });
		});
		const hub = { request: requestFn };
		mockGetHub.mockResolvedValue(hub);

		render(<NeoSettings />);

		// Wait for settings to load
		await waitFor(() => {
			expect(screen.getByText('Security Mode')).toBeTruthy();
		});

		const selects = screen.getAllByRole('combobox');
		fireEvent.change(selects[0], { target: { value: 'autonomous' } });

		await waitFor(() => {
			expect(requestFn).toHaveBeenCalledWith('neo.updateSettings', { securityMode: 'autonomous' });
		});
	});

	it('calls neo.updateSettings when model changes', async () => {
		const requestFn = vi.fn().mockImplementation((method) => {
			if (method === 'neo.getSettings') {
				return Promise.resolve({ securityMode: 'balanced', model: null });
			}
			return Promise.resolve({ success: true });
		});
		const hub = { request: requestFn };
		mockGetHub.mockResolvedValue(hub);

		render(<NeoSettings />);

		await waitFor(() => {
			expect(screen.getByText('Model')).toBeTruthy();
		});

		const selects = screen.getAllByRole('combobox');
		fireEvent.change(selects[1], { target: { value: 'sonnet' } });

		await waitFor(() => {
			expect(requestFn).toHaveBeenCalledWith('neo.updateSettings', { model: 'sonnet' });
		});
	});

	it('treats empty string model value as null when persisting', async () => {
		const requestFn = vi.fn().mockImplementation((method) => {
			if (method === 'neo.getSettings') {
				return Promise.resolve({ securityMode: 'balanced', model: 'opus' });
			}
			return Promise.resolve({ success: true });
		});
		const hub = { request: requestFn };
		mockGetHub.mockResolvedValue(hub);

		render(<NeoSettings />);

		await waitFor(() => {
			const selects = screen.getAllByRole('combobox');
			expect((selects[1] as HTMLSelectElement).value).toBe('opus');
		});

		const selects = screen.getAllByRole('combobox');
		fireEvent.change(selects[1], { target: { value: '' } });

		await waitFor(() => {
			expect(requestFn).toHaveBeenCalledWith('neo.updateSettings', { model: null });
		});
	});

	it('shows confirmation UI when Clear Session is clicked', async () => {
		render(<NeoSettings />);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Clear Session' })).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Clear Session' }));

		expect(screen.getByText('Are you sure?')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
	});

	it('cancels clear session dialog when Cancel is clicked', async () => {
		render(<NeoSettings />);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Clear Session' })).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Clear Session' }));
		expect(screen.getByText('Are you sure?')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText('Are you sure?')).toBeNull();
		expect(screen.getByRole('button', { name: 'Clear Session' })).toBeTruthy();
	});

	it('calls neoStore.clearSession() on confirm and shows success toast', async () => {
		mockClearSession.mockResolvedValue({ success: true });

		render(<NeoSettings />);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Clear Session' })).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Clear Session' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		await waitFor(() => {
			expect(mockClearSession).toHaveBeenCalledOnce();
			expect(mockToastSuccess).toHaveBeenCalledWith('Neo session cleared');
		});

		// Confirmation dialog should be dismissed
		expect(screen.queryByText('Are you sure?')).toBeNull();
	});

	it('shows error toast when clearSession fails', async () => {
		mockClearSession.mockResolvedValue({ success: false, error: 'Session not found' });

		render(<NeoSettings />);

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Clear Session' })).toBeTruthy();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Clear Session' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith('Session not found');
		});
	});

	it('shows error toast when getSettings throws', async () => {
		mockGetHub.mockRejectedValue(new Error('Connection error'));

		render(<NeoSettings />);

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith('Failed to load Neo settings');
		});
	});

	it('reverts security mode on update failure', async () => {
		const requestFn = vi.fn().mockImplementation((method) => {
			if (method === 'neo.getSettings') {
				return Promise.resolve({ securityMode: 'balanced', model: null });
			}
			return Promise.reject(new Error('Network error'));
		});
		const hub = { request: requestFn };
		mockGetHub.mockResolvedValue(hub);

		render(<NeoSettings />);

		await waitFor(() => {
			const selects = screen.getAllByRole('combobox');
			expect((selects[0] as HTMLSelectElement).value).toBe('balanced');
		});

		const selects = screen.getAllByRole('combobox');
		fireEvent.change(selects[0], { target: { value: 'autonomous' } });

		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith('Failed to update security mode');
		});

		// Should revert to 'balanced'
		await waitFor(() => {
			const afterSelects = screen.getAllByRole('combobox');
			expect((afterSelects[0] as HTMLSelectElement).value).toBe('balanced');
		});
	});
});
