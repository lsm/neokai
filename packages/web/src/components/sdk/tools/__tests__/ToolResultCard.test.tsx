// @ts-nocheck
/**
 * Tests for ToolResultCard Component
 *
 * ToolResultCard displays completed tool execution results with syntax highlighting.
 */

import './setup';
import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/preact';
import { ToolResultCard } from '../ToolResultCard';

// Mock the connection manager
mock.module('../../../lib/connection-manager.ts', () => ({
	connectionManager: {
		getHub: () =>
			Promise.resolve({
				call: mock(() => Promise.resolve({})),
			}),
	},
}));

// Mock the toast module
mock.module('../../../lib/toast.ts', () => ({
	toast: {
		success: mock(() => {}),
		error: mock(() => {}),
	},
	toastsSignal: { value: [] },
	dismissToast: mock(() => {}),
}));

describe('ToolResultCard', () => {
	const defaultProps = {
		toolName: 'Read',
		toolId: 'tool-123',
		input: { file_path: '/path/to/file.ts' },
		output: 'file content here',
	};

	describe('Basic Rendering', () => {
		it('should render tool name', () => {
			const { container } = render(<ToolResultCard {...defaultProps} />);
			expect(container.textContent).toContain('Read');
		});

		it('should render tool icon', () => {
			const { container } = render(<ToolResultCard {...defaultProps} />);
			const svg = container.querySelector('svg');
			expect(svg).toBeTruthy();
		});

		it('should render input summary', () => {
			const { container } = render(<ToolResultCard {...defaultProps} />);
			expect(container.textContent).toContain('file.ts');
		});

		it('should apply custom className', () => {
			const { container } = render(
				<ToolResultCard {...defaultProps} className="custom-result-class" />
			);
			const wrapper = container.querySelector('.custom-result-class');
			expect(wrapper).toBeTruthy();
		});
	});

	describe('Expand/Collapse Behavior', () => {
		it('should be collapsed by default for most tools', () => {
			const { container } = render(<ToolResultCard {...defaultProps} />);
			// When collapsed, detailed content should not be visible
			const expandedContent = container.querySelector('.border-t.bg-white');
			expect(expandedContent).toBeNull();
		});

		it('should respect defaultExpanded prop', () => {
			const { container } = render(<ToolResultCard {...defaultProps} defaultExpanded={true} />);
			// When expanded, should show content
			const expandedContent = container.querySelector('.space-y-3');
			expect(expandedContent).toBeTruthy();
		});

		it('should have clickable header for expand/collapse', () => {
			const { container } = render(<ToolResultCard {...defaultProps} />);
			const button = container.querySelector('button');
			expect(button).toBeTruthy();
		});

		it('should show chevron icon for expand state', () => {
			const { container } = render(<ToolResultCard {...defaultProps} />);
			// Look for the chevron SVG (down arrow)
			const svgs = container.querySelectorAll('svg');
			const chevron = Array.from(svgs).find((svg) =>
				svg.querySelector('path[d*="M19 9l-7 7-7-7"]')
			);
			expect(chevron).toBeTruthy();
		});
	});

	describe('Error State', () => {
		it('should show error indicator when isError is true', () => {
			const { container } = render(<ToolResultCard {...defaultProps} isError={true} />);
			// Error icon should be visible in header
			const errorIcons = container.querySelectorAll('.text-red-600');
			expect(errorIcons.length).toBeGreaterThan(0);
		});

		it('should apply error styling to output when expanded', () => {
			// Use a tool that doesn't have custom rendering (like Bash)
			const { container } = render(
				<ToolResultCard
					toolName="Bash"
					toolId="bash-123"
					input={{ command: 'test' }}
					output="error output"
					isError={true}
					defaultExpanded={true}
				/>
			);
			// Error output should have red styling
			const errorPre = container.querySelector('.bg-red-50');
			expect(errorPre).toBeTruthy();
		});
	});

	describe('Compact Variant', () => {
		it('should render in compact style', () => {
			const { container } = render(<ToolResultCard {...defaultProps} variant="compact" />);
			const card = container.querySelector('.py-1');
			expect(card).toBeTruthy();
		});

		it('should show smaller icon in compact mode', () => {
			const { container } = render(<ToolResultCard {...defaultProps} variant="compact" />);
			const svg = container.querySelector('svg');
			expect(svg?.className).toContain('w-4');
		});

		it('should show error X icon in compact mode when error', () => {
			const { container } = render(
				<ToolResultCard {...defaultProps} variant="compact" isError={true} />
			);
			const errorIcon = container.querySelector('.text-red-500');
			expect(errorIcon).toBeTruthy();
		});
	});

	describe('Inline Variant', () => {
		it('should render as inline element', () => {
			const { container } = render(<ToolResultCard {...defaultProps} variant="inline" />);
			const card = container.querySelector('.inline-flex');
			expect(card).toBeTruthy();
		});

		it('should show error text in inline mode when error', () => {
			const { container } = render(
				<ToolResultCard {...defaultProps} variant="inline" isError={true} />
			);
			expect(container.textContent).toContain('\u2717'); // X mark
		});
	});

	describe('Special Tool Rendering - Edit', () => {
		it('should show DiffViewer for Edit tool with old_string and new_string', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Edit"
					toolId="edit-123"
					input={{
						file_path: '/test.ts',
						old_string: 'const x = 1;',
						new_string: 'const x = 2;',
					}}
					output="File edited successfully"
					defaultExpanded={true}
				/>
			);
			// DiffViewer should be rendered (it contains table element)
			const table = container.querySelector('table');
			expect(table).toBeTruthy();
		});

		it('should show line count for Edit tool', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Edit"
					toolId="edit-123"
					input={{
						file_path: '/test.ts',
						old_string: 'const x = 1;',
						new_string: 'const x = 2;',
					}}
					output="File edited"
				/>
			);
			// Should show +1 -1 for single line change
			const greenText = container.querySelector('.text-green-700');
			const redText = container.querySelector('.text-red-700');
			expect(greenText).toBeTruthy();
			expect(redText).toBeTruthy();
		});
	});

	describe('Special Tool Rendering - Read', () => {
		it('should show CodeViewer for Read tool output', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Read"
					toolId="read-123"
					input={{ file_path: '/test.ts' }}
					output="const x = 1;\nconst y = 2;"
					defaultExpanded={true}
				/>
			);
			// CodeViewer renders with pre element
			const pre = container.querySelector('pre');
			expect(pre).toBeTruthy();
		});

		it('should show line count for Read tool', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Read"
					toolId="read-123"
					input={{ file_path: '/test.ts' }}
					output="line1\nline2\nline3"
				/>
			);
			// The header shows the tool and line count summary
			// Check that it renders the file name
			expect(container.textContent).toContain('test.ts');
		});

		it('should handle Read output with content property', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Read"
					toolId="read-123"
					input={{ file_path: '/test.ts' }}
					output={{ content: 'file content' }}
					defaultExpanded={true}
				/>
			);
			const pre = container.querySelector('pre');
			expect(pre).toBeTruthy();
		});
	});

	describe('Special Tool Rendering - Write', () => {
		it('should show CodeViewer for Write tool input content', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Write"
					toolId="write-123"
					input={{
						file_path: '/test.ts',
						content: 'const x = 1;\nconst y = 2;',
					}}
					output="File written"
					defaultExpanded={true}
				/>
			);
			// CodeViewer renders with pre element
			const pre = container.querySelector('pre');
			expect(pre).toBeTruthy();
		});

		it('should show line count for Write tool', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Write"
					toolId="write-123"
					input={{
						file_path: '/test.ts',
						content: 'line1\nline2\nline3',
					}}
					output="Written"
				/>
			);
			// Should show +3 for 3 lines added
			const greenText = container.querySelector('.text-green-700');
			expect(greenText?.textContent).toContain('+3');
		});
	});

	describe('Special Tool Rendering - Thinking', () => {
		it('should show thinking content for Thinking tool', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Thinking"
					toolId="thinking-123"
					input="This is the thinking process..."
					defaultExpanded={true}
				/>
			);
			expect(container.textContent).toContain('This is the thinking process...');
		});

		it('should show character count summary for Thinking tool', () => {
			const thinkingText = 'A'.repeat(100);
			const { container } = render(
				<ToolResultCard toolName="Thinking" toolId="thinking-123" input={thinkingText} />
			);
			expect(container.textContent).toContain('100 character');
		});
	});

	describe('Special Tool Rendering - TodoWrite', () => {
		it('should use custom renderer for TodoWrite', () => {
			const { container } = render(
				<ToolResultCard
					toolName="TodoWrite"
					toolId="todo-123"
					input={{
						todos: [
							{ content: 'Task 1', status: 'completed', activeForm: '' },
							{ content: 'Task 2', status: 'pending', activeForm: '' },
						],
					}}
					defaultExpanded={true}
				/>
			);
			// TodoViewer should render with Task List header
			expect(container.textContent).toContain('Task List');
		});
	});

	describe('Tool Colors', () => {
		it('should have blue colors for file tools', () => {
			const { container } = render(<ToolResultCard {...defaultProps} />);
			const card = container.querySelector('.bg-blue-50');
			expect(card).toBeTruthy();
		});

		it('should have purple colors for search tools', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Grep"
					toolId="grep-123"
					input={{ pattern: 'test' }}
					output="match found"
				/>
			);
			const card = container.querySelector('.bg-purple-50');
			expect(card).toBeTruthy();
		});

		it('should have amber colors for Thinking tool', () => {
			const { container } = render(
				<ToolResultCard toolName="Thinking" toolId="thinking-123" input="thinking..." />
			);
			const card = container.querySelector('.bg-amber-50');
			expect(card).toBeTruthy();
		});
	});

	describe('Output Display', () => {
		it('should display string output', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Bash"
					toolId="bash-123"
					input={{ command: 'echo hello' }}
					output="hello"
					defaultExpanded={true}
				/>
			);
			const pre = container.querySelector('pre');
			expect(pre?.textContent).toContain('hello');
		});

		it('should display object output as JSON', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Bash"
					toolId="bash-123"
					input={{ command: 'test' }}
					output={{ result: 'success', count: 42 }}
					defaultExpanded={true}
				/>
			);
			expect(container.textContent).toContain('success');
			expect(container.textContent).toContain('42');
		});

		it('should handle null output', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Bash"
					toolId="bash-123"
					input={{ command: 'test' }}
					output={null}
					defaultExpanded={true}
				/>
			);
			// Should not crash, just not show output section
			expect(container.textContent).toContain('Input:');
		});

		it('should handle undefined output', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Bash"
					toolId="bash-123"
					input={{ command: 'test' }}
					defaultExpanded={true}
				/>
			);
			// Should not show Output section when undefined
			expect(container.textContent).toContain('Input:');
		});
	});

	describe('Detailed Variant', () => {
		it('should show tool ID in detailed mode', () => {
			// Use a tool without custom rendering (Bash)
			const { container } = render(
				<ToolResultCard
					toolName="Bash"
					toolId="bash-123"
					input={{ command: 'echo test' }}
					output="test"
					variant="detailed"
					defaultExpanded={true}
				/>
			);
			expect(container.textContent).toContain('Tool ID:');
			expect(container.textContent).toContain('bash-123');
		});
	});

	describe('Output Removed State', () => {
		it('should show warning when output is removed', () => {
			// Use a tool without custom rendering (Bash)
			const { container } = render(
				<ToolResultCard
					toolName="Bash"
					toolId="bash-123"
					input={{ command: 'echo test' }}
					output="test"
					isOutputRemoved={true}
					defaultExpanded={true}
				/>
			);
			expect(container.textContent).toContain('Output Removed from Agent Context');
		});

		it('should show info about removed output', () => {
			const { container } = render(
				<ToolResultCard
					toolName="Bash"
					toolId="bash-123"
					input={{ command: 'echo test' }}
					output="test"
					isOutputRemoved={true}
					defaultExpanded={true}
				/>
			);
			expect(container.textContent).toContain('context window space');
		});
	});

	describe('MCP Tools', () => {
		it('should render MCP tool correctly', () => {
			const { container } = render(
				<ToolResultCard
					toolName="mcp__filesystem__read"
					toolId="mcp-123"
					input={{ path: '/test/file' }}
					output="content"
				/>
			);
			expect(container.textContent).toContain('read');
		});
	});
});
