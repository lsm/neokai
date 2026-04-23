/**
 * Tests for AppMcpServersSettings Component
 *
 * Tests the application-level MCP server registry settings UI including:
 * - Server list display
 * - Add server form validation
 * - Edit server functionality
 * - Delete confirmation dialog
 * - Enable/disable toggle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';
import type { AppMcpServer } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mocks - must use vi.hoisted for proper hoisting with vi.mock
// ---------------------------------------------------------------------------

const {
	mockCreateAppMcpServer,
	mockUpdateAppMcpServer,
	mockDeleteAppMcpServer,
	mockSetAppMcpServerEnabled,
	mockToastError,
	mockToastSuccess,
	mockSubscribe,
	mockUnsubscribe,
} = vi.hoisted(() => ({
	mockCreateAppMcpServer: vi.fn(),
	mockUpdateAppMcpServer: vi.fn(),
	mockDeleteAppMcpServer: vi.fn(),
	mockSetAppMcpServerEnabled: vi.fn(),
	mockToastError: vi.fn(),
	mockToastSuccess: vi.fn(),
	mockSubscribe: vi.fn().mockResolvedValue(undefined),
	mockUnsubscribe: vi.fn(),
}));

// Mock the appMcpStore
vi.mock('../../../lib/app-mcp-store.ts', () => ({
	appMcpStore: {
		appMcpServers: { value: [] },
		loading: { value: false },
		error: { value: null },
		subscribe: mockSubscribe,
		unsubscribe: mockUnsubscribe,
	},
}));

// Mock api-helpers module
vi.mock('../../../lib/api-helpers.ts', () => ({
	createAppMcpServer: (...args: unknown[]) => mockCreateAppMcpServer(...args),
	updateAppMcpServer: (...args: unknown[]) => mockUpdateAppMcpServer(...args),
	deleteAppMcpServer: (...args: unknown[]) => mockDeleteAppMcpServer(...args),
	setAppMcpServerEnabled: (...args: unknown[]) => mockSetAppMcpServerEnabled(...args),
}));

// Mock toast module
vi.mock('../../../lib/toast.ts', () => ({
	toast: {
		error: (msg: string) => mockToastError(msg),
		success: (msg: string) => mockToastSuccess(msg),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

// Mock Modal component - correct path from __tests__/ is ../../ui/Modal.tsx
vi.mock('../../ui/Modal.tsx', () => ({
	Modal: ({
		isOpen,
		onClose,
		title,
		children,
	}: {
		isOpen: boolean;
		onClose: () => void;
		title: string;
		children: import('preact').ComponentChildren;
	}) =>
		isOpen ? (
			<div data-testid="modal">
				<h2 data-testid="modal-title">{title}</h2>
				<div data-testid="modal-content">{children}</div>
				<button data-testid="modal-close" onClick={onClose}>
					Close
				</button>
			</div>
		) : null,
}));

// Mock ConfirmModal component - correct path from __tests__/ is ../../ui/ConfirmModal.tsx
vi.mock('../../ui/ConfirmModal.tsx', () => ({
	ConfirmModal: ({
		isOpen,
		onClose,
		onConfirm,
		title,
		message,
		confirmText,
		isLoading,
	}: {
		isOpen: boolean;
		onClose: () => void;
		onConfirm: () => void;
		title: string;
		message: string;
		confirmText?: string;
		isLoading?: boolean;
	}) =>
		isOpen ? (
			<div data-testid="confirm-modal">
				<span data-testid="confirm-title">{title}</span>
				<span data-testid="confirm-message">{message}</span>
				<button data-testid="confirm-cancel" onClick={onClose}>
					Cancel
				</button>
				<button data-testid="confirm-ok" onClick={onConfirm} disabled={isLoading}>
					{confirmText ?? 'Confirm'}
				</button>
			</div>
		) : null,
}));

// Mock SettingsSection component - correct path is ../SettingsSection.tsx
vi.mock('../SettingsSection.tsx', () => ({
	SettingsSection: ({
		title,
		children,
	}: {
		title: string;
		children: import('preact').ComponentChildren;
	}) => (
		<div data-testid="settings-section">
			<h3>{title}</h3>
			<div>{children}</div>
		</div>
	),
	SettingsToggle: ({
		checked,
		onChange,
		disabled,
	}: {
		checked: boolean;
		onChange: (v: boolean) => void;
		disabled?: boolean;
	}) => (
		<button
			data-testid="settings-toggle"
			data-checked={String(checked)}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			Toggle
		</button>
	),
}));

// Mock Button component - correct path from __tests__/ is ../../ui/Button.tsx
vi.mock('../../ui/Button.tsx', () => ({
	Button: ({
		children,
		variant,
		size,
		type,
		onClick,
		disabled,
		loading,
	}: {
		children: import('preact').ComponentChildren;
		variant?: string;
		size?: string;
		type?: 'button' | 'submit';
		onClick?: () => void;
		disabled?: boolean;
		loading?: boolean;
	}) => (
		<button
			data-testid={`button-${variant || 'primary'}`}
			data-size={size}
			data-type={type}
			disabled={disabled || loading}
			onClick={onClick}
		>
			{loading && <span data-testid="button-loading">Loading...</span>}
			{children}
		</button>
	),
}));

// Import the component after mocks are set up
import { AppMcpServersSettings } from '../AppMcpServersSettings.tsx';
import { appMcpStore } from '../../../lib/app-mcp-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(id: string, overrides: Partial<AppMcpServer> = {}): AppMcpServer {
	return {
		id,
		name: `Server ${id}`,
		sourceType: 'stdio',
		command: 'npx',
		args: ['-y', '@some/server'],
		env: {},
		enabled: true,
		source: 'user',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppMcpServersSettings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		cleanup();

		// Reset store signals
		appMcpStore.appMcpServers.value = [];
		appMcpStore.loading.value = false;
		appMcpStore.error.value = null;

		// Default mock implementations
		mockCreateAppMcpServer.mockResolvedValue({
			server: makeServer('new', { name: 'new-server' }),
		});
		mockUpdateAppMcpServer.mockResolvedValue({ ok: true });
		mockDeleteAppMcpServer.mockResolvedValue({ success: true });
		mockSetAppMcpServerEnabled.mockResolvedValue({ ok: true });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	describe('Server List Display', () => {
		it('should show empty state when no servers', () => {
			appMcpStore.appMcpServers.value = [];

			render(<AppMcpServersSettings />);

			expect(screen.getByText(/No MCP servers configured/)).toBeTruthy();
		});

		it('should show loading state when loading', () => {
			appMcpStore.loading.value = true;
			appMcpStore.appMcpServers.value = [];

			render(<AppMcpServersSettings />);

			expect(screen.getByText('Loading servers...')).toBeTruthy();
		});

		it('should show error state when there is an error', () => {
			appMcpStore.error.value = 'Failed to connect';

			render(<AppMcpServersSettings />);

			expect(screen.getByText(/Failed to connect/)).toBeTruthy();
		});

		it('should display server name and source type', () => {
			const servers = [
				makeServer('1', { name: 'brave-search', sourceType: 'stdio' }),
				makeServer('2', { name: 'fetch-mcp', sourceType: 'http', url: 'http://localhost:8080' }),
			];
			appMcpStore.appMcpServers.value = servers;

			render(<AppMcpServersSettings />);

			expect(screen.getByText('brave-search')).toBeTruthy();
			expect(screen.getByText('fetch-mcp')).toBeTruthy();
			expect(screen.getByText('stdio')).toBeTruthy();
			expect(screen.getByText('http')).toBeTruthy();
		});

		it('should show description if present', () => {
			const servers = [makeServer('1', { name: 'test', description: 'A test server' })];
			appMcpStore.appMcpServers.value = servers;

			render(<AppMcpServersSettings />);

			expect(screen.getByText('A test server')).toBeTruthy();
		});

		it('should show the informational note about env vars', () => {
			render(<AppMcpServersSettings />);

			expect(screen.getByText(/env vars field below/)).toBeTruthy();
		});

		it('should show Add MCP Server button', () => {
			render(<AppMcpServersSettings />);

			expect(screen.getByText('Add MCP Server')).toBeTruthy();
		});

		it('should show delete and edit buttons for each server', () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;

			render(<AppMcpServersSettings />);

			expect(screen.getByTitle('Edit')).toBeTruthy();
			expect(screen.getByTitle('Delete')).toBeTruthy();
		});

		it('should show toggle for each server', () => {
			const servers = [makeServer('1', { name: 'test-server', enabled: true })];
			appMcpStore.appMcpServers.value = servers;

			render(<AppMcpServersSettings />);

			expect(screen.getByTestId('settings-toggle')).toBeTruthy();
		});
	});

	describe('Subscribe/Unsubscribe', () => {
		it('should call subscribe on mount', () => {
			render(<AppMcpServersSettings />);

			expect(mockSubscribe).toHaveBeenCalled();
		});
	});

	describe('Add Server Form', () => {
		it('should open add form modal when Add MCP Server button is clicked', () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByText('Add MCP Server'));

			expect(screen.getByTestId('modal')).toBeTruthy();
			expect(screen.getByTestId('modal-title').textContent).toBe('Add MCP Server');
		});

		it('should close form when Cancel button is clicked', () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByText('Add MCP Server'));
			expect(screen.getByTestId('modal')).toBeTruthy();

			// Use text content to find the cancel button inside the modal
			fireEvent.click(screen.getByText('Cancel'));
			expect(screen.queryByTestId('modal')).toBeNull();
		});

		it('should call createAppMcpServer with correct data when form is submitted', async () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			// Open form
			fireEvent.click(screen.getByText('Add MCP Server'));

			// Fill in name
			const nameInput = screen.getByPlaceholderText('e.g., brave-search');
			fireEvent.change(nameInput, { target: { value: 'test-server' } });

			// Fill in command (stdio type is default)
			const commandInput = screen.getByPlaceholderText('e.g., npx');
			fireEvent.change(commandInput, { target: { value: 'npx' } });

			// Submit form - use the text inside the modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(mockCreateAppMcpServer).toHaveBeenCalledWith(
					expect.objectContaining({
						name: 'test-server',
						sourceType: 'stdio',
						command: 'npx',
					})
				);
			});
		});

		it('should show validation error when name is empty', async () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			// Open form
			fireEvent.click(screen.getByText('Add MCP Server'));

			// Try to submit without filling name - click Add Server inside modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(screen.getByText('Name is required')).toBeTruthy();
			});
			expect(mockCreateAppMcpServer).not.toHaveBeenCalled();
		});

		it('should show validation error when command is empty for stdio type', async () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			// Open form
			fireEvent.click(screen.getByText('Add MCP Server'));

			// Fill name but not command
			const nameInput = screen.getByPlaceholderText('e.g., brave-search');
			fireEvent.change(nameInput, { target: { value: 'test-server' } });

			// Submit form - click Add Server inside modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(screen.getByText('Command is required for stdio servers')).toBeTruthy();
			});
			expect(mockCreateAppMcpServer).not.toHaveBeenCalled();
		});

		it('should show success toast after adding server', async () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			// Open form and fill required fields
			fireEvent.click(screen.getByText('Add MCP Server'));
			const nameInput = screen.getByPlaceholderText('e.g., brave-search');
			fireEvent.change(nameInput, { target: { value: 'test-server' } });
			const commandInput = screen.getByPlaceholderText('e.g., npx');
			fireEvent.change(commandInput, { target: { value: 'npx' } });

			// Submit form - click Add Server inside modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(mockToastSuccess).toHaveBeenCalledWith('Added "test-server"');
			});
		});

		it('should close modal after successful add', async () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			// Open form and fill required fields
			fireEvent.click(screen.getByText('Add MCP Server'));
			const nameInput = screen.getByPlaceholderText('e.g., brave-search');
			fireEvent.change(nameInput, { target: { value: 'test-server' } });
			const commandInput = screen.getByPlaceholderText('e.g., npx');
			fireEvent.change(commandInput, { target: { value: 'npx' } });

			// Submit form - click Add Server inside modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(screen.queryByTestId('modal')).toBeNull();
			});
		});

		it('should show error toast when add fails', async () => {
			appMcpStore.appMcpServers.value = [];
			mockCreateAppMcpServer.mockRejectedValueOnce(new Error('Failed to add server'));
			render(<AppMcpServersSettings />);

			// Open form and fill required fields
			fireEvent.click(screen.getByText('Add MCP Server'));
			const nameInput = screen.getByPlaceholderText('e.g., brave-search');
			fireEvent.change(nameInput, { target: { value: 'test-server' } });
			const commandInput = screen.getByPlaceholderText('e.g., npx');
			fireEvent.change(commandInput, { target: { value: 'npx' } });

			// Submit form - click Add Server inside modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Failed to add server');
			});
		});
	});

	describe('Edit Server', () => {
		it('should open edit form with pre-populated data when Edit button is clicked', () => {
			const servers = [
				makeServer('1', { name: 'test-server', command: 'npx', description: 'Test desc' }),
			];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByTitle('Edit'));

			expect(screen.getByTestId('modal')).toBeTruthy();
			expect(screen.getByTestId('modal-title').textContent).toBe('Edit MCP Server');
			// Name should be pre-populated
			expect((screen.getByDisplayValue('test-server') as HTMLInputElement).value).toBe(
				'test-server'
			);
		});

		it('should call updateAppMcpServer with correct data when form is submitted', async () => {
			const servers = [makeServer('1', { name: 'old-name', command: 'npx' })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			// Open edit form
			fireEvent.click(screen.getByTitle('Edit'));

			// Change name
			const nameInput = screen.getByDisplayValue('old-name');
			fireEvent.change(nameInput, { target: { value: 'updated-name' } });

			// Submit form - use Save Changes text inside modal
			fireEvent.click(screen.getByText('Save Changes'));

			await waitFor(() => {
				expect(mockUpdateAppMcpServer).toHaveBeenCalledWith(
					'1',
					expect.objectContaining({
						name: 'updated-name',
					})
				);
			});
		});

		it('should show success toast after updating server', async () => {
			const servers = [makeServer('1', { name: 'test-server', command: 'npx' })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			// Open edit form and change name
			fireEvent.click(screen.getByTitle('Edit'));
			const nameInput = screen.getByDisplayValue('test-server');
			fireEvent.change(nameInput, { target: { value: 'new-name' } });

			// Submit form - use Save Changes text inside modal
			fireEvent.click(screen.getByText('Save Changes'));

			await waitFor(() => {
				expect(mockToastSuccess).toHaveBeenCalledWith('Updated "new-name"');
			});
		});
	});

	describe('Delete Confirmation', () => {
		it('should show delete confirmation modal when Delete button is clicked', () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByTitle('Delete'));

			expect(screen.getByTestId('confirm-modal')).toBeTruthy();
			expect(screen.getByTestId('confirm-title').textContent).toBe('Delete MCP Server');
			expect(screen.getByTestId('confirm-message').textContent).toContain('test-server');
		});

		it('should close confirmation modal when Cancel is clicked', () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByTitle('Delete'));
			expect(screen.getByTestId('confirm-modal')).toBeTruthy();

			fireEvent.click(screen.getByTestId('confirm-cancel'));
			expect(screen.queryByTestId('confirm-modal')).toBeNull();
		});

		it('should call deleteAppMcpServer when confirm delete is clicked', async () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByTitle('Delete'));
			fireEvent.click(screen.getByTestId('confirm-ok'));

			await waitFor(() => {
				expect(mockDeleteAppMcpServer).toHaveBeenCalledWith('1');
			});
		});

		it('should show success toast after deleting server', async () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByTitle('Delete'));
			fireEvent.click(screen.getByTestId('confirm-ok'));

			await waitFor(() => {
				expect(mockToastSuccess).toHaveBeenCalledWith('Deleted "test-server"');
			});
		});

		it('should close confirmation modal after successful delete', async () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByTitle('Delete'));
			expect(screen.getByTestId('confirm-modal')).toBeTruthy();

			fireEvent.click(screen.getByTestId('confirm-ok'));

			await waitFor(() => {
				expect(screen.queryByTestId('confirm-modal')).toBeNull();
			});
		});

		it('should show error toast when delete fails', async () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;
			mockDeleteAppMcpServer.mockRejectedValueOnce(new Error('Delete failed'));
			render(<AppMcpServersSettings />);

			fireEvent.click(screen.getByTitle('Delete'));
			fireEvent.click(screen.getByTestId('confirm-ok'));

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Delete failed');
			});
		});
	});

	describe('Toggle', () => {
		it('should call setAppMcpServerEnabled when toggle is clicked', async () => {
			const servers = [makeServer('1', { name: 'test-server', enabled: true })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			const toggle = screen.getByTestId('settings-toggle');
			fireEvent.click(toggle);

			await waitFor(() => {
				expect(mockSetAppMcpServerEnabled).toHaveBeenCalledWith('1', false);
			});
		});

		it('should show success toast after toggling', async () => {
			const servers = [makeServer('1', { name: 'test-server', enabled: true })];
			appMcpStore.appMcpServers.value = servers;
			render(<AppMcpServersSettings />);

			const toggle = screen.getByTestId('settings-toggle');
			fireEvent.click(toggle);

			await waitFor(() => {
				expect(mockToastSuccess).toHaveBeenCalledWith('Disabled "test-server"');
			});
		});

		it('should show error toast when toggle fails', async () => {
			const servers = [makeServer('1', { name: 'test-server', enabled: true })];
			appMcpStore.appMcpServers.value = servers;
			mockSetAppMcpServerEnabled.mockRejectedValueOnce(new Error('Toggle failed'));
			render(<AppMcpServersSettings />);

			const toggle = screen.getByTestId('settings-toggle');
			fireEvent.click(toggle);

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Toggle failed');
			});
		});
	});

	describe('HTTP/SSE Server Validation', () => {
		it('should require URL for SSE source type', async () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			// Open form
			fireEvent.click(screen.getByText('Add MCP Server'));

			// Select SSE type using the select element
			const selectEl = screen.getByRole('combobox');
			fireEvent.change(selectEl, { target: { value: 'sse' } });

			// Fill name but not URL
			const nameInput = screen.getByPlaceholderText('e.g., brave-search');
			fireEvent.change(nameInput, { target: { value: 'sse-server' } });

			// Submit form - click Add Server inside modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(screen.getByText('URL is required for SSE/HTTP servers')).toBeTruthy();
			});
			expect(mockCreateAppMcpServer).not.toHaveBeenCalled();
		});

		it('should require URL for HTTP source type', async () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			// Open form
			fireEvent.click(screen.getByText('Add MCP Server'));

			// Select HTTP type
			const selectEl = screen.getByRole('combobox');
			fireEvent.change(selectEl, { target: { value: 'http' } });

			// Fill name but not URL
			const nameInput = screen.getByPlaceholderText('e.g., brave-search');
			fireEvent.change(nameInput, { target: { value: 'http-server' } });

			// Submit form - click Add Server inside modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(screen.getByText('URL is required for SSE/HTTP servers')).toBeTruthy();
			});
			expect(mockCreateAppMcpServer).not.toHaveBeenCalled();
		});

		it('should validate URL format for HTTP source type', async () => {
			appMcpStore.appMcpServers.value = [];
			render(<AppMcpServersSettings />);

			// Open form
			fireEvent.click(screen.getByText('Add MCP Server'));

			// Select HTTP type
			const selectEl = screen.getByRole('combobox');
			fireEvent.change(selectEl, { target: { value: 'http' } });

			// Fill name and invalid URL
			const nameInput = screen.getByPlaceholderText('e.g., brave-search');
			fireEvent.change(nameInput, { target: { value: 'http-server' } });

			const urlInput = screen.getByPlaceholderText('e.g., http://localhost:8080/sse');
			fireEvent.change(urlInput, { target: { value: 'invalid-url' } });

			// Submit form - click Add Server inside modal
			fireEvent.click(screen.getByText('Add Server'));

			await waitFor(() => {
				expect(screen.getByText('URL must start with http:// or https://')).toBeTruthy();
			});
			expect(mockCreateAppMcpServer).not.toHaveBeenCalled();
		});
	});
});
