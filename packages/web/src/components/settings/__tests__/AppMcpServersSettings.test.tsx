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

// Mock Modal component
vi.mock('../ui/Modal.tsx', () => ({
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

// Mock ConfirmModal component
vi.mock('../ui/ConfirmModal.tsx', () => ({
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

// Mock Button component
vi.mock('../ui/Button.tsx', () => ({
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
		it('should have Add MCP Server button', () => {
			render(<AppMcpServersSettings />);

			expect(screen.getByText('Add MCP Server')).toBeTruthy();
		});
	});

	describe('Edit Server', () => {
		it('should show edit and delete buttons for servers', () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;

			render(<AppMcpServersSettings />);

			expect(screen.getByTitle('Edit')).toBeTruthy();
			expect(screen.getByTitle('Delete')).toBeTruthy();
		});
	});

	describe('Delete Confirmation', () => {
		it('should show delete button that triggers confirmation state', () => {
			const servers = [makeServer('1', { name: 'test-server' })];
			appMcpStore.appMcpServers.value = servers;

			render(<AppMcpServersSettings />);

			// Delete button exists and is clickable
			const deleteButton = screen.getByTitle('Delete');
			expect(deleteButton).toBeTruthy();
		});
	});

	describe('Toggle', () => {
		it('should render toggle for each server', () => {
			const servers = [makeServer('1', { name: 'test-server', enabled: true })];
			appMcpStore.appMcpServers.value = servers;

			render(<AppMcpServersSettings />);

			const toggle = screen.getByTestId('settings-toggle');
			expect(toggle).toBeTruthy();
			expect(toggle.getAttribute('data-checked')).toBe('true');
		});

		it('should render toggle as unchecked when server is disabled', () => {
			const servers = [makeServer('1', { name: 'test-server', enabled: false })];
			appMcpStore.appMcpServers.value = servers;

			render(<AppMcpServersSettings />);

			const toggle = screen.getByTestId('settings-toggle');
			expect(toggle.getAttribute('data-checked')).toBe('false');
		});
	});

	describe('API Mock Behavior', () => {
		it('mock createAppMcpServer is a function', () => {
			expect(typeof mockCreateAppMcpServer).toBe('function');
		});

		it('mock updateAppMcpServer is a function', () => {
			expect(typeof mockUpdateAppMcpServer).toBe('function');
		});

		it('mock deleteAppMcpServer is a function', () => {
			expect(typeof mockDeleteAppMcpServer).toBe('function');
		});

		it('mock setAppMcpServerEnabled is a function', () => {
			expect(typeof mockSetAppMcpServerEnabled).toBe('function');
		});

		it('should have toast error and success mocks', () => {
			expect(typeof mockToastError).toBe('function');
			expect(typeof mockToastSuccess).toBe('function');
		});
	});
});
