// @ts-nocheck
/**
 * Tests for ContextPanel Component
 *
 * Tests the context panel that shows SessionList or RoomList based on
 * navigation section, with mobile drawer behavior and connection status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { AuthStatus, ApiConnectionState } from '@neokai/shared';

// Define vi.fn() in vi.hoisted
const {
	mockCreateSession,
	mockNavigateToSession,
	mockNavigateToRoom,
	mockCreateRoom,
	mockToastError,
	mockToastSuccess,
	mockReconnect,
} = vi.hoisted(() => ({
	mockCreateSession: vi.fn(),
	mockNavigateToSession: vi.fn(),
	mockNavigateToRoom: vi.fn(),
	mockCreateRoom: vi.fn().mockResolvedValue({ id: 'room-1', name: 'Test Room' }),
	mockToastError: vi.fn(),
	mockToastSuccess: vi.fn(),
	mockReconnect: vi.fn(),
}));

// Define signals that will be used in mocks
let mockNavSectionSignal: ReturnType<typeof signal<string>>;
let mockContextPanelOpenSignal: ReturnType<typeof signal<boolean>>;
let mockConnectionStateSignal: ReturnType<typeof signal<string>>;
let mockAuthStatusSignal: ReturnType<typeof signal<AuthStatus | null>>;
let mockApiConnectionStatusSignal: ReturnType<typeof signal<ApiConnectionState | null>>;
let mockRoomsSignal: ReturnType<typeof signal<any[]>>;
let mockSessionsSignal: ReturnType<typeof signal<any[]>>;
let mockHasArchivedSessionsSignal: ReturnType<typeof signal<boolean>>;
let mockGlobalSettingsSignal: ReturnType<typeof signal<any>>;

// Mock the signals module
vi.mock('../../lib/signals.ts', () => ({
	get navSectionSignal() {
		return mockNavSectionSignal;
	},
	get contextPanelOpenSignal() {
		return mockContextPanelOpenSignal;
	},
}));

// Mock the state module - include all exports needed by SessionList and ContextPanel
vi.mock('../../lib/state.ts', () => ({
	get connectionState() {
		return mockConnectionStateSignal;
	},
	get authStatus() {
		return computed(() => mockAuthStatusSignal.value);
	},
	get apiConnectionStatus() {
		return computed(() => mockApiConnectionStatusSignal.value);
	},
	// SessionList needs these
	get sessions() {
		return computed(() => mockSessionsSignal.value);
	},
	get hasArchivedSessions() {
		return computed(() => mockHasArchivedSessionsSignal.value);
	},
	get globalSettings() {
		return computed(() => mockGlobalSettingsSignal.value);
	},
}));

// Mock the connection-manager module
vi.mock('../../lib/connection-manager.ts', () => ({
	connectionManager: {
		reconnect: mockReconnect,
	},
}));

// Mock the api-helpers module
vi.mock('../../lib/api-helpers.ts', () => ({
	createSession: mockCreateSession,
	updateGlobalSettings: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock the toast module
vi.mock('../../lib/toast.ts', () => ({
	toast: {
		error: mockToastError,
		success: mockToastSuccess,
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

// Mock the router module
vi.mock('../../lib/router.ts', () => ({
	navigateToSession: mockNavigateToSession,
	navigateToRoom: mockNavigateToRoom,
}));

// Mock the lobby-store module
vi.mock('../../lib/lobby-store.ts', () => ({
	get lobbyStore() {
		return {
			rooms: mockRoomsSignal,
			createRoom: mockCreateRoom,
		};
	},
}));

// Mock the design-tokens module
vi.mock('../../lib/design-tokens.ts', () => ({
	borderColors: {
		ui: {
			default: 'border-dark-700',
		},
	},
}));

// Initialize signals after mocks are set up
mockNavSectionSignal = signal<string>('chats');
mockContextPanelOpenSignal = signal<boolean>(false);
mockConnectionStateSignal = signal<string>('connected');
mockAuthStatusSignal = signal<AuthStatus | null>({ isAuthenticated: true });
mockApiConnectionStatusSignal = signal<ApiConnectionState | null>({ status: 'connected' });
mockRoomsSignal = signal<any[]>([]);
mockSessionsSignal = signal<any[]>([]);
mockHasArchivedSessionsSignal = signal<boolean>(false);
mockGlobalSettingsSignal = signal<any>({ showArchived: false });

import { ContextPanel } from '../ContextPanel';

describe('ContextPanel', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		// Reset signals to default values
		mockNavSectionSignal.value = 'chats';
		mockContextPanelOpenSignal.value = false;
		mockConnectionStateSignal.value = 'connected';
		mockAuthStatusSignal.value = { isAuthenticated: true };
		mockApiConnectionStatusSignal.value = { status: 'connected' };
		mockRoomsSignal.value = [];
		mockSessionsSignal.value = [];
		mockHasArchivedSessionsSignal.value = false;
		mockGlobalSettingsSignal.value = { showArchived: false };
	});

	afterEach(() => {
		cleanup();
	});

	describe('Section Content Rendering', () => {
		it('should render SessionList when navSection is chats', () => {
			mockNavSectionSignal.value = 'chats';

			const { container } = render(<ContextPanel />);

			// SessionList renders with overflow-y-auto class
			expect(container.querySelector('.overflow-y-auto')).toBeTruthy();
		});

		it('should render RoomList when navSection is rooms', () => {
			mockNavSectionSignal.value = 'rooms';

			const { container } = render(<ContextPanel />);

			// RoomList renders with overflow-y-auto class
			expect(container.querySelector('.overflow-y-auto')).toBeTruthy();
		});

		it('should render projects placeholder when navSection is projects', () => {
			mockNavSectionSignal.value = 'projects';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Projects coming soon');
			expect(container.textContent).toContain('Organize rooms into projects');
		});

		it('should render settings placeholder when navSection is settings', () => {
			mockNavSectionSignal.value = 'settings';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Settings');
			expect(container.textContent).toContain('Click the settings icon to configure');
		});
	});

	describe('Header Title', () => {
		it('should show Chats title when navSection is chats', () => {
			mockNavSectionSignal.value = 'chats';

			render(<ContextPanel />);

			expect(screen.getByRole('heading', { name: 'Chats' })).toBeTruthy();
		});

		it('should show Rooms title when navSection is rooms', () => {
			mockNavSectionSignal.value = 'rooms';

			render(<ContextPanel />);

			expect(screen.getByRole('heading', { name: 'Rooms' })).toBeTruthy();
		});

		it('should show Projects title when navSection is projects', () => {
			mockNavSectionSignal.value = 'projects';

			render(<ContextPanel />);

			expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
		});

		it('should show Settings title when navSection is settings', () => {
			mockNavSectionSignal.value = 'settings';

			render(<ContextPanel />);

			expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
		});
	});

	describe('Action Button', () => {
		it('should show New Session button when navSection is chats', () => {
			mockNavSectionSignal.value = 'chats';

			render(<ContextPanel />);

			expect(screen.getByRole('button', { name: /New Session/i })).toBeTruthy();
		});

		it('should show Create Room button when navSection is rooms', () => {
			mockNavSectionSignal.value = 'rooms';

			render(<ContextPanel />);

			expect(screen.getByRole('button', { name: /Create Room/i })).toBeTruthy();
		});

		it('should not show action button for projects section', () => {
			mockNavSectionSignal.value = 'projects';

			const { container } = render(<ContextPanel />);

			// No action button for projects
			expect(container.querySelector('button[class*="bg-blue-600"]')).toBeNull();
		});

		it('should not show action button for settings section', () => {
			mockNavSectionSignal.value = 'settings';

			const { container } = render(<ContextPanel />);

			// No action button for settings
			expect(container.querySelector('button[class*="bg-blue-600"]')).toBeNull();
		});

		it('should disable action button when not connected', () => {
			mockNavSectionSignal.value = 'chats';
			mockConnectionStateSignal.value = 'disconnected';

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /New Session/i });
			expect(button.hasAttribute('disabled')).toBe(true);
		});

		it('should disable action button when not authenticated', () => {
			mockNavSectionSignal.value = 'chats';
			mockAuthStatusSignal.value = { isAuthenticated: false };

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /New Session/i });
			expect(button.hasAttribute('disabled')).toBe(true);
		});

		it('should enable action button when connected and authenticated', () => {
			mockNavSectionSignal.value = 'chats';
			mockConnectionStateSignal.value = 'connected';
			mockAuthStatusSignal.value = { isAuthenticated: true };

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /New Session/i });
			expect(button.hasAttribute('disabled')).toBe(false);
		});
	});

	describe('Create Session Action', () => {
		it('should call createSession when New Session clicked', async () => {
			mockNavSectionSignal.value = 'chats';
			mockCreateSession.mockResolvedValue({ sessionId: 'session-1' });

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /New Session/i });
			fireEvent.click(button);

			expect(mockCreateSession).toHaveBeenCalledWith({ workspacePath: undefined });
		});

		it('should show error toast when createSession fails', async () => {
			mockNavSectionSignal.value = 'chats';
			mockCreateSession.mockRejectedValue(new Error('Network error'));

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /New Session/i });
			fireEvent.click(button);

			await vi.waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Network error');
			});
		});

		it('should not call createSession when not connected (button disabled)', async () => {
			mockNavSectionSignal.value = 'chats';
			mockConnectionStateSignal.value = 'disconnected';

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /New Session/i });
			// Button is disabled, click should not trigger the handler
			fireEvent.click(button);

			// createSession should not be called since button is disabled
			expect(mockCreateSession).not.toHaveBeenCalled();
		});
	});

	describe('Create Room Action', () => {
		it('should call createRoom when Create Room clicked', async () => {
			mockNavSectionSignal.value = 'rooms';
			mockCreateRoom.mockResolvedValue({ id: 'room-1', name: 'Test Room' });

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /Create Room/i });
			fireEvent.click(button);

			expect(mockCreateRoom).toHaveBeenCalled();
		});

		it('should navigate to room after creation', async () => {
			mockNavSectionSignal.value = 'rooms';
			mockCreateRoom.mockResolvedValue({ id: 'room-123', name: 'New Room' });

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /Create Room/i });
			fireEvent.click(button);

			await vi.waitFor(() => {
				expect(mockNavigateToRoom).toHaveBeenCalledWith('room-123');
			});
		});

		it('should show error toast when createRoom fails', async () => {
			mockNavSectionSignal.value = 'rooms';
			mockCreateRoom.mockRejectedValue(new Error('Failed to create room'));

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: /Create Room/i });
			fireEvent.click(button);

			await vi.waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Failed to create room');
			});
		});
	});

	describe('Footer - Daemon Connection Status', () => {
		it('should show Connected status when connected', () => {
			mockConnectionStateSignal.value = 'connected';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Daemon');
			expect(container.textContent).toContain('Connected');
		});

		it('should show Connecting status when connecting', () => {
			mockConnectionStateSignal.value = 'connecting';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Connecting...');
		});

		it('should show Reconnecting status when reconnecting', () => {
			mockConnectionStateSignal.value = 'reconnecting';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Reconnecting...');
		});

		it('should show Offline status when disconnected', () => {
			mockConnectionStateSignal.value = 'disconnected';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Offline');
		});

		it('should show Error status when connection has error', () => {
			mockConnectionStateSignal.value = 'error';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Error');
		});

		it('should show Error status when connection failed', () => {
			mockConnectionStateSignal.value = 'failed';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Error');
		});

		it('should show Reconnect button when disconnected', () => {
			mockConnectionStateSignal.value = 'disconnected';

			render(<ContextPanel />);

			expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
		});

		it('should show Reconnect button when error', () => {
			mockConnectionStateSignal.value = 'error';

			render(<ContextPanel />);

			expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
		});

		it('should call reconnect when Reconnect button clicked', () => {
			mockConnectionStateSignal.value = 'disconnected';

			render(<ContextPanel />);

			const button = screen.getByRole('button', { name: 'Reconnect' });
			fireEvent.click(button);

			expect(mockReconnect).toHaveBeenCalled();
		});

		it('should not show Reconnect button when connected', () => {
			mockConnectionStateSignal.value = 'connected';

			const { container } = render(<ContextPanel />);

			expect(container.textContent).not.toContain('Reconnect');
		});
	});

	describe('Footer - API Connection Status', () => {
		it('should show Connected status when API is connected', () => {
			mockApiConnectionStatusSignal.value = { status: 'connected' };

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Claude API');
			expect(container.textContent).toContain('Connected');
		});

		it('should show Degraded status when API is degraded', () => {
			mockApiConnectionStatusSignal.value = { status: 'degraded' };

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Degraded');
		});

		it('should show Offline status when API is disconnected', () => {
			mockApiConnectionStatusSignal.value = { status: 'disconnected' };

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Offline');
		});

		it('should show Unknown status when API status is null', () => {
			mockApiConnectionStatusSignal.value = null;

			const { container } = render(<ContextPanel />);

			expect(container.textContent).toContain('Unknown');
		});
	});

	describe('Mobile Drawer Behavior', () => {
		it('should show backdrop when panel is open', () => {
			mockContextPanelOpenSignal.value = true;

			const { container } = render(<ContextPanel />);

			const backdrop = container.querySelector('.bg-black\\/50');
			expect(backdrop).toBeTruthy();
		});

		it('should not show backdrop when panel is closed', () => {
			mockContextPanelOpenSignal.value = false;

			const { container } = render(<ContextPanel />);

			const backdrop = container.querySelector('.bg-black\\/50');
			expect(backdrop).toBeNull();
		});

		it('should close panel when backdrop is clicked', () => {
			mockContextPanelOpenSignal.value = true;

			const { container } = render(<ContextPanel />);

			const backdrop = container.querySelector('.bg-black\\/50');
			fireEvent.click(backdrop!);

			expect(mockContextPanelOpenSignal.value).toBe(false);
		});

		it('should close panel when close button is clicked', () => {
			mockContextPanelOpenSignal.value = true;

			const { container } = render(<ContextPanel />);

			// Close button has title "Close panel"
			const closeButton = container.querySelector('button[title="Close panel"]');
			fireEvent.click(closeButton!);

			expect(mockContextPanelOpenSignal.value).toBe(false);
		});

		it('should show close button on mobile only', () => {
			mockContextPanelOpenSignal.value = true;

			const { container } = render(<ContextPanel />);

			const closeButton = container.querySelector('button[title="Close panel"]');
			expect(closeButton?.className).toContain('md:hidden');
		});

		it('backdrop should have md:hidden class', () => {
			mockContextPanelOpenSignal.value = true;

			const { container } = render(<ContextPanel />);

			const backdrop = container.querySelector('.bg-black\\/50');
			expect(backdrop?.className).toContain('md:hidden');
		});
	});

	describe('Panel Visibility CSS Classes', () => {
		it('should have w-70 class for 280px width', () => {
			const { container } = render(<ContextPanel />);

			// Find the panel div (not the backdrop)
			const panel = container.querySelector('.w-70');
			expect(panel).toBeTruthy();
		});

		it('should have fixed class for mobile', () => {
			const { container } = render(<ContextPanel />);

			// The main panel has fixed positioning
			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('fixed');
		});

		it('should have md:relative for desktop positioning', () => {
			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('md:relative');
		});

		it('should have -translate-x-full when closed on mobile', () => {
			mockContextPanelOpenSignal.value = false;

			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('-translate-x-full');
		});

		it('should have translate-x-0 when open on mobile', () => {
			mockContextPanelOpenSignal.value = true;

			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('translate-x-0');
		});

		it('should have md:translate-x-0 to always show on desktop', () => {
			mockContextPanelOpenSignal.value = false;

			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('md:translate-x-0');
		});

		it('should have transition classes for smooth animation', () => {
			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('transition-transform');
			expect(panel?.className).toContain('duration-300');
		});

		it('should have z-40 for mobile stacking', () => {
			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('z-40');
		});

		it('should have md:z-auto for desktop stacking', () => {
			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('md:z-auto');
		});
	});

	describe('Signal Reactivity', () => {
		it('should update header when navSectionSignal changes', () => {
			mockNavSectionSignal.value = 'chats';
			const { rerender } = render(<ContextPanel />);

			expect(screen.getByRole('heading', { name: 'Chats' })).toBeTruthy();

			mockNavSectionSignal.value = 'rooms';
			rerender(<ContextPanel />);

			expect(screen.getByRole('heading', { name: 'Rooms' })).toBeTruthy();
		});

		it('should show backdrop when contextPanelOpenSignal becomes true', () => {
			mockContextPanelOpenSignal.value = false;
			const { container, rerender } = render(<ContextPanel />);

			expect(container.querySelector('.bg-black\\/50')).toBeNull();

			mockContextPanelOpenSignal.value = true;
			rerender(<ContextPanel />);

			expect(container.querySelector('.bg-black\\/50')).toBeTruthy();
		});

		it('should update connection status when connectionState changes', () => {
			mockConnectionStateSignal.value = 'connected';
			const { container, rerender } = render(<ContextPanel />);

			expect(container.textContent).toContain('Connected');

			mockConnectionStateSignal.value = 'disconnected';
			rerender(<ContextPanel />);

			expect(container.textContent).toContain('Offline');
		});
	});

	describe('Layout Structure', () => {
		it('should have flex flex-col for vertical layout', () => {
			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('flex-col');
		});

		it('should have header section with border', () => {
			const { container } = render(<ContextPanel />);

			const header = container.querySelector('.border-b');
			expect(header).toBeTruthy();
		});

		it('should have footer section with border', () => {
			const { container } = render(<ContextPanel />);

			const footer = container.querySelector('.border-t');
			expect(footer).toBeTruthy();
		});

		it('should have full screen height', () => {
			const { container } = render(<ContextPanel />);

			const panel = container.querySelector('.w-70');
			expect(panel?.className).toContain('h-screen');
		});
	});
});
