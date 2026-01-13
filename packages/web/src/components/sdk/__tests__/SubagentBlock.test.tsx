// @ts-nocheck
/**
 * SubagentBlock Component Tests
 *
 * Tests subagent (Task tool) block rendering with nested messages
 */
import { describe, it, expect, mock, spyOn, vi } from 'vitest';

import { render, fireEvent } from '@testing-library/preact';
import { SubagentBlock } from '../SubagentBlock';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import type { AgentInput } from '@liuboer/shared/sdk/sdk-tools.d.ts';
import type { UUID } from 'crypto';

// Helper to create a valid UUID
const createUUID = (): UUID => crypto.randomUUID() as UUID;

// Factory functions for test data
function createAgentInput(subagentType: string, description: string, prompt: string): AgentInput {
	return {
		subagent_type: subagentType,
		description,
		prompt,
	};
}

function createNestedAssistantMessage(text: string): SDKMessage {
	return {
		type: 'assistant',
		message: {
			id: 'msg_nested',
			type: 'message',
			role: 'assistant',
			content: [{ type: 'text', text }],
			model: 'claude-3-5-sonnet-20241022',
			stop_reason: 'end_turn',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		parent_tool_use_id: 'toolu_task123',
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as SDKMessage;
}

function createNestedUserMessage(text: string): SDKMessage {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: text,
		},
		parent_tool_use_id: 'toolu_task123',
		uuid: createUUID(),
		session_id: 'test-session',
	};
}

function createNestedToolUseMessage(): SDKMessage {
	return {
		type: 'assistant',
		message: {
			id: 'msg_tool',
			type: 'message',
			role: 'assistant',
			content: [
				{
					type: 'tool_use',
					id: 'toolu_nested123',
					name: 'Read',
					input: { file_path: '/test/file.txt' },
				},
			],
			model: 'claude-3-5-sonnet-20241022',
			stop_reason: 'tool_use',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		parent_tool_use_id: 'toolu_task123',
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as SDKMessage;
}

describe('SubagentBlock', () => {
	describe('Basic Rendering', () => {
		it('should render subagent type badge', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			expect(container.textContent).toContain('Explore');
		});

		it('should render description', () => {
			const input = createAgentInput('Plan', 'Create a plan', 'Design the architecture');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			expect(container.textContent).toContain('Create a plan');
		});

		it('should be expandable', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			const button = container.querySelector('button');
			expect(button).toBeTruthy();
		});
	});

	describe('Subagent Types', () => {
		it('should render Explore type with cyan color scheme', () => {
			const input = createAgentInput('Explore', 'Explore codebase', 'Find relevant files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			expect(container.querySelector('.bg-cyan-50, .dark\\:bg-cyan-900\\/20')).toBeTruthy();
		});

		it('should render Plan type with violet color scheme', () => {
			const input = createAgentInput('Plan', 'Create plan', 'Design solution');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			expect(container.querySelector('.bg-violet-50, .dark\\:bg-violet-900\\/20')).toBeTruthy();
		});

		it('should render claude-code-guide type with amber color scheme', () => {
			const input = createAgentInput('claude-code-guide', 'Get guidance', 'How to do X');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			expect(container.querySelector('.bg-amber-50, .dark\\:bg-amber-900\\/20')).toBeTruthy();
		});

		it('should render general-purpose type with indigo color scheme', () => {
			const input = createAgentInput('general-purpose', 'General task', 'Do something');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			expect(container.querySelector('.bg-indigo-50, .dark\\:bg-indigo-900\\/20')).toBeTruthy();
		});

		it('should render unknown type with default indigo color scheme', () => {
			const input = createAgentInput('custom-type', 'Custom task', 'Custom prompt');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			// Default is indigo
			expect(container.querySelector('.bg-indigo-50, .dark\\:bg-indigo-900\\/20')).toBeTruthy();
		});
	});

	describe('Expanded State', () => {
		it('should show input section when expanded', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Input');
			expect(container.textContent).toContain('Search for test files');
		});

		it('should show output section when expanded', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const output = 'Found 5 test files in the project.';
			const { container } = render(
				<SubagentBlock input={input} output={output} toolId="toolu_task123" />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Output');
			expect(container.textContent).toContain('Found 5 test files');
		});

		it('should show "No output yet..." when output is empty', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('No output yet');
		});

		it('should collapse when button is clicked again', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			const button = container.querySelector('button')!;

			// Expand
			fireEvent.click(button);
			expect(container.textContent).toContain('Input');

			// Collapse
			fireEvent.click(button);
			// Input section should no longer be visible
			expect(container.querySelector('.border-t')).toBeFalsy();
		});
	});

	describe('Nested Messages', () => {
		it('should show nested messages section when messages are provided', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const nestedMessages = [createNestedAssistantMessage('I found the files.')];

			const { container } = render(
				<SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Messages (1)');
		});

		it('should render nested assistant messages', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const nestedMessages = [createNestedAssistantMessage('I found 3 test files.')];

			const { container } = render(
				<SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('I found 3 test files');
		});

		it('should render nested user messages', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const nestedMessages = [createNestedUserMessage('Check in the src folder.')];

			const { container } = render(
				<SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Check in the src folder');
		});

		it('should render nested tool use blocks', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const nestedMessages = [createNestedToolUseMessage()];
			const toolResultsMap = new Map([['toolu_nested123', { content: 'File content here' }]]);

			const { container } = render(
				<SubagentBlock
					input={input}
					toolId="toolu_task123"
					nestedMessages={nestedMessages}
					toolResultsMap={toolResultsMap}
				/>
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Read');
		});

		it('should show message count correctly', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const nestedMessages = [
				createNestedAssistantMessage('First message'),
				createNestedAssistantMessage('Second message'),
				createNestedAssistantMessage('Third message'),
			];

			const { container } = render(
				<SubagentBlock input={input} toolId="toolu_task123" nestedMessages={nestedMessages} />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Messages (3)');
		});
	});

	describe('Output Extraction', () => {
		it('should extract text from string output', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const output = 'Simple text output';

			const { container } = render(
				<SubagentBlock input={input} output={output} toolId="toolu_task123" />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Simple text output');
		});

		it('should extract text from object output with content field', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const output = { content: 'Content from object' };

			const { container } = render(
				<SubagentBlock input={input} output={output} toolId="toolu_task123" />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Content from object');
		});

		it('should extract text from object output with text field', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const output = { text: 'Text from object' };

			const { container } = render(
				<SubagentBlock input={input} output={output} toolId="toolu_task123" />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(container.textContent).toContain('Text from object');
		});

		it('should render markdown in output', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const output = '# Heading\n\nSome **bold** text.';

			const { container } = render(
				<SubagentBlock input={input} output={output} toolId="toolu_task123" />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			// MarkdownRenderer should process the content
			expect(container.textContent).toContain('Heading');
			expect(container.textContent).toContain('bold');
		});
	});

	describe('Error State', () => {
		it('should show error icon when isError is true', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');

			const { container } = render(
				<SubagentBlock input={input} isError={true} toolId="toolu_task123" />
			);

			// Error icon (X mark) should be visible
			const svg = container.querySelector('svg.text-red-600, svg.text-red-400');
			expect(svg).toBeTruthy();
		});

		it('should apply error styling to output text', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const output = 'An error occurred';

			const { container } = render(
				<SubagentBlock input={input} output={output} isError={true} toolId="toolu_task123" />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			// Output should have error styling
			expect(container.querySelector('.text-red-600, .text-red-400')).toBeTruthy();
		});
	});

	describe('Styling', () => {
		it('should have border and rounded corners', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			expect(container.querySelector('.border')).toBeTruthy();
			expect(container.querySelector('.rounded-lg')).toBeTruthy();
		});

		it('should apply custom className', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(
				<SubagentBlock input={input} toolId="toolu_task123" className="custom-class" />
			);

			expect(container.querySelector('.custom-class')).toBeTruthy();
		});

		it('should have full width header button', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			const button = container.querySelector('button');
			expect(button?.className).toContain('w-full');
		});
	});

	describe('Chevron Rotation', () => {
		it('should rotate chevron when expanded', () => {
			const input = createAgentInput('Explore', 'Find files', 'Search for test files');
			const { container } = render(<SubagentBlock input={input} toolId="toolu_task123" />);

			const button = container.querySelector('button')!;

			// Get chevron SVG (the last one in the header)
			const chevrons = button.querySelectorAll('svg');
			const chevron = chevrons[chevrons.length - 1];

			// Initially not rotated
			expect(chevron?.className.baseVal || chevron?.getAttribute('class')).not.toContain(
				'rotate-180'
			);

			// After click, should be rotated
			fireEvent.click(button);
			const rotatedChevrons = button.querySelectorAll('svg');
			const rotatedChevron = rotatedChevrons[rotatedChevrons.length - 1];
			expect(rotatedChevron?.className.baseVal || rotatedChevron?.getAttribute('class')).toContain(
				'rotate-180'
			);
		});
	});
});
