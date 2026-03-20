// @ts-nocheck
/**
 * Unit tests for SpaceAgentEditor
 *
 * Tests:
 * - Renders in create mode (no agent prop)
 * - Renders in edit mode (with agent prop, fields pre-filled)
 * - Form validation: name required
 * - Form validation: name uniqueness
 * - Form validation: model required
 * - Form validation: at least one tool selected
 * - Tool presets: "Full Coding" selects correct tools
 * - Tool presets: "Read Only" selects correct tools
 * - Tool presets: toggling a tool manually switches to "Custom"
 * - System prompt templates: applying a template sets the textarea value
 * - System prompt templates: "Custom (blank)" clears the textarea
 * - KNOWN_TOOLS: all tools are rendered as checkboxes
 * - Create mode: calls spaceStore.createAgent with correct params
 * - Edit mode: calls spaceStore.updateAgent with correct params
 * - Error from server is shown
 * - Cancel calls onCancel
 * - Role radio buttons: worker / reviewer / orchestrator rendered with labels
 * - Selecting a role updates the form state (reflected in submit params)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgent } from '@neokai/shared';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCreateAgent = vi.fn();
const mockUpdateAgent = vi.fn();

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			createAgent: mockCreateAgent,
			updateAgent: mockUpdateAgent,
		};
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('../../ui/Modal', () => ({
	Modal: ({
		isOpen,
		children,
		title,
		onClose,
	}: {
		isOpen: boolean;
		children: unknown;
		title: string;
		onClose: () => void;
	}) => {
		if (!isOpen) return null;
		return (
			<div role="dialog" aria-label={title}>
				<button onClick={onClose} aria-label="Close modal">
					X
				</button>
				{children}
			</div>
		);
	},
}));

vi.mock('../../ui/Button', () => ({
	Button: ({
		children,
		onClick,
		type,
		loading,
		disabled,
	}: {
		children: unknown;
		onClick?: () => void;
		type?: string;
		loading?: boolean;
		disabled?: boolean;
	}) => (
		<button type={type ?? 'button'} onClick={onClick} disabled={disabled || loading}>
			{loading ? 'Loading...' : children}
		</button>
	),
}));

import { SpaceAgentEditor } from '../SpaceAgentEditor';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_PROPS = {
	spaceId: 'space-1',
	agent: null,
	existingAgentNames: [],
	onSave: vi.fn(),
	onCancel: vi.fn(),
};

function makeAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
	return {
		id: 'agent-1',
		spaceId: 'space-1',
		name: 'My Coder',
		role: 'worker',
		description: 'A test agent',
		model: 'claude-sonnet-4-6',
		provider: 'anthropic',
		systemPrompt: 'Be helpful.',
		tools: ['Read', 'Write', 'Edit', 'Bash'],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

/** Fill the name input with a value */
function fillName(getByPlaceholderText: (text: string) => HTMLElement, value: string) {
	const input = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
	fireEvent.input(input, { target: { value } });
}

/** Fill the model input with a value */
function fillModel(getByPlaceholderText: (text: string) => HTMLElement, value: string) {
	const input = getByPlaceholderText('e.g., claude-sonnet-4-6') as HTMLInputElement;
	fireEvent.input(input, { target: { value } });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SpaceAgentEditor', () => {
	beforeEach(() => {
		cleanup();
		mockCreateAgent.mockReset();
		mockUpdateAgent.mockReset();
		DEFAULT_PROPS.onSave.mockClear();
		DEFAULT_PROPS.onCancel.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	// ── Render modes ──────────────────────────────────────────────────────────

	it('renders with "Create Agent" title in create mode', () => {
		const { getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		expect(getByRole('dialog', { name: 'Create Agent' })).toBeTruthy();
	});

	it('renders with edit title in edit mode', () => {
		const agent = makeAgent({ name: 'My Coder' });
		const { getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
		expect(getByRole('dialog', { name: 'Edit Agent: My Coder' })).toBeTruthy();
	});

	it('pre-fills name field in edit mode', () => {
		const agent = makeAgent({ name: 'Speedy Agent' });
		const { getByPlaceholderText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
		const nameInput = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
		expect(nameInput.value).toBe('Speedy Agent');
	});

	it('pre-fills model field in edit mode', () => {
		const agent = makeAgent({ model: 'claude-haiku-4-5' });
		const { getByPlaceholderText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
		const modelInput = getByPlaceholderText('e.g., claude-sonnet-4-6') as HTMLInputElement;
		expect(modelInput.value).toBe('claude-haiku-4-5');
	});

	it('pre-fills description in edit mode', () => {
		const agent = makeAgent({ description: 'A frontend specialist' });
		const { getByPlaceholderText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
		const descInput = getByPlaceholderText(
			"Briefly describe this agent's specialization..."
		) as HTMLInputElement;
		expect(descInput.value).toBe('A frontend specialist');
	});

	it('pre-fills system prompt in edit mode', () => {
		const agent = makeAgent({ systemPrompt: 'Always be brief.' });
		const { container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(textarea.value).toBe('Always be brief.');
	});

	// ── Validation ────────────────────────────────────────────────────────────

	it('shows name required error when submitting with empty name', async () => {
		const { getByRole, findByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		// Submit with empty name — validation should fail before even checking model
		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);
		expect(await findByText('Name is required')).toBeTruthy();
	});

	it('shows name uniqueness error when name conflicts with existing agent', async () => {
		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} existingAgentNames={['Existing Agent']} />
		);
		fillName(getByPlaceholderText, 'Existing Agent');
		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);
		expect(await findByText('An agent with this name already exists')).toBeTruthy();
	});

	it('name uniqueness check is case-insensitive', async () => {
		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} existingAgentNames={['existing agent']} />
		);
		fillName(getByPlaceholderText, 'EXISTING AGENT');
		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);
		expect(await findByText('An agent with this name already exists')).toBeTruthy();
	});

	it('shows model required error when submitting with empty model', async () => {
		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} />
		);
		fillName(getByPlaceholderText, 'My Agent');
		// Leave model empty
		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);
		expect(await findByText('Model is required')).toBeTruthy();
	});

	it('shows tools error when no tools are selected', async () => {
		const { container, getByPlaceholderText, getByRole, findByText } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} />
		);
		fillName(getByPlaceholderText, 'My Agent');
		fillModel(getByPlaceholderText, 'claude-sonnet-4-6');

		// Uncheck all tools via the checkboxes
		const checkboxes = container.querySelectorAll('input[type="checkbox"]');
		checkboxes.forEach((cb) => {
			if ((cb as HTMLInputElement).checked) {
				fireEvent.change(cb, { target: { checked: false } });
			}
		});

		// Click each checked tool label to toggle off
		// Instead, find all tool labels and click them to deselect
		const toolLabels = Array.from(container.querySelectorAll('label')).filter((l) => {
			const cb = l.querySelector('input[type="checkbox"]');
			return cb && (cb as HTMLInputElement).checked;
		});
		for (const label of toolLabels) {
			fireEvent.click(label);
		}

		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);
		expect(await findByText('At least one tool must be selected')).toBeTruthy();
	});

	// ── KNOWN_TOOLS ────────────────────────────────────────────────────────────

	it('renders all KNOWN_TOOLS as checkboxes', () => {
		const { getByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		for (const tool of KNOWN_TOOLS) {
			expect(getByText(tool)).toBeTruthy();
		}
	});

	// ── Tool presets ──────────────────────────────────────────────────────────

	it('applies "Full Coding" preset and selects expected tools', () => {
		const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		fireEvent.click(getByText('Full Coding'));

		const expectedTools = [
			'Read',
			'Write',
			'Edit',
			'Bash',
			'Grep',
			'Glob',
			'WebFetch',
			'WebSearch',
		];
		const toolCheckboxes = container.querySelectorAll('input[type="checkbox"]');
		const checkedTools = Array.from(toolCheckboxes)
			.filter((cb) => (cb as HTMLInputElement).checked)
			.map((cb) => (cb as HTMLInputElement).closest('label')?.textContent?.trim());

		for (const tool of expectedTools) {
			const found = Array.from(toolCheckboxes).some((cb) => {
				const label = (cb as HTMLInputElement).closest('label');
				return label?.textContent?.includes(tool) && (cb as HTMLInputElement).checked;
			});
			expect(found, `Expected ${tool} to be checked after Full Coding preset`).toBe(true);
		}
		// Task/TaskOutput/TaskStop should NOT be checked
		const taskNotChecked = Array.from(toolCheckboxes).every((cb) => {
			const label = (cb as HTMLInputElement).closest('label');
			const toolName = label?.textContent?.trim();
			if (toolName === 'Task' || toolName === 'TaskOutput' || toolName === 'TaskStop') {
				return !(cb as HTMLInputElement).checked;
			}
			return true;
		});
		expect(taskNotChecked).toBe(true);
	});

	it('applies "Read Only" preset and selects only Read, Grep, Glob', () => {
		const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		fireEvent.click(getByText('Read Only'));

		const toolCheckboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
		const checkedTools = toolCheckboxes
			.filter((cb) => (cb as HTMLInputElement).checked)
			.map((cb) => {
				const label = (cb as HTMLInputElement).closest('label');
				return label?.textContent?.trim() ?? '';
			});

		expect(checkedTools).toContain('Read');
		expect(checkedTools).toContain('Grep');
		expect(checkedTools).toContain('Glob');
		expect(checkedTools).not.toContain('Write');
		expect(checkedTools).not.toContain('Edit');
		expect(checkedTools).not.toContain('Bash');
	});

	it('switches active preset indicator to "Custom" when a tool is toggled manually', () => {
		const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

		// Start with Full Coding preset
		fireEvent.click(getByText('Full Coding'));

		// Toggle one tool off
		const toolCheckboxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
		const readCb = toolCheckboxes.find((cb) => {
			const label = (cb as HTMLInputElement).closest('label');
			return label?.textContent?.includes('Read');
		});
		if (readCb) fireEvent.click(readCb.closest('label')!);

		// "Custom" preset button should now be active
		const customButton = getByText('Custom');
		expect(customButton.className).toContain('blue');
	});

	// ── System prompt templates ───────────────────────────────────────────────

	it('applies "Coder" template text to system prompt', () => {
		const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		fireEvent.click(getByText('Coder'));
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(textarea.value).toContain('software engineer');
	});

	it('applies "Reviewer" template text to system prompt', () => {
		const { getAllByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		// "Reviewer" appears both in the role section and as a template button — click the button
		const reviewerButtons = getAllByText('Reviewer').filter(
			(el) => el.tagName.toLowerCase() === 'button'
		);
		expect(reviewerButtons.length).toBeGreaterThan(0);
		fireEvent.click(reviewerButtons[0]);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(textarea.value).toContain('code reviewer');
	});

	it('applies "Research" template text to system prompt', () => {
		const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		fireEvent.click(getByText('Research'));
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(textarea.value).toContain('research assistant');
	});

	it('clears system prompt when "Custom (blank)" template is applied', () => {
		const { getByText, container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		// First apply Coder template
		fireEvent.click(getByText('Coder'));
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(textarea.value).not.toBe('');

		// Then apply Custom (blank)
		fireEvent.click(getByText('Custom (blank)'));
		expect(textarea.value).toBe('');
	});

	// ── Role selection ─────────────────────────────────────────────────────────

	it('renders all three role options', () => {
		const { getAllByText, getByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		expect(getByText('Worker')).toBeTruthy();
		// "Reviewer" appears in both role section (as span) and template buttons (as button)
		expect(getAllByText('Reviewer').length).toBeGreaterThanOrEqual(1);
		expect(getByText('Orchestrator')).toBeTruthy();
	});

	it('defaults to "worker" role in create mode', () => {
		const { container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);
		const workerRadio = container.querySelector(
			'input[name="role"][value="worker"]'
		) as HTMLInputElement;
		expect(workerRadio.checked).toBe(true);
	});

	it('pre-selects role from agent prop in edit mode', () => {
		const agent = makeAgent({ role: 'reviewer' });
		const { container } = render(<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />);
		const reviewerRadio = container.querySelector(
			'input[name="role"][value="reviewer"]'
		) as HTMLInputElement;
		expect(reviewerRadio.checked).toBe(true);
	});

	// ── Create / Update submission ────────────────────────────────────────────

	it('calls spaceStore.createAgent with correct params in create mode', async () => {
		mockCreateAgent.mockResolvedValue({ id: 'new-agent', name: 'Fresh Agent' });

		const { getByPlaceholderText, getByRole, getByText } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} />
		);

		fillName(getByPlaceholderText, 'Fresh Agent');
		fillModel(getByPlaceholderText, 'claude-sonnet-4-6');
		// Full Coding preset is active by default

		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);

		await waitFor(() => {
			expect(mockCreateAgent).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'Fresh Agent',
					model: 'claude-sonnet-4-6',
					role: 'worker',
					tools: expect.any(Array),
				})
			);
		});
	});

	it('calls spaceStore.updateAgent in edit mode', async () => {
		const agent = makeAgent({ id: 'agent-1', name: 'My Coder', model: 'claude-haiku-4-5' });
		mockUpdateAgent.mockResolvedValue(agent);

		const { getByPlaceholderText, getByRole } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} agent={agent} />
		);

		// Change name
		const nameInput = getByPlaceholderText('e.g., Senior Coder') as HTMLInputElement;
		fireEvent.input(nameInput, { target: { value: 'Updated Coder' } });

		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);

		await waitFor(() => {
			expect(mockUpdateAgent).toHaveBeenCalledWith(
				'agent-1',
				expect.objectContaining({ name: 'Updated Coder' })
			);
		});
	});

	it('calls onSave after successful create', async () => {
		const onSave = vi.fn();
		mockCreateAgent.mockResolvedValue({});

		const { getByPlaceholderText, getByRole } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} onSave={onSave} />
		);

		fillName(getByPlaceholderText, 'New Agent');
		fillModel(getByPlaceholderText, 'claude-sonnet-4-6');

		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);

		await waitFor(() => {
			expect(onSave).toHaveBeenCalled();
		});
	});

	it('shows error message when save fails', async () => {
		mockCreateAgent.mockRejectedValue(new Error('Name already taken'));

		const { getByPlaceholderText, getByRole, findByText } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} />
		);

		fillName(getByPlaceholderText, 'New Agent');
		fillModel(getByPlaceholderText, 'claude-sonnet-4-6');

		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);

		expect(await findByText('Name already taken')).toBeTruthy();
	});

	it('does not call onSave when save fails', async () => {
		const onSave = vi.fn();
		mockCreateAgent.mockRejectedValue(new Error('Server error'));

		const { getByPlaceholderText, getByRole } = render(
			<SpaceAgentEditor {...DEFAULT_PROPS} onSave={onSave} />
		);

		fillName(getByPlaceholderText, 'New Agent');
		fillModel(getByPlaceholderText, 'claude-sonnet-4-6');

		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);

		await waitFor(() => {
			expect(mockCreateAgent).toHaveBeenCalled();
		});

		expect(onSave).not.toHaveBeenCalled();
	});

	// ── Cancel ────────────────────────────────────────────────────────────────

	it('calls onCancel when Cancel button is clicked', () => {
		const onCancel = vi.fn();
		const { getByText } = render(<SpaceAgentEditor {...DEFAULT_PROPS} onCancel={onCancel} />);
		fireEvent.click(getByText('Cancel'));
		expect(onCancel).toHaveBeenCalled();
	});

	// ── Provider field ────────────────────────────────────────────────────────

	it('includes provider in create params when set', async () => {
		mockCreateAgent.mockResolvedValue({});

		const { getByPlaceholderText, getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

		fillName(getByPlaceholderText, 'My Agent');
		fillModel(getByPlaceholderText, 'claude-sonnet-4-6');
		const providerInput = getByPlaceholderText('e.g., anthropic') as HTMLInputElement;
		fireEvent.input(providerInput, { target: { value: 'anthropic' } });

		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);

		await waitFor(() => {
			expect(mockCreateAgent).toHaveBeenCalledWith(
				expect.objectContaining({ provider: 'anthropic' })
			);
		});
	});

	it('omits provider from params when empty', async () => {
		mockCreateAgent.mockResolvedValue({});

		const { getByPlaceholderText, getByRole } = render(<SpaceAgentEditor {...DEFAULT_PROPS} />);

		fillName(getByPlaceholderText, 'My Agent');
		fillModel(getByPlaceholderText, 'claude-sonnet-4-6');

		const form = getByRole('dialog').querySelector('form');
		fireEvent.submit(form!);

		await waitFor(() => {
			expect(mockCreateAgent).toHaveBeenCalledWith(
				expect.not.objectContaining({ provider: expect.anything() })
			);
		});
	});
});
