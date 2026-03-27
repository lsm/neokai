/**
 * Tests for RoomSkillsSettings component
 *
 * Covers:
 * - Renders skill list grouped by source type
 * - Built-in skills are shown but toggle is disabled
 * - Toggle calls setOverride with correct args
 * - Reset button calls clearOverride
 * - Empty state renders when no skills configured
 * - Error toast shown on toggle failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { RoomSkillsSettings } from '../RoomSkillsSettings';
import type { EffectiveRoomSkill } from '../../../lib/room-store';
import type { AppSkillConfig } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mock toast
// ---------------------------------------------------------------------------

const mockToastError = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/toast.ts', () => ({
	toast: {
		success: vi.fn(),
		error: mockToastError,
	},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(id: string, overrides: Partial<EffectiveRoomSkill> = {}): EffectiveRoomSkill {
	const sourceType = overrides.sourceType ?? 'plugin';
	let config: AppSkillConfig;
	if (sourceType === 'builtin') {
		config = { type: 'builtin', commandName: id };
	} else if (sourceType === 'mcp_server') {
		config = { type: 'mcp_server', appMcpServerId: 'mcp-uuid' };
	} else {
		config = { type: 'plugin', pluginPath: `/skills/${id}` };
	}

	return {
		id,
		name: id,
		displayName: `Skill ${id}`,
		description: `Description for ${id}`,
		sourceType,
		config,
		enabled: true,
		builtIn: false,
		validationStatus: 'valid',
		createdAt: 1704067200000,
		overriddenByRoom: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomSkillsSettings', () => {
	const mockSetOverride = vi.fn().mockResolvedValue(undefined);
	const mockClearOverride = vi.fn().mockResolvedValue(undefined);

	const defaultProps = {
		skills: [] as EffectiveRoomSkill[],
		setOverride: mockSetOverride,
		clearOverride: mockClearOverride,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	// -------------------------------------------------------------------------
	// Empty State
	// -------------------------------------------------------------------------

	describe('Empty State', () => {
		it('renders empty state when no skills configured', () => {
			render(<RoomSkillsSettings {...defaultProps} skills={[]} />);
			expect(document.body.textContent).toContain('No skills configured');
		});

		it('renders link to global settings in empty state', () => {
			render(<RoomSkillsSettings {...defaultProps} skills={[]} />);
			const link = document.querySelector('a');
			expect(link?.textContent).toContain('Add skills in Global Settings');
		});
	});

	// -------------------------------------------------------------------------
	// Skill List Rendering
	// -------------------------------------------------------------------------

	describe('Skill List', () => {
		it('renders all skills by display name', async () => {
			const skills = [makeSkill('s1'), makeSkill('s2')];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('Skill s1');
				expect(document.body.textContent).toContain('Skill s2');
			});
		});

		it('renders skill description', async () => {
			const skills = [makeSkill('s1', { description: 'My custom skill description' })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('My custom skill description');
			});
		});

		it('renders source type badge for each skill', async () => {
			const skills = [
				makeSkill('b1', {
					sourceType: 'builtin',
					builtIn: true,
					config: { type: 'builtin', commandName: 'b1' },
				}),
				makeSkill('p1', { sourceType: 'plugin' }),
				makeSkill('m1', {
					sourceType: 'mcp_server',
					config: { type: 'mcp_server', appMcpServerId: 'x' },
				}),
			];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('Built-in');
				expect(document.body.textContent).toContain('Plugin');
				expect(document.body.textContent).toContain('MCP Server');
			});
		});

		it('groups skills by source type with section headings', async () => {
			const skills = [
				makeSkill('p1', { sourceType: 'plugin' }),
				makeSkill('p2', { sourceType: 'plugin' }),
			];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				// Section heading for plugin group
				const text = document.body.textContent ?? '';
				expect(text).toContain('Plugin');
			});
		});
	});

	// -------------------------------------------------------------------------
	// Built-in Skills
	// -------------------------------------------------------------------------

	describe('Built-in Skills', () => {
		it('shows always on badge for built-in skills', async () => {
			const skills = [
				makeSkill('builtin1', {
					sourceType: 'builtin',
					builtIn: true,
					config: { type: 'builtin', commandName: 'builtin1' },
				}),
			];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('always on');
			});
		});

		it('disables toggle for built-in skills', async () => {
			const skills = [
				makeSkill('builtin1', {
					sourceType: 'builtin',
					builtIn: true,
					config: { type: 'builtin', commandName: 'builtin1' },
				}),
			];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				expect(checkbox.disabled).toBe(true);
			});
		});

		it('does not call setOverride when built-in toggle is clicked', async () => {
			const skills = [
				makeSkill('builtin1', {
					sourceType: 'builtin',
					builtIn: true,
					config: { type: 'builtin', commandName: 'builtin1' },
				}),
			];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				fireEvent.click(checkbox);
			});

			expect(mockSetOverride).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// Toggle Behavior
	// -------------------------------------------------------------------------

	describe('Toggle Behavior', () => {
		it('calls setOverride when non-builtin toggle is clicked', async () => {
			const skills = [makeSkill('s1', { enabled: true, overriddenByRoom: false })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				fireEvent.click(checkbox);
			});

			await waitFor(() => {
				expect(mockSetOverride).toHaveBeenCalledWith('s1', false);
			});
		});

		it('calls setOverride to disable a currently enabled skill', async () => {
			const skills = [makeSkill('s1', { enabled: true })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				fireEvent.click(checkbox);
			});

			await waitFor(() => {
				expect(mockSetOverride).toHaveBeenCalledWith('s1', false);
			});
		});

		it('calls setOverride to enable a currently disabled skill', async () => {
			const skills = [makeSkill('s1', { enabled: false })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				fireEvent.click(checkbox);
			});

			await waitFor(() => {
				expect(mockSetOverride).toHaveBeenCalledWith('s1', true);
			});
		});

		it('shows error toast when toggle fails', async () => {
			mockSetOverride.mockRejectedValueOnce(new Error('RPC failed'));
			const skills = [makeSkill('s1', { enabled: true })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				fireEvent.click(checkbox);
			});

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalled();
			});
		});

		it('does not call setOverride when component is disabled', async () => {
			const skills = [makeSkill('s1', { enabled: true })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} disabled={true} />);

			await waitFor(() => {
				const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
				expect(checkbox.disabled).toBe(true);
			});
		});
	});

	// -------------------------------------------------------------------------
	// Room Override Badge and Reset
	// -------------------------------------------------------------------------

	describe('Room Override', () => {
		it('shows room override badge when skill is overridden by room', async () => {
			const skills = [makeSkill('s1', { overriddenByRoom: true })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('room override');
			});
		});

		it('shows disabled globally badge when skill is disabled globally without override', async () => {
			const skills = [makeSkill('s1', { enabled: false, overriddenByRoom: false })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				expect(document.body.textContent).toContain('disabled globally');
			});
		});

		it('shows Reset button when skill has a room override', async () => {
			const skills = [makeSkill('s1', { overriddenByRoom: true })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const resetBtn = buttons.find((b) => b.textContent?.trim() === 'Reset');
				expect(resetBtn).toBeDefined();
			});
		});

		it('calls clearOverride when Reset is clicked', async () => {
			const skills = [makeSkill('s1', { overriddenByRoom: true })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const resetBtn = buttons.find((b) => b.textContent?.trim() === 'Reset');
				if (resetBtn) fireEvent.click(resetBtn);
			});

			await waitFor(() => {
				expect(mockClearOverride).toHaveBeenCalledWith('s1');
			});
		});

		it('shows error toast when clearOverride fails', async () => {
			mockClearOverride.mockRejectedValueOnce(new Error('RPC failed'));
			const skills = [makeSkill('s1', { overriddenByRoom: true })];
			render(<RoomSkillsSettings {...defaultProps} skills={skills} />);

			await waitFor(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const resetBtn = buttons.find((b) => b.textContent?.trim() === 'Reset');
				if (resetBtn) fireEvent.click(resetBtn);
			});

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalled();
			});
		});
	});
});
