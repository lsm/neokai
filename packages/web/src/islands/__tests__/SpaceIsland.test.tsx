// @ts-nocheck
/**
 * Tests for SpaceIsland — workflow editor mode toggle
 *
 * Tests:
 * Toggle visibility
 * - Toggle is hidden when not editing a workflow
 * - Toggle is visible when creating a new workflow
 * - Toggle is visible when editing an existing workflow
 * - Toggle is hidden after saving (editor closed)
 *
 * Default mode
 * - Default editor mode is 'list' when localStorage has no stored value
 * - Default editor mode is 'visual' when localStorage returns 'visual'
 * - Default editor mode is 'list' when localStorage returns an unknown value
 *
 * Toggle switches editors
 * - List editor is rendered when mode is 'list'
 * - Visual editor is rendered when mode is 'visual'
 * - Switching to Visual renders VisualWorkflowEditor (after confirm)
 * - Switching back to List renders WorkflowEditor (after confirm)
 *
 * Confirmation guard
 * - Switching modes shows a confirm dialog
 * - Declining the dialog cancels the mode switch
 * - Accepting the dialog completes the mode switch
 *
 * aria-pressed
 * - List button has aria-pressed="true" when mode is 'list'
 * - Visual button has aria-pressed="true" when mode is 'visual'
 *
 * Props passed to editors
 * - WorkflowEditor receives correct workflow prop (undefined for new)
 * - VisualWorkflowEditor receives correct workflow prop (undefined for new)
 * - WorkflowEditor receives correct workflow prop when editing existing
 * - VisualWorkflowEditor receives correct workflow prop when editing existing
 * - onSave callback closes editor
 * - onCancel callback closes editor
 *
 * localStorage persistence
 * - Switching to 'visual' writes to localStorage
 * - Switching to 'list' writes to localStorage
 * - Reads localStorage on initial render to restore preference
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceWorkflow, SpaceAgent, Space } from '@neokai/shared';

// ============================================================================
// Mock signals — must be declared before vi.mock calls
// ============================================================================

let mockLoading = signal(false);
let mockError = signal<string | null>(null);
let mockSpace = signal<Space | null>(null);
let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceAgent[]>([]);
let mockCurrentSpaceTaskId = signal<string | null>(null);

const mockSelectSpace = vi.fn().mockResolvedValue(undefined);

// ============================================================================
// Child component mocks
// ============================================================================

// WorkflowList renders a button to trigger create/edit workflow
vi.mock('../../components/space/WorkflowList', () => ({
	WorkflowList: (props: { onCreateWorkflow: () => void; onEditWorkflow: (id: string) => void }) => (
		<div data-testid="workflow-list">
			<button data-testid="create-workflow-btn" onClick={props.onCreateWorkflow}>
				Create
			</button>
			<button data-testid="edit-workflow-btn" onClick={() => props.onEditWorkflow('wf-existing')}>
				Edit
			</button>
		</div>
	),
}));

// Track props passed to WorkflowEditor
let capturedWorkflowEditorProps: Record<string, unknown> = {};
vi.mock('../../components/space/WorkflowEditor', () => ({
	WorkflowEditor: (props: {
		workflow?: SpaceWorkflow;
		onSave: () => void;
		onCancel: () => void;
	}) => {
		capturedWorkflowEditorProps = props;
		return (
			<div data-testid="workflow-editor">
				<span data-testid="workflow-editor-name">{props.workflow?.name ?? 'new'}</span>
				<button data-testid="workflow-editor-save" onClick={props.onSave}>
					Save
				</button>
				<button data-testid="workflow-editor-cancel" onClick={props.onCancel}>
					Cancel
				</button>
			</div>
		);
	},
}));

// Track props passed to VisualWorkflowEditor
let capturedVisualEditorProps: Record<string, unknown> = {};
vi.mock('../../components/space/visual-editor/VisualWorkflowEditor', () => ({
	VisualWorkflowEditor: (props: {
		workflow?: SpaceWorkflow;
		onSave: () => void;
		onCancel: () => void;
	}) => {
		capturedVisualEditorProps = props;
		return (
			<div data-testid="visual-workflow-editor">
				<span data-testid="visual-editor-name">{props.workflow?.name ?? 'new'}</span>
				<button data-testid="visual-editor-save" onClick={props.onSave}>
					Save
				</button>
				<button data-testid="visual-editor-cancel" onClick={props.onCancel}>
					Cancel
				</button>
			</div>
		);
	},
}));

vi.mock('../../components/space/SpaceDashboard', () => ({
	SpaceDashboard: () => <div data-testid="space-dashboard" />,
}));
vi.mock('../../components/space/SpaceTaskPane', () => ({
	SpaceTaskPane: () => <div data-testid="space-task-pane" />,
}));
vi.mock('../../components/space/SpaceAgentList', () => ({
	SpaceAgentList: () => <div data-testid="space-agent-list" />,
}));
vi.mock('../../components/space/SpaceSettings', () => ({
	SpaceSettings: () => <div data-testid="space-settings" />,
}));

vi.mock('../../lib/space-store', () => ({
	get spaceStore() {
		return {
			loading: mockLoading,
			error: mockError,
			space: mockSpace,
			workflows: mockWorkflows,
			agents: mockAgents,
			selectSpace: mockSelectSpace,
		};
	},
}));

vi.mock('../../lib/signals', () => ({
	get currentSpaceTaskIdSignal() {
		return mockCurrentSpaceTaskId;
	},
}));

vi.mock('../../lib/router', () => ({
	navigateToSpace: vi.fn(),
}));

vi.mock('../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import SpaceIsland from '../SpaceIsland';

// ============================================================================
// Fixtures
// ============================================================================

function makeSpace(overrides: Partial<Space> = {}): Space {
	return {
		id: 'space-1',
		name: 'Test Space',
		description: '',
		status: 'active',
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
	return {
		id: 'wf-existing',
		spaceId: 'space-1',
		name: 'Existing Workflow',
		description: '',
		nodes: [],
		transitions: [],
		startNodeId: '',
		rules: [],
		tags: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

// ============================================================================
// Helpers
// ============================================================================

/** Render SpaceIsland in the Workflows tab with a space loaded. */
function renderOnWorkflowsTab() {
	const result = render(<SpaceIsland spaceId="space-1" />);
	const workflowsTab = result.getByText('Workflows');
	fireEvent.click(workflowsTab);
	return result;
}

/** Open the create-new workflow editor. */
function openCreateEditor(result: { getByTestId: (id: string) => HTMLElement }) {
	fireEvent.click(result.getByTestId('create-workflow-btn'));
}

/** Open the edit workflow editor (uses wf-existing). */
function openEditEditor(result: { getByTestId: (id: string) => HTMLElement }) {
	fireEvent.click(result.getByTestId('edit-workflow-btn'));
}

/** Click the Visual toggle, accepting the confirmation dialog. */
function switchToVisual(result: { getByTestId: (id: string) => HTMLElement }) {
	// confirm is stubbed globally to return true by default
	fireEvent.click(result.getByTestId('editor-mode-visual'));
}

/** Click the List toggle, accepting the confirmation dialog. */
function switchToList(result: { getByTestId: (id: string) => HTMLElement }) {
	// confirm is stubbed globally to return true by default
	fireEvent.click(result.getByTestId('editor-mode-list'));
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	mockLoading = signal(false);
	mockError = signal(null);
	mockSpace = signal(makeSpace());
	mockWorkflows = signal([makeWorkflow()]);
	mockAgents = signal([]);
	mockCurrentSpaceTaskId = signal(null);
	capturedWorkflowEditorProps = {};
	capturedVisualEditorProps = {};
	// Reset localStorage mock to return null (default mode = 'list')
	(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(null);
	// Stub window.confirm (not defined in happy-dom) — default to true (accept)
	vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('SpaceIsland — workflow editor toggle', () => {
	describe('Toggle visibility', () => {
		it('does not show toggle when on workflows tab without editor open', () => {
			const { queryByTestId } = renderOnWorkflowsTab();
			expect(queryByTestId('editor-mode-toggle')).toBeNull();
		});

		it('shows toggle when creating a new workflow', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			expect(result.getByTestId('editor-mode-toggle')).toBeTruthy();
		});

		it('shows toggle when editing an existing workflow', () => {
			const result = renderOnWorkflowsTab();
			openEditEditor(result);
			expect(result.getByTestId('editor-mode-toggle')).toBeTruthy();
		});

		it('hides toggle after saving (editor closed)', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			expect(result.getByTestId('editor-mode-toggle')).toBeTruthy();
			fireEvent.click(result.getByTestId('workflow-editor-save'));
			expect(result.queryByTestId('editor-mode-toggle')).toBeNull();
		});
	});

	describe('Default mode', () => {
		it('defaults to list mode when localStorage has no stored value', () => {
			(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(null);
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			expect(result.getByTestId('workflow-editor')).toBeTruthy();
		});

		it('defaults to visual mode when localStorage returns "visual"', () => {
			(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('visual');
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
		});

		it('defaults to list mode when localStorage returns an unknown value', () => {
			(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('unknown');
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			expect(result.getByTestId('workflow-editor')).toBeTruthy();
		});
	});

	describe('Toggle switches editors', () => {
		it('renders WorkflowEditor when mode is list (default)', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			expect(result.getByTestId('workflow-editor')).toBeTruthy();
			expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
		});

		it('renders VisualWorkflowEditor after clicking Visual toggle', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			switchToVisual(result);
			expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
			expect(result.queryByTestId('workflow-editor')).toBeNull();
		});

		it('returns to WorkflowEditor after clicking List toggle from Visual', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			switchToVisual(result);
			expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
			switchToList(result);
			expect(result.getByTestId('workflow-editor')).toBeTruthy();
			expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
		});
	});

	describe('Confirmation guard', () => {
		it('shows a confirm dialog when switching modes', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			fireEvent.click(result.getByTestId('editor-mode-visual'));
			expect(confirm).toHaveBeenCalledOnce();
			expect(confirm).toHaveBeenCalledWith(
				'Switching editor modes will discard any unsaved changes. Continue?'
			);
		});

		it('does not switch mode when user declines the confirmation', () => {
			vi.mocked(confirm).mockReturnValue(false);
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			fireEvent.click(result.getByTestId('editor-mode-visual'));
			// Mode should remain 'list'
			expect(result.getByTestId('workflow-editor')).toBeTruthy();
			expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
		});

		it('switches mode when user accepts the confirmation', () => {
			// confirm already returns true by default (set in beforeEach)
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			fireEvent.click(result.getByTestId('editor-mode-visual'));
			expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
		});

		it('does not show confirm when clicking already-active mode button', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			// Click List when already in list mode
			fireEvent.click(result.getByTestId('editor-mode-list'));
			expect(confirm).not.toHaveBeenCalled();
		});
	});

	describe('aria-pressed', () => {
		it('List button has aria-pressed="true" when mode is "list"', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			const listBtn = result.getByTestId('editor-mode-list');
			expect(listBtn.getAttribute('aria-pressed')).toBe('true');
		});

		it('Visual button has aria-pressed="false" when mode is "list"', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			const visualBtn = result.getByTestId('editor-mode-visual');
			expect(visualBtn.getAttribute('aria-pressed')).toBe('false');
		});

		it('Visual button has aria-pressed="true" after switching to visual', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			switchToVisual(result);
			const visualBtn = result.getByTestId('editor-mode-visual');
			expect(visualBtn.getAttribute('aria-pressed')).toBe('true');
		});

		it('List button has aria-pressed="false" when mode is "visual"', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			switchToVisual(result);
			const listBtn = result.getByTestId('editor-mode-list');
			expect(listBtn.getAttribute('aria-pressed')).toBe('false');
		});
	});

	describe('Props passed to editors', () => {
		it('passes undefined workflow to WorkflowEditor when creating new', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			expect(capturedWorkflowEditorProps.workflow).toBeUndefined();
		});

		it('passes existing workflow to WorkflowEditor when editing', () => {
			const result = renderOnWorkflowsTab();
			openEditEditor(result);
			expect((capturedWorkflowEditorProps.workflow as SpaceWorkflow)?.id).toBe('wf-existing');
		});

		it('passes undefined workflow to VisualWorkflowEditor when creating new', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			switchToVisual(result);
			expect(capturedVisualEditorProps.workflow).toBeUndefined();
		});

		it('passes existing workflow to VisualWorkflowEditor when editing', () => {
			const result = renderOnWorkflowsTab();
			openEditEditor(result);
			switchToVisual(result);
			expect((capturedVisualEditorProps.workflow as SpaceWorkflow)?.id).toBe('wf-existing');
		});

		it('WorkflowEditor onSave closes the editor', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			fireEvent.click(result.getByTestId('workflow-editor-save'));
			expect(result.queryByTestId('workflow-editor')).toBeNull();
			expect(result.queryByTestId('editor-mode-toggle')).toBeNull();
		});

		it('WorkflowEditor onCancel closes the editor', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			fireEvent.click(result.getByTestId('workflow-editor-cancel'));
			expect(result.queryByTestId('workflow-editor')).toBeNull();
		});

		it('VisualWorkflowEditor onSave closes the editor', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			switchToVisual(result);
			fireEvent.click(result.getByTestId('visual-editor-save'));
			expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
			expect(result.queryByTestId('editor-mode-toggle')).toBeNull();
		});

		it('VisualWorkflowEditor onCancel closes the editor', () => {
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			switchToVisual(result);
			fireEvent.click(result.getByTestId('visual-editor-cancel'));
			expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
		});
	});

	describe('localStorage persistence', () => {
		it('writes "visual" to localStorage when switching to Visual', () => {
			// confirm returns true by default (set in beforeEach)
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			fireEvent.click(result.getByTestId('editor-mode-visual'));
			expect(localStorage.setItem).toHaveBeenCalledWith('workflow-editor-mode', 'visual');
		});

		it('writes "list" to localStorage when switching to List', () => {
			(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('visual');
			// confirm returns true by default (set in beforeEach)
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			fireEvent.click(result.getByTestId('editor-mode-list'));
			expect(localStorage.setItem).toHaveBeenCalledWith('workflow-editor-mode', 'list');
		});

		it('reads localStorage on initial render to restore preference', () => {
			render(<SpaceIsland spaceId="space-1" />);
			expect(localStorage.getItem).toHaveBeenCalledWith('workflow-editor-mode');
		});

		it('does not write to localStorage when user declines mode switch', () => {
			vi.mocked(confirm).mockReturnValue(false);
			const result = renderOnWorkflowsTab();
			openCreateEditor(result);
			fireEvent.click(result.getByTestId('editor-mode-visual'));
			expect(localStorage.setItem).not.toHaveBeenCalled();
		});
	});
});
