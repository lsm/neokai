// @ts-nocheck
/**
 * Tests for SpaceIsland — workflow editor mode toggle
 *
 * Tests:
 * Toggle visibility
 * - Toggle is hidden when not editing a workflow
 * - Toggle is visible when creating a new workflow
 * - Toggle is visible when editing an existing workflow
 *
 * Default mode
 * - Default editor mode is 'list' when localStorage has no stored value
 * - Default editor mode is 'visual' when localStorage returns 'visual'
 * - Default editor mode is 'list' when localStorage returns an unknown value
 *
 * Toggle switches editors
 * - List editor is rendered when mode is 'list'
 * - Visual editor is rendered when mode is 'visual'
 * - Switching to Visual renders VisualWorkflowEditor
 * - Switching back to List renders WorkflowEditor
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
		steps: [],
		transitions: [],
		startStepId: '',
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
	// Switch to Workflows tab
	const workflowsTab = result.getByText('Workflows');
	fireEvent.click(workflowsTab);
	return result;
}

/** Open the create-new workflow editor. */
function openCreateEditor(result: ReturnType<typeof render>) {
	const createBtn = result.getByTestId('create-workflow-btn');
	fireEvent.click(createBtn);
}

/** Open the edit workflow editor (uses wf-existing). */
function openEditEditor(result: ReturnType<typeof render>) {
	const editBtn = result.getByTestId('edit-workflow-btn');
	fireEvent.click(editBtn);
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
			const { getByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			expect(getByTestId('editor-mode-toggle')).toBeTruthy();
		});

		it('shows toggle when editing an existing workflow', () => {
			const { getByTestId } = renderOnWorkflowsTab();
			openEditEditor({ getByTestId } as ReturnType<typeof render>);
			expect(getByTestId('editor-mode-toggle')).toBeTruthy();
		});

		it('hides toggle after saving (editor closed)', () => {
			const { getByTestId, queryByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			expect(getByTestId('editor-mode-toggle')).toBeTruthy();
			fireEvent.click(getByTestId('workflow-editor-save'));
			expect(queryByTestId('editor-mode-toggle')).toBeNull();
		});
	});

	describe('Default mode', () => {
		it('defaults to list mode when localStorage has no stored value', () => {
			(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(null);
			const { getByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			expect(getByTestId('workflow-editor')).toBeTruthy();
		});

		it('defaults to visual mode when localStorage returns "visual"', () => {
			(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('visual');
			const { getByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			expect(getByTestId('visual-workflow-editor')).toBeTruthy();
		});

		it('defaults to list mode when localStorage returns an unknown value', () => {
			(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('unknown');
			const { getByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			expect(getByTestId('workflow-editor')).toBeTruthy();
		});
	});

	describe('Toggle switches editors', () => {
		it('renders WorkflowEditor when mode is list (default)', () => {
			const { getByTestId, queryByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			expect(getByTestId('workflow-editor')).toBeTruthy();
			expect(queryByTestId('visual-workflow-editor')).toBeNull();
		});

		it('renders VisualWorkflowEditor after clicking Visual toggle', () => {
			const { getByTestId, queryByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('editor-mode-visual'));
			expect(getByTestId('visual-workflow-editor')).toBeTruthy();
			expect(queryByTestId('workflow-editor')).toBeNull();
		});

		it('returns to WorkflowEditor after clicking List toggle from Visual', () => {
			const { getByTestId, queryByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			// Switch to visual
			fireEvent.click(getByTestId('editor-mode-visual'));
			expect(getByTestId('visual-workflow-editor')).toBeTruthy();
			// Switch back to list
			fireEvent.click(getByTestId('editor-mode-list'));
			expect(getByTestId('workflow-editor')).toBeTruthy();
			expect(queryByTestId('visual-workflow-editor')).toBeNull();
		});
	});

	describe('Props passed to editors', () => {
		it('passes undefined workflow to WorkflowEditor when creating new', () => {
			const { getByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			expect(capturedWorkflowEditorProps.workflow).toBeUndefined();
		});

		it('passes existing workflow to WorkflowEditor when editing', () => {
			const { getByTestId } = renderOnWorkflowsTab();
			openEditEditor({ getByTestId } as ReturnType<typeof render>);
			expect((capturedWorkflowEditorProps.workflow as SpaceWorkflow)?.id).toBe('wf-existing');
		});

		it('passes undefined workflow to VisualWorkflowEditor when creating new', () => {
			const { getByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('editor-mode-visual'));
			expect(capturedVisualEditorProps.workflow).toBeUndefined();
		});

		it('passes existing workflow to VisualWorkflowEditor when editing', () => {
			const { getByTestId } = renderOnWorkflowsTab();
			openEditEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('editor-mode-visual'));
			expect((capturedVisualEditorProps.workflow as SpaceWorkflow)?.id).toBe('wf-existing');
		});

		it('WorkflowEditor onSave closes the editor', () => {
			const { getByTestId, queryByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('workflow-editor-save'));
			expect(queryByTestId('workflow-editor')).toBeNull();
			expect(queryByTestId('editor-mode-toggle')).toBeNull();
		});

		it('WorkflowEditor onCancel closes the editor', () => {
			const { getByTestId, queryByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('workflow-editor-cancel'));
			expect(queryByTestId('workflow-editor')).toBeNull();
		});

		it('VisualWorkflowEditor onSave closes the editor', () => {
			const { getByTestId, queryByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('editor-mode-visual'));
			fireEvent.click(getByTestId('visual-editor-save'));
			expect(queryByTestId('visual-workflow-editor')).toBeNull();
			expect(queryByTestId('editor-mode-toggle')).toBeNull();
		});

		it('VisualWorkflowEditor onCancel closes the editor', () => {
			const { getByTestId, queryByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('editor-mode-visual'));
			fireEvent.click(getByTestId('visual-editor-cancel'));
			expect(queryByTestId('visual-workflow-editor')).toBeNull();
		});
	});

	describe('localStorage persistence', () => {
		it('writes "visual" to localStorage when switching to Visual', () => {
			const { getByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('editor-mode-visual'));
			expect(localStorage.setItem).toHaveBeenCalledWith('workflow-editor-mode', 'visual');
		});

		it('writes "list" to localStorage when switching to List', () => {
			(localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('visual');
			const { getByTestId } = renderOnWorkflowsTab();
			openCreateEditor({ getByTestId } as ReturnType<typeof render>);
			fireEvent.click(getByTestId('editor-mode-list'));
			expect(localStorage.setItem).toHaveBeenCalledWith('workflow-editor-mode', 'list');
		});

		it('reads localStorage on initial render to restore preference', () => {
			render(<SpaceIsland spaceId="space-1" />);
			expect(localStorage.getItem).toHaveBeenCalledWith('workflow-editor-mode');
		});
	});
});
