// @ts-nocheck
/**
 * Unit tests for SpaceSettings
 *
 * Tests:
 * - Renders space name, description, workspace path
 * - Save Changes button only shown when form is dirty
 * - Calls space.update RPC with trimmed values on save
 * - Discard button resets form to original values
 * - Shows error when not connected
 * - Archive button calls space.archive and navigates away
 * - Delete button calls space.delete and navigates away
 * - Archive button is disabled when space is already archived
 * - Export bundle button calls spaceExport.bundle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';

const mockRequest = vi.fn();
const mockGetHubIfConnected = vi.fn();
const mockNavigateToSpaces = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockDownloadBundle = vi.fn();

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		get getHubIfConnected() {
			return mockGetHubIfConnected;
		},
	},
}));

vi.mock('../../../lib/router', () => ({
	get navigateToSpaces() {
		return mockNavigateToSpaces;
	},
}));

vi.mock('../../../lib/toast', () => ({
	toast: {
		get success() {
			return mockToastSuccess;
		},
		get error() {
			return mockToastError;
		},
	},
}));

vi.mock('../export-import-utils', () => ({
	downloadBundle: (...args) => mockDownloadBundle(...args),
}));

vi.mock('../../ui/Button', () => ({
	Button: ({ children, onClick, type, loading, disabled, variant }) => (
		<button
			type={type ?? 'button'}
			onClick={onClick}
			disabled={disabled || loading}
			data-variant={variant}
		>
			{loading ? 'Loading...' : children}
		</button>
	),
}));

import { SpaceSettings } from '../SpaceSettings';
import type { Space } from '@neokai/shared';

function makeSpace(overrides: Partial<Space> = {}): Space {
	return {
		id: 'space-1',
		name: 'My Space',
		workspacePath: '/projects/my-space',
		description: 'Original description',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

// Mock window.confirm globally
const mockConfirm = vi.fn();
beforeEach(() => {
	(globalThis as unknown as { confirm: unknown }).confirm = mockConfirm;
});

describe('SpaceSettings', () => {
	beforeEach(() => {
		cleanup();
		mockRequest.mockReset();
		mockGetHubIfConnected.mockReset();
		mockNavigateToSpaces.mockReset();
		mockToastSuccess.mockReset();
		mockToastError.mockReset();
		mockConfirm.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders space name and description', () => {
		const space = makeSpace();
		const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);
		expect(getByDisplayValue('My Space')).toBeTruthy();
		expect(getByDisplayValue('Original description')).toBeTruthy();
	});

	it('renders workspace path as read-only text', () => {
		const space = makeSpace();
		const { getByText } = render(<SpaceSettings space={space} />);
		expect(getByText('/projects/my-space')).toBeTruthy();
	});

	it('does not show Save Changes button when form is clean', () => {
		const space = makeSpace();
		const { queryByText } = render(<SpaceSettings space={space} />);
		expect(queryByText('Save Changes')).toBeNull();
	});

	it('shows Save Changes button when name is changed', () => {
		const space = makeSpace();
		const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);
		fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'New Name' } });
		expect(getByText('Save Changes')).toBeTruthy();
	});

	it('calls space.update with trimmed values on save', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue({});

		const space = makeSpace();
		const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);

		fireEvent.input(getByDisplayValue('My Space'), { target: { value: '  Updated Name  ' } });
		fireEvent.click(getByText('Save Changes'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('space.update', {
				id: 'space-1',
				name: 'Updated Name',
				description: 'Original description',
			});
		});
	});

	it('shows toast on successful save', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue({});

		const space = makeSpace();
		const { getByDisplayValue, getByText } = render(<SpaceSettings space={space} />);
		fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'Changed' } });
		fireEvent.click(getByText('Save Changes'));

		await waitFor(() => {
			expect(mockToastSuccess).toHaveBeenCalledWith('Space updated');
		});
	});

	it('Discard resets form to original values', () => {
		const space = makeSpace();
		const { getByDisplayValue, getByText, queryByText } = render(<SpaceSettings space={space} />);
		fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'Changed' } });
		expect(getByText('Discard')).toBeTruthy();

		fireEvent.click(getByText('Discard'));
		// After discard, form should be clean
		expect(queryByText('Save Changes')).toBeNull();
		expect((getByDisplayValue('My Space') as HTMLInputElement).value).toBe('My Space');
	});

	it('shows error when not connected on save', async () => {
		mockGetHubIfConnected.mockReturnValue(null);
		const space = makeSpace();
		const { getByDisplayValue, getByText, findByText } = render(<SpaceSettings space={space} />);
		fireEvent.input(getByDisplayValue('My Space'), { target: { value: 'Changed' } });
		fireEvent.click(getByText('Save Changes'));
		expect(await findByText('Not connected to server')).toBeTruthy();
	});

	it('calls space.archive and navigates on confirm', async () => {
		mockConfirm.mockReturnValue(true);
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue({});

		const space = makeSpace();
		const { getByText } = render(<SpaceSettings space={space} />);
		fireEvent.click(getByText('Archive'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('space.archive', { id: 'space-1' });
			expect(mockNavigateToSpaces).toHaveBeenCalled();
		});
	});

	it('does not archive when confirm is dismissed', async () => {
		mockConfirm.mockReturnValue(false);
		const space = makeSpace();
		const { getByText } = render(<SpaceSettings space={space} />);
		fireEvent.click(getByText('Archive'));
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('Archive button is disabled when space is already archived', () => {
		const space = makeSpace({ status: 'archived' });
		const { getByText } = render(<SpaceSettings space={space} />);
		const archiveBtn = getByText('Archive').closest('button')!;
		expect(archiveBtn.disabled).toBe(true);
	});

	it('calls space.delete and navigates on confirm', async () => {
		mockConfirm.mockReturnValue(true);
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue({});

		const space = makeSpace();
		const { getByText } = render(<SpaceSettings space={space} />);
		fireEvent.click(getByText('Delete'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('space.delete', { id: 'space-1' });
			expect(mockNavigateToSpaces).toHaveBeenCalled();
		});
	});

	it('does not delete when confirm is dismissed', async () => {
		mockConfirm.mockReturnValue(false);
		const space = makeSpace();
		const { getByText } = render(<SpaceSettings space={space} />);
		fireEvent.click(getByText('Delete'));
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('calls spaceExport.bundle when Export Bundle is clicked', async () => {
		mockGetHubIfConnected.mockReturnValue({ request: mockRequest });
		mockRequest.mockResolvedValue({ bundle: { version: '1', spaces: [] } });

		const space = makeSpace();
		const { getByText } = render(<SpaceSettings space={space} />);
		fireEvent.click(getByText('Export Bundle'));

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith('spaceExport.bundle', { spaceId: 'space-1' });
		});
	});
});
