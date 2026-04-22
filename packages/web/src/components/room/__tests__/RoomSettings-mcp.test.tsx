/**
 * Tests for RoomSettings MCP Servers section
 *
 * Covers:
 * - MCP Servers section renders when servers are registered
 * - Empty state renders when no servers are registered
 * - Toggle changes call setRoomMcpEnabled
 * - Reset to Global Defaults button calls resetRoomMcpToGlobal
 * - Per-room override badges display correctly
 * - Loading state displays while MCP stores are loading
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { RoomSettings } from '../RoomSettings';
import type { Room, AppMcpServer } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mocks - use vi.hoisted so they are available when vi.mock runs
// ---------------------------------------------------------------------------

// Mock appMcpStore
const mockAppMcpServersValue = vi.hoisted(() => [] as AppMcpServer[]);
const mockAppMcpSubscribe = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAppMcpUnsubscribe = vi.hoisted(() => vi.fn());

// Mock roomMcpStore
const mockRoomMcpOverridesValue = vi.hoisted(
	() => new Map<string, { serverId: string; enabled: boolean; name: string; sourceType: string }>()
);
const mockRoomMcpSubscribe = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRoomMcpUnsubscribe = vi.hoisted(() => vi.fn());
const mockGetEffectiveEnabled = vi.hoisted(() =>
	vi.fn((serverId: string, globalEnabled: boolean) => globalEnabled)
);

// Mock api-helpers
const mockSetRoomMcpEnabled = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const mockResetRoomMcpToGlobal = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));

// Mock toast
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/app-mcp-store.ts', () => ({
	appMcpStore: {
		appMcpServers: {
			value: mockAppMcpServersValue,
			subscribe: vi.fn(),
		},
		loading: { value: false },
		error: { value: null },
		subscribe: mockAppMcpSubscribe,
		unsubscribe: mockAppMcpUnsubscribe,
	},
}));

vi.mock('../../../lib/room-mcp-store.ts', () => ({
	roomMcpStore: {
		overrides: {
			value: mockRoomMcpOverridesValue,
			subscribe: vi.fn(),
		},
		loading: { value: false },
		error: { value: null },
		subscribe: mockRoomMcpSubscribe,
		unsubscribe: mockRoomMcpUnsubscribe,
		getEffectiveEnabled: mockGetEffectiveEnabled,
	},
}));

vi.mock('../../../lib/api-helpers.ts', () => ({
	setRoomMcpEnabled: mockSetRoomMcpEnabled,
	resetRoomMcpToGlobal: mockResetRoomMcpToGlobal,
}));

vi.mock('../../../lib/toast.ts', () => ({
	toast: {
		success: mockToastSuccess,
		error: mockToastError,
	},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMcpServer(id: string, overrides: Partial<AppMcpServer> = {}): AppMcpServer {
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

function makeRoom(overrides: Partial<Room> = {}): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		allowedPaths: [],
		sessionIds: [],
		status: 'active',
		createdAt: 1704067200000,
		updatedAt: 1704067200000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomSettings MCP Servers Section', () => {
	const ROOM_ID = 'room-1';

	beforeEach(() => {
		vi.clearAllMocks();

		// Reset store signals
		mockAppMcpServersValue.length = 0;
		mockRoomMcpOverridesValue.clear();
		mockGetEffectiveEnabled.mockImplementation(
			(_serverId: string, globalEnabled: boolean) => globalEnabled
		);
		mockSetRoomMcpEnabled.mockResolvedValue({ ok: true });
		mockResetRoomMcpToGlobal.mockResolvedValue({ ok: true });
	});

	afterEach(() => {
		cleanup();
	});

	// ---------------------------------------------------------------------------
	// Empty State
	// ---------------------------------------------------------------------------

	describe('Empty State', () => {
		it('should show empty state when no MCP servers are registered', async () => {
			const room = makeRoom({ id: ROOM_ID });

			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('No MCP servers configured');
			});
		});

		it('should show link to global settings in empty state', async () => {
			const room = makeRoom({ id: ROOM_ID });

			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				const link = document.querySelector('a');
				expect(link?.textContent).toContain('Add MCP servers in global settings');
			});
		});
	});

	// ---------------------------------------------------------------------------
	// MCP Servers List
	// ---------------------------------------------------------------------------

	describe('MCP Servers List', () => {
		it('should render MCP servers when registered', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1'), makeMcpServer('srv-2'));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('Server srv-1');
				expect(document.body.textContent).toContain('Server srv-2');
			});
		});

		it('should show loading state while MCP stores are loading', async () => {
			const { appMcpStore } = await import('../../../lib/app-mcp-store.ts');
			const { roomMcpStore } = await import('../../../lib/room-mcp-store.ts');

			// Access the real store's loading signal through the module
			appMcpStore.loading.value = true;
			roomMcpStore.loading.value = true;

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('Loading MCP servers...');
			});

			// Reset
			appMcpStore.loading.value = false;
			roomMcpStore.loading.value = false;
		});

		it('should check toggle based on global enabled value when no override exists', async () => {
			mockAppMcpServersValue.push(
				makeMcpServer('srv-1', { enabled: true }),
				makeMcpServer('srv-2', { enabled: false })
			);

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
				expect((checkboxes[0] as HTMLInputElement).checked).toBe(true); // srv-1 global enabled=true
				expect((checkboxes[1] as HTMLInputElement).checked).toBe(false); // srv-2 global enabled=false
			});
		});

		it('should show room override badge when per-room override exists', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1', { enabled: true }));
			mockRoomMcpOverridesValue.set('srv-1', {
				serverId: 'srv-1',
				enabled: false,
				name: 'Server srv-1',
				sourceType: 'stdio',
			});
			mockGetEffectiveEnabled.mockImplementation((serverId: string, _globalEnabled: boolean) => {
				const override = mockRoomMcpOverridesValue.get(serverId);
				return override !== undefined ? override.enabled : false;
			});

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('room override');
			});
		});

		it('should show disabled globally badge when server is disabled globally with no override', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1', { enabled: false }));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('disabled globally');
			});
		});
	});

	// ---------------------------------------------------------------------------
	// Toggle Behavior
	// ---------------------------------------------------------------------------

	describe('Toggle Behavior', () => {
		it('should call setRoomMcpEnabled when toggle is clicked', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1', { enabled: true }));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				fireEvent.click(checkbox);
			});

			expect(mockSetRoomMcpEnabled).toHaveBeenCalledWith(ROOM_ID, 'srv-1', false);
		});

		it('should show error toast when toggle fails', async () => {
			mockSetRoomMcpEnabled.mockRejectedValue(new Error('Failed to toggle'));
			mockAppMcpServersValue.push(makeMcpServer('srv-1', { enabled: true }));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				fireEvent.click(checkbox);
			});

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalled();
			});
		});
	});

	// ---------------------------------------------------------------------------
	// Reset to Global Defaults
	// ---------------------------------------------------------------------------

	describe('Reset to Global Defaults', () => {
		it('should show Reset to Global Defaults button when servers are registered', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1'));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const resetButton = buttons.find((b) =>
					b.textContent?.includes('Reset to Global Defaults')
				);
				expect(resetButton).toBeDefined();
			});
		});

		it('should call resetRoomMcpToGlobal when Reset button is clicked', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1'));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const resetButton = buttons.find((b) =>
					b.textContent?.includes('Reset to Global Defaults')
				);
				if (resetButton) fireEvent.click(resetButton);
			});

			expect(mockResetRoomMcpToGlobal).toHaveBeenCalledWith(ROOM_ID);
		});

		it('should show success toast after reset', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1'));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const resetButton = buttons.find((b) =>
					b.textContent?.includes('Reset to Global Defaults')
				);
				if (resetButton) fireEvent.click(resetButton);
			});

			await waitFor(() => {
				expect(mockToastSuccess).toHaveBeenCalledWith('Reset to global defaults');
			});
		});

		it('should show error toast when reset fails', async () => {
			mockResetRoomMcpToGlobal.mockRejectedValue(new Error('Failed to reset'));
			mockAppMcpServersValue.push(makeMcpServer('srv-1'));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const resetButton = buttons.find((b) =>
					b.textContent?.includes('Reset to Global Defaults')
				);
				if (resetButton) fireEvent.click(resetButton);
			});

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Failed to reset to global defaults');
			});
		});
	});

	// ---------------------------------------------------------------------------
	// Source Type Label
	// ---------------------------------------------------------------------------

	describe('Source Type Label', () => {
		it('should display source type correctly for stdio servers', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1', { sourceType: 'stdio' }));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('stdio');
			});
		});

		it('should display source type correctly for SSE servers', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1', { sourceType: 'sse' }));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('SSE');
			});
		});

		it('should display source type correctly for HTTP servers', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1', { sourceType: 'http' }));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('HTTP');
			});
		});
	});

	// ---------------------------------------------------------------------------
	// Description Display
	// ---------------------------------------------------------------------------

	describe('Description Display', () => {
		it('should display description when server has one', async () => {
			mockAppMcpServersValue.push(makeMcpServer('srv-1', { description: 'Test MCP server' }));

			const room = makeRoom({ id: ROOM_ID });
			render(<RoomSettings room={room} onSave={vi.fn()} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('Test MCP server');
			});
		});
	});
});
