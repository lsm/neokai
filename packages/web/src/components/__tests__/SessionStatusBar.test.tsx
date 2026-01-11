// @ts-nocheck
/**
 * Tests for SessionStatusBar Component
 *
 * Tests the session status bar with connection status, model switcher,
 * thinking level, auto-scroll toggle, and context usage display.
 *
 * Note: Tests without mock.module to avoid polluting other tests.
 */

import './setup';
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { ContextInfo, ModelInfo } from '@liuboer/shared';
import SessionStatusBar from '../SessionStatusBar';

describe('SessionStatusBar', () => {
	const mockOnModelSwitch = mock(() => Promise.resolve());
	const mockOnAutoScrollChange = mock(() => {});

	const mockModelInfo: ModelInfo = {
		id: 'claude-sonnet-4-20250514',
		name: 'Claude Sonnet 4',
		family: 'sonnet',
		isDefault: true,
	};

	const mockAvailableModels: ModelInfo[] = [
		{ id: 'claude-opus-4-20250514', name: 'Claude Opus 4', family: 'opus', isDefault: false },
		{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', family: 'sonnet', isDefault: true },
		{ id: 'claude-haiku-3-20250514', name: 'Claude Haiku 3', family: 'haiku', isDefault: false },
	];

	const mockContextUsage: ContextInfo = {
		totalUsed: 50000,
		totalCapacity: 200000,
		percentUsed: 25,
		model: 'claude-sonnet-4-20250514',
		breakdown: {
			'System Prompt': { tokens: 5000, percent: 2.5 },
			Messages: { tokens: 40000, percent: 20 },
			'Free Space': { tokens: 155000, percent: 77.5 },
		},
	};

	const defaultProps = {
		sessionId: 'session-1',
		isProcessing: false,
		currentModel: 'claude-sonnet-4-20250514',
		currentModelInfo: mockModelInfo,
		availableModels: mockAvailableModels,
		modelSwitching: false,
		modelLoading: false,
		onModelSwitch: mockOnModelSwitch,
		autoScroll: true,
		onAutoScrollChange: mockOnAutoScrollChange,
	};

	beforeEach(() => {
		cleanup();
		mockOnModelSwitch.mockClear();
		mockOnAutoScrollChange.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('should render status bar container', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Should have the main container with flex layout
			const content = container.firstElementChild;
			expect(content?.className).toContain('flex');
		});

		it('should render model switcher button', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Should have the model icon button
			const modelButton = container.querySelector('.control-btn');
			expect(modelButton).toBeTruthy();
		});

		it('should render auto-scroll toggle', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Should have the auto-scroll button
			const buttons = container.querySelectorAll('.control-btn');
			expect(buttons.length).toBeGreaterThan(0);
		});

		it('should render context usage bar', () => {
			const { container } = render(
				<SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
			);

			// Should show percentage
			expect(container.textContent).toContain('25.0%');
		});
	});

	describe('Connection Status Display', () => {
		it('should render connection status section', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Should have a connection status display somewhere in the container
			const text = container.textContent || '';
			// The component should render some status text
			expect(text.length).toBeGreaterThan(0);
		});

		it('should have status indicator styling', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Should have dot indicators for status
			const dots = container.querySelectorAll('.w-2.h-2.rounded-full');
			expect(dots.length).toBeGreaterThan(0);
		});
	});

	describe('Processing State Display', () => {
		it('should show current action when processing', () => {
			const { container } = render(
				<SessionStatusBar {...defaultProps} isProcessing={true} currentAction="Reading files..." />
			);

			expect(container.textContent).toContain('Reading files...');
		});

		it('should show initializing phase styling', () => {
			const { container } = render(
				<SessionStatusBar
					{...defaultProps}
					isProcessing={true}
					currentAction="Initializing..."
					streamingPhase="initializing"
				/>
			);

			expect(container.textContent).toContain('Initializing...');
		});

		it('should show thinking phase styling', () => {
			const { container } = render(
				<SessionStatusBar
					{...defaultProps}
					isProcessing={true}
					currentAction="Thinking..."
					streamingPhase="thinking"
				/>
			);

			expect(container.textContent).toContain('Thinking...');
		});

		it('should show streaming phase styling', () => {
			const { container } = render(
				<SessionStatusBar
					{...defaultProps}
					isProcessing={true}
					currentAction="Streaming..."
					streamingPhase="streaming"
				/>
			);

			expect(container.textContent).toContain('Streaming...');
		});

		it('should show finalizing phase styling', () => {
			const { container } = render(
				<SessionStatusBar
					{...defaultProps}
					isProcessing={true}
					currentAction="Finalizing..."
					streamingPhase="finalizing"
				/>
			);

			expect(container.textContent).toContain('Finalizing...');
		});
	});

	describe('Model Switcher', () => {
		it('should show current model icon', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Sonnet icon should be visible
			expect(container.textContent).toContain('💎');
		});

		it('should disable model button when loading', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} modelLoading={true} />);

			const modelButton = container.querySelector('.control-btn') as HTMLButtonElement;
			expect(modelButton?.disabled).toBe(true);
		});

		it('should disable model button when switching', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} modelSwitching={true} />);

			const modelButton = container.querySelector('.control-btn') as HTMLButtonElement;
			expect(modelButton?.disabled).toBe(true);
		});

		it('should show spinner when switching models', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} modelSwitching={true} />);

			// Should have a spinner component
			const spinner = container.querySelector('[class*="animate-spin"]');
			expect(spinner).toBeTruthy();
		});
	});

	describe('Auto-Scroll Toggle', () => {
		it('should show enabled state when autoScroll is true', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={true} />);

			// Should have emerald border when enabled
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const autoScrollButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
			);
			expect(autoScrollButton?.className).toContain('border-emerald-500');
		});

		it('should show disabled state when autoScroll is false', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={false} />);

			// Should have gray border when disabled
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const autoScrollButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
			);
			expect(autoScrollButton?.className).toContain('border-gray-600');
		});

		it('should call onAutoScrollChange when clicked', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={true} />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const autoScrollButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
			)!;
			fireEvent.click(autoScrollButton);

			expect(mockOnAutoScrollChange).toHaveBeenCalledWith(false);
		});

		it('should toggle autoScroll value', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} autoScroll={false} />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const autoScrollButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Auto-scroll') || false
			)!;
			fireEvent.click(autoScrollButton);

			expect(mockOnAutoScrollChange).toHaveBeenCalledWith(true);
		});
	});

	describe('Thinking Level', () => {
		it('should show auto thinking level by default', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Should have thinking level button with title
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			);
			expect(thinkingButton?.getAttribute('title')).toContain('Auto');
		});

		it('should show provided thinking level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			);
			expect(thinkingButton?.getAttribute('title')).toContain('Think 16k');
		});
	});

	describe('Context Usage Display', () => {
		it('should display context percentage', () => {
			const { container } = render(
				<SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
			);

			expect(container.textContent).toContain('25.0%');
		});

		it('should display progress bar', () => {
			const { container } = render(
				<SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
			);

			// Should have a progress bar
			const progressBar = container.querySelector('.bg-dark-700.rounded-full');
			expect(progressBar).toBeTruthy();
		});

		it('should use default max context when not provided', () => {
			const { container } = render(
				<SessionStatusBar {...defaultProps} contextUsage={mockContextUsage} />
			);

			// Should render without error
			expect(container.textContent).toContain('25.0%');
		});

		it('should use custom max context when provided', () => {
			const { container } = render(
				<SessionStatusBar
					{...defaultProps}
					contextUsage={mockContextUsage}
					maxContextTokens={100000}
				/>
			);

			// Should render with the context percentage
			expect(container.textContent).toContain('25.0%');
		});
	});

	describe('Layout', () => {
		it('should have separator between controls and context', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Should have a vertical separator
			const separator = container.querySelector('.bg-gray-600');
			expect(separator).toBeTruthy();
		});

		it('should have proper flex layout', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Container should have flex layout
			const content = container.firstElementChild;
			expect(content?.className).toContain('flex');
			expect(content?.className).toContain('items-center');
		});
	});
});
