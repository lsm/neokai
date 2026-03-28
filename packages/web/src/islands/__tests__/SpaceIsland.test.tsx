// @ts-nocheck
/**
 * Tests for SpaceIsland — visual workflow editor and canvas integration
 *
 * Visual editor
 * - Opens only the visual editor when creating or editing a workflow
 * - Hides the tab bar while editing
 * - Passes the correct workflow prop to the visual editor
 * - onSave/onCancel close the editor
 *
 * Canvas integration — dashboard tab
 * - Shows WorkflowCanvas in runtime mode when active run exists
 * - Shows WorkflowCanvas in template mode (no runId) when no active run but workflow exists
 * - Shows dashboard fallback when no workflows exist
 * - Canvas panel is hidden on mobile (no active run, has workflow)
 * - Active-run banner is shown in canvas panel when active run exists
 * - Active-run banner is hidden in canvas panel when no active run
 * - WorkflowCanvas receives correct runId in runtime mode
 * - WorkflowCanvas receives correct workflowId for active run's workflow
 * - WorkflowCanvas uses first workflow as fallback when run's workflow not found
 * - Dashboard fallback always rendered on mobile (md:hidden)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceWorkflow, SpaceAgent, Space, SpaceWorkflowRun } from '@neokai/shared';

// ============================================================================
// Mock signals — must be declared before vi.mock calls
// ============================================================================

let mockLoading = signal(false);
let mockError = signal<string | null>(null);
let mockSpace = signal<Space | null>(null);
let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceAgent[]>([]);
let mockActiveRuns = signal<SpaceWorkflowRun[]>([]);

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

// Track props passed to WorkflowCanvas
let capturedCanvasProps: Record<string, unknown> = {};
vi.mock('../../components/space/WorkflowCanvas', () => ({
	WorkflowCanvas: (props: {
		workflowId: string;
		runId?: string | null;
		spaceId: string;
		class?: string;
	}) => {
		capturedCanvasProps = props;
		return (
			<div
				data-testid="workflow-canvas"
				data-workflow-id={props.workflowId}
				data-run-id={props.runId ?? ''}
			/>
		);
	},
}));

vi.mock('../../components/space/SpaceDashboard', () => ({
	SpaceDashboard: (props: {
		onCreateTask?: () => void;
		onStartWorkflow?: () => void;
		onSelectTask?: (id: string) => void;
	}) => (
		<div data-testid="space-dashboard">
			<button data-testid="quick-create-task" onClick={props.onCreateTask}>
				Create Task
			</button>
			<button data-testid="quick-start-workflow" onClick={props.onStartWorkflow}>
				Start Workflow Run
			</button>
		</div>
	),
}));
vi.mock('../../components/space/SpaceTaskPane', () => ({
	SpaceTaskPane: (props: { taskId: string | null; spaceId?: string; onClose?: () => void }) => (
		<div
			data-testid="space-task-pane-inner"
			data-task-id={props.taskId ?? ''}
			data-space-id={props.spaceId ?? ''}
		/>
	),
}));

vi.mock('../../components/space/SpaceCreateTaskDialog', () => ({
	SpaceCreateTaskDialog: (props: { isOpen: boolean; onClose: () => void }) =>
		props.isOpen ? (
			<div data-testid="space-create-task-dialog">
				<button data-testid="close-create-task-dialog" onClick={props.onClose}>
					Close
				</button>
			</div>
		) : null,
}));

vi.mock('../../components/space/WorkflowRunStartDialog', () => ({
	WorkflowRunStartDialog: (props: {
		isOpen: boolean;
		onClose: () => void;
		onSwitchToWorkflows?: () => void;
	}) =>
		props.isOpen ? (
			<div data-testid="workflow-run-start-dialog">
				<button data-testid="close-workflow-run-dialog" onClick={props.onClose}>
					Close
				</button>
			</div>
		) : null,
}));
vi.mock('../../components/space/SpaceAgentList', () => ({
	SpaceAgentList: () => <div data-testid="space-agent-list" />,
}));
vi.mock('../../components/space/SpaceSettings', () => ({
	SpaceSettings: () => <div data-testid="space-settings" />,
}));
vi.mock('../ChatContainer', () => ({
	default: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="chat-container" data-session-id={sessionId} />
	),
}));

vi.mock('../../lib/space-store', () => ({
	get spaceStore() {
		return {
			loading: mockLoading,
			error: mockError,
			space: mockSpace,
			workflows: mockWorkflows,
			agents: mockAgents,
			activeRuns: mockActiveRuns,
			selectSpace: mockSelectSpace,
		};
	},
}));

vi.mock('../../lib/signals', () => ({
	currentSessionIdSignal: signal(null),
	slashCommandsSignal: signal([]),
}));

vi.mock('../../lib/router', () => ({
	navigateToSpace: vi.fn(),
	navigateToSpaceTask: vi.fn(),
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

function makeWorkflowRun(overrides: Partial<SpaceWorkflowRun> = {}): SpaceWorkflowRun {
	return {
		id: 'run-1',
		spaceId: 'space-1',
		workflowId: 'wf-existing',
		title: 'Test Run',
		status: 'in_progress',
		iterationCount: 0,
		maxIterations: 10,
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

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	mockLoading = signal(false);
	mockError = signal(null);
	mockSpace = signal(makeSpace());
	mockWorkflows = signal([makeWorkflow()]);
	mockAgents = signal([]);
	mockActiveRuns = signal([]);
	capturedVisualEditorProps = {};
	capturedCanvasProps = {};
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('SpaceIsland — visual workflow editor', () => {
	it('does not show the visual editor when the workflows list is open', () => {
		const { queryByTestId } = renderOnWorkflowsTab();
		expect(queryByTestId('visual-workflow-editor')).toBeNull();
	});

	it('opens the visual editor when creating a workflow', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
	});

	it('opens the visual editor when editing an existing workflow', () => {
		const result = renderOnWorkflowsTab();
		openEditEditor(result);
		expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
	});

	it('passes undefined workflow to the visual editor when creating new', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		expect(capturedVisualEditorProps.workflow).toBeUndefined();
	});

	it('passes the existing workflow to the visual editor when editing', () => {
		const result = renderOnWorkflowsTab();
		openEditEditor(result);
		expect((capturedVisualEditorProps.workflow as SpaceWorkflow)?.id).toBe('wf-existing');
	});

	it('hides the tab bar while the visual editor is open', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		expect(result.queryByTestId('space-tab-bar')).toBeNull();
	});

	it('restores the tab bar after saving the visual editor', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		fireEvent.click(result.getByTestId('visual-editor-save'));
		expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
		expect(result.getByTestId('space-tab-bar')).toBeTruthy();
	});

	it('closes the visual editor on cancel', () => {
		const result = renderOnWorkflowsTab();
		openCreateEditor(result);
		fireEvent.click(result.getByTestId('visual-editor-cancel'));
		expect(result.queryByTestId('visual-workflow-editor')).toBeNull();
		expect(result.getByTestId('space-tab-bar')).toBeTruthy();
	});
});

describe('SpaceIsland — canvas integration (dashboard tab)', () => {
	describe('Canvas visibility', () => {
		it('shows canvas panel when workflow exists and no active run (template mode)', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([]);
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" />);
			expect(getByTestId('canvas-panel')).toBeTruthy();
		});

		it('shows canvas panel when active run exists (runtime mode)', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([makeWorkflowRun()]);
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" />);
			expect(getByTestId('canvas-panel')).toBeTruthy();
		});

		it('does not show canvas panel when no workflows exist', () => {
			mockWorkflows = signal([]);
			mockActiveRuns = signal([]);
			const { queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			expect(queryByTestId('canvas-panel')).toBeNull();
		});

		it('shows dashboard fallback when no workflows exist', () => {
			mockWorkflows = signal([]);
			mockActiveRuns = signal([]);
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" />);
			expect(getByTestId('dashboard-fallback')).toBeTruthy();
		});

		it('always shows dashboard fallback alongside canvas panel', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([]);
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" />);
			// Both exist in DOM — canvas visible on md+, fallback visible on mobile
			expect(getByTestId('canvas-panel')).toBeTruthy();
			expect(getByTestId('dashboard-fallback')).toBeTruthy();
		});
	});

	describe('Canvas props — template mode (no active run)', () => {
		it('passes workflowId of first workflow to WorkflowCanvas', () => {
			mockWorkflows = signal([makeWorkflow({ id: 'wf-alpha' })]);
			mockActiveRuns = signal([]);
			render(<SpaceIsland spaceId="space-1" />);
			expect(capturedCanvasProps.workflowId).toBe('wf-alpha');
		});

		it('passes null runId to WorkflowCanvas in template mode', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([]);
			render(<SpaceIsland spaceId="space-1" />);
			expect(capturedCanvasProps.runId).toBeNull();
		});

		it('passes spaceId to WorkflowCanvas', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([]);
			render(<SpaceIsland spaceId="space-42" />);
			expect(capturedCanvasProps.spaceId).toBe('space-42');
		});
	});

	describe('Canvas props — runtime mode (active run exists)', () => {
		it('passes runId to WorkflowCanvas in runtime mode', () => {
			mockWorkflows = signal([makeWorkflow({ id: 'wf-existing' })]);
			mockActiveRuns = signal([makeWorkflowRun({ id: 'run-xyz', workflowId: 'wf-existing' })]);
			render(<SpaceIsland spaceId="space-1" />);
			expect(capturedCanvasProps.runId).toBe('run-xyz');
		});

		it("passes run's workflowId to WorkflowCanvas when workflow found", () => {
			mockWorkflows = signal([makeWorkflow({ id: 'wf-a' }), makeWorkflow({ id: 'wf-b' })]);
			mockActiveRuns = signal([makeWorkflowRun({ id: 'run-1', workflowId: 'wf-b' })]);
			render(<SpaceIsland spaceId="space-1" />);
			expect(capturedCanvasProps.workflowId).toBe('wf-b');
		});

		it('falls back to first workflow when run workflow not found', () => {
			mockWorkflows = signal([makeWorkflow({ id: 'wf-fallback' })]);
			mockActiveRuns = signal([makeWorkflowRun({ workflowId: 'wf-nonexistent' })]);
			render(<SpaceIsland spaceId="space-1" />);
			expect(capturedCanvasProps.workflowId).toBe('wf-fallback');
		});
	});

	describe('Active-run banner', () => {
		it('shows run banner when active run exists', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([makeWorkflowRun({ title: 'My Active Run', status: 'in_progress' })]);
			const { getByText } = render(<SpaceIsland spaceId="space-1" />);
			expect(getByText('My Active Run')).toBeTruthy();
		});

		it('shows run status in banner', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([makeWorkflowRun({ title: 'Run', status: 'pending' })]);
			const { getByText } = render(<SpaceIsland spaceId="space-1" />);
			expect(getByText('pending')).toBeTruthy();
		});

		it('does not show run banner when no active run', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([]);
			const { queryByText } = render(<SpaceIsland spaceId="space-1" />);
			// Banner text "in progress" / "pending" should not appear
			expect(queryByText('in progress')).toBeNull();
		});
	});

	describe('Agents tab', () => {
		it('renders SpaceAgentList inside a padded wrapper', () => {
			const { getByTestId, getByText } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByText('Agents'));
			const agentList = getByTestId('space-agent-list');
			const wrapper = agentList.parentElement;
			expect(wrapper?.className).toContain('p-6');
		});
	});

	describe('Canvas not shown on non-dashboard tabs', () => {
		it('does not show canvas panel when on agents tab', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([makeWorkflowRun()]);
			const { queryByTestId, getByText } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByText('Agents'));
			expect(queryByTestId('canvas-panel')).toBeNull();
		});

		it('does not show canvas panel when on workflows tab', () => {
			mockWorkflows = signal([makeWorkflow()]);
			mockActiveRuns = signal([makeWorkflowRun()]);
			const { queryByTestId, getByText } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByText('Workflows'));
			expect(queryByTestId('canvas-panel')).toBeNull();
		});
	});
});

describe('SpaceIsland — quick action buttons and dialogs', () => {
	beforeEach(() => {
		// Override the module-level beforeEach: no workflows → showCanvas is false,
		// so the SpaceDashboard fallback (with quick-action buttons) is in the DOM.
		mockWorkflows = signal([]);
	});

	describe('Create Task dialog', () => {
		it('dialog is closed by default', () => {
			const { queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			expect(queryByTestId('space-create-task-dialog')).toBeNull();
		});

		it('opens SpaceCreateTaskDialog when Create Task button is clicked', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByTestId('quick-create-task'));
			expect(getByTestId('space-create-task-dialog')).toBeTruthy();
		});

		it('closes SpaceCreateTaskDialog when onClose is called', () => {
			const { getByTestId, queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByTestId('quick-create-task'));
			expect(getByTestId('space-create-task-dialog')).toBeTruthy();
			fireEvent.click(getByTestId('close-create-task-dialog'));
			expect(queryByTestId('space-create-task-dialog')).toBeNull();
		});
	});

	describe('Start Workflow Run dialog', () => {
		it('dialog is closed by default', () => {
			const { queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			expect(queryByTestId('workflow-run-start-dialog')).toBeNull();
		});

		it('opens WorkflowRunStartDialog when Start Workflow Run button is clicked', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByTestId('quick-start-workflow'));
			expect(getByTestId('workflow-run-start-dialog')).toBeTruthy();
		});

		it('closes WorkflowRunStartDialog when onClose is called', () => {
			const { getByTestId, queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByTestId('quick-start-workflow'));
			expect(getByTestId('workflow-run-start-dialog')).toBeTruthy();
			fireEvent.click(getByTestId('close-workflow-run-dialog'));
			expect(queryByTestId('workflow-run-start-dialog')).toBeNull();
		});
	});

	describe('Dialogs are independent', () => {
		it('opening Create Task does not open Workflow Run dialog', () => {
			const { getByTestId, queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByTestId('quick-create-task'));
			expect(getByTestId('space-create-task-dialog')).toBeTruthy();
			expect(queryByTestId('workflow-run-start-dialog')).toBeNull();
		});

		it('opening Start Workflow Run does not open Create Task dialog', () => {
			const { getByTestId, queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			fireEvent.click(getByTestId('quick-start-workflow'));
			expect(getByTestId('workflow-run-start-dialog')).toBeTruthy();
			expect(queryByTestId('space-create-task-dialog')).toBeNull();
		});
	});
});

describe('SpaceIsland — content priority chain', () => {
	describe('sessionViewId prop', () => {
		it('renders ChatContainer when sessionViewId is set', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" sessionViewId="session-abc" />);
			expect(getByTestId('chat-container')).toBeTruthy();
		});

		it('passes sessionId to ChatContainer', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" sessionViewId="session-abc" />);
			expect(getByTestId('chat-container').getAttribute('data-session-id')).toBe('session-abc');
		});

		it('does not render tab bar when sessionViewId is set', () => {
			const { queryByText } = render(<SpaceIsland spaceId="space-1" sessionViewId="session-abc" />);
			expect(queryByText('Dashboard')).toBeNull();
		});

		it('renders tab view when sessionViewId is null', () => {
			const { getByText, queryByTestId } = render(
				<SpaceIsland spaceId="space-1" sessionViewId={null} />
			);
			expect(getByText('Dashboard')).toBeTruthy();
			expect(queryByTestId('chat-container')).toBeNull();
		});

		it('renders tab view when neither sessionViewId nor taskViewId is set', () => {
			const { getByText, queryByTestId } = render(<SpaceIsland spaceId="space-1" />);
			expect(getByText('Dashboard')).toBeTruthy();
			expect(queryByTestId('chat-container')).toBeNull();
		});
	});

	describe('taskViewId prop', () => {
		it('shows SpaceTaskPane wrapper when taskViewId is set', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" taskViewId="task-xyz" />);
			expect(getByTestId('space-task-pane')).toBeTruthy();
		});

		it('hides tab bar when taskViewId is set (full-width task view)', () => {
			const { queryByText } = render(<SpaceIsland spaceId="space-1" taskViewId="task-xyz" />);
			expect(queryByText('Dashboard')).toBeNull();
			expect(queryByText('Agents')).toBeNull();
		});

		it('passes spaceId and taskId to SpaceTaskPane', () => {
			const { getByTestId } = render(<SpaceIsland spaceId="space-1" taskViewId="task-xyz" />);
			const inner = getByTestId('space-task-pane-inner');
			expect(inner.getAttribute('data-task-id')).toBe('task-xyz');
			expect(inner.getAttribute('data-space-id')).toBe('space-1');
		});

		it('does not show SpaceTaskPane when taskViewId is null', () => {
			const { queryByTestId } = render(<SpaceIsland spaceId="space-1" taskViewId={null} />);
			expect(queryByTestId('space-task-pane')).toBeNull();
		});

		it('sessionViewId takes priority over taskViewId — renders ChatContainer', () => {
			const { getByTestId, queryByTestId } = render(
				<SpaceIsland spaceId="space-1" sessionViewId="session-abc" taskViewId="task-xyz" />
			);
			expect(getByTestId('chat-container')).toBeTruthy();
			expect(queryByTestId('space-task-pane')).toBeNull();
		});
	});
});
