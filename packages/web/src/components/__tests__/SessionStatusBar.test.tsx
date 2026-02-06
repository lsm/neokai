// @ts-nocheck
/**
 * Tests for SessionStatusBar Component
 *
 * Tests the session status bar with connection status, model switcher,
 * thinking level, auto-scroll toggle, and context usage display.
 *
 * Note: Tests without mock.module to avoid polluting other tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { ContextInfo, ModelInfo } from '@neokai/shared';
import SessionStatusBar from '../SessionStatusBar';

describe('SessionStatusBar', () => {
	const mockOnModelSwitch = vi.fn(() => Promise.resolve());
	const mockOnAutoScrollChange = vi.fn(() => {});
	const mockOnCoordinatorModeChange = vi.fn(() => {});

	const mockModelInfo: ModelInfo = {
		id: 'sonnet',
		name: 'Sonnet 4.5',
		family: 'sonnet',
		isDefault: true,
	};

	const mockAvailableModels: ModelInfo[] = [
		{
			id: 'opus',
			name: 'Opus 4.5',
			family: 'opus',
			isDefault: false,
		},
		{
			id: 'sonnet',
			name: 'Sonnet 4.5',
			family: 'sonnet',
			isDefault: true,
		},
		{
			id: 'haiku',
			name: 'Haiku 4.5',
			family: 'haiku',
			isDefault: false,
		},
	];

	const mockContextUsage: ContextInfo = {
		totalUsed: 50000,
		totalCapacity: 200000,
		percentUsed: 25,
		model: 'sonnet',
		breakdown: {
			'System Prompt': { tokens: 5000, percent: 2.5 },
			Messages: { tokens: 40000, percent: 20 },
			'Free Space': { tokens: 155000, percent: 77.5 },
		},
	};

	const defaultProps = {
		sessionId: 'session-1',
		isProcessing: false,
		currentModel: 'sonnet',
		currentModelInfo: mockModelInfo,
		availableModels: mockAvailableModels,
		modelSwitching: false,
		modelLoading: false,
		onModelSwitch: mockOnModelSwitch,
		autoScroll: true,
		onAutoScrollChange: mockOnAutoScrollChange,
		coordinatorMode: true,
		coordinatorSwitching: false,
		onCoordinatorModeChange: mockOnCoordinatorModeChange,
	};

	beforeEach(() => {
		cleanup();
		mockOnModelSwitch.mockClear();
		mockOnAutoScrollChange.mockClear();
		mockOnCoordinatorModeChange.mockClear();
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

			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
			expect(modelButton?.disabled).toBe(true);
		});

		it('should disable model button when switching', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} modelSwitching={true} />);

			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
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

	describe('Model Dropdown', () => {
		it('should open model dropdown when clicked', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
			fireEvent.click(modelButton);

			// Should show the dropdown with model options
			expect(container.textContent).toContain('Select Model');
		});

		it('should show all available models in dropdown', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
			fireEvent.click(modelButton);

			expect(container.textContent).toContain('Claude Opus 4');
			expect(container.textContent).toContain('Claude Sonnet 4');
			expect(container.textContent).toContain('Claude Haiku 3');
		});

		it('should show current model indicator', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
			fireEvent.click(modelButton);

			expect(container.textContent).toContain('(current)');
		});

		it('should call onModelSwitch when a model is selected', async () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
			fireEvent.click(modelButton);

			// Find and click the Opus model button
			const buttons = Array.from(container.querySelectorAll('button'));
			const opusButton = buttons.find((btn) => btn.textContent?.includes('Claude Opus 4'));
			fireEvent.click(opusButton!);

			expect(mockOnModelSwitch).toHaveBeenCalledWith('opus');
		});

		it('should close model dropdown when clicking it again', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;

			// Open
			fireEvent.click(modelButton);
			expect(container.textContent).toContain('Select Model');

			// Close
			fireEvent.click(modelButton);
			expect(container.textContent).not.toContain('Select Model');
		});

		it('should close thinking dropdown when opening model dropdown', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Open thinking dropdown first
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			)!;
			fireEvent.click(thinkingButton);
			expect(container.textContent).toContain('Thinking Level');

			// Open model dropdown
			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
			fireEvent.click(modelButton);

			// Model dropdown should be open, thinking dropdown should be closed
			expect(container.textContent).toContain('Select Model');
			expect(container.textContent).not.toContain('Thinking Level');
		});
	});

	describe('Thinking Dropdown', () => {
		it('should open thinking dropdown when clicked', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			)!;
			fireEvent.click(thinkingButton);

			expect(container.textContent).toContain('Thinking Level');
		});

		it('should show all thinking levels in dropdown', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			)!;
			fireEvent.click(thinkingButton);

			expect(container.textContent).toContain('Auto');
			expect(container.textContent).toContain('Think 8k');
			expect(container.textContent).toContain('Think 16k');
			expect(container.textContent).toContain('Think 32k');
		});

		it('should close thinking dropdown when clicking it again', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			)!;

			// Open
			fireEvent.click(thinkingButton);
			expect(container.textContent).toContain('Thinking Level');

			// Close
			fireEvent.click(thinkingButton);
			expect(container.textContent).not.toContain('Thinking Level');
		});

		it('should close model dropdown when opening thinking dropdown', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} />);

			// Open model dropdown first
			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
			fireEvent.click(modelButton);
			expect(container.textContent).toContain('Select Model');

			// Open thinking dropdown
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			)!;
			fireEvent.click(thinkingButton);

			// Thinking dropdown should be open, model dropdown should be closed
			expect(container.textContent).toContain('Thinking Level');
			expect(container.textContent).not.toContain('Select Model');
		});

		it('should change thinking level when option is selected', () => {
			const { container, rerender } = render(<SessionStatusBar {...defaultProps} />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			)!;
			fireEvent.click(thinkingButton);

			// Find and click Think 16k option
			const allButtons = Array.from(container.querySelectorAll('button'));
			const think16kButton = allButtons.find((btn) => btn.textContent?.includes('Think 16k'));
			fireEvent.click(think16kButton!);

			// Re-render with new thinking level
			rerender(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

			// Check title updated
			const updatedButtons = Array.from(container.querySelectorAll('.control-btn'));
			const updatedThinkingButton = updatedButtons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			);
			expect(updatedThinkingButton?.getAttribute('title')).toContain('Think 16k');
		});
	});

	describe('ThinkingLevelIcon Brightness', () => {
		// Helper to get the icon SVG (not the border ring which has class "absolute")
		const getThinkingIcon = (container: Element) => {
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			);
			// Get all SVGs and find the one that's not the absolute positioned border ring
			const svgs = thinkingButton?.querySelectorAll('svg');
			if (!svgs) return null;
			for (const svg of Array.from(svgs)) {
				const classes = svg.className.baseVal || svg.getAttribute('class') || '';
				if (!classes.includes('absolute')) {
					return svg;
				}
			}
			return null;
		};

		it('should show gray icon for auto level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="auto" />);

			const svg = getThinkingIcon(container);
			expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-gray-400');
		});

		it('should show amber-600 icon for think8k level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think8k" />);

			const svg = getThinkingIcon(container);
			expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-amber-600');
		});

		it('should show amber-500 icon for think16k level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

			const svg = getThinkingIcon(container);
			expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-amber-500');
		});

		it('should show amber-400 icon for think32k level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think32k" />);

			const svg = getThinkingIcon(container);
			expect(svg?.className.baseVal || svg?.getAttribute('class')).toContain('text-amber-400');
		});
	});

	describe('ThinkingBorderRing', () => {
		it('should not show border ring for auto level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="auto" />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			);
			// Auto level should have gray border, not amber ring
			expect(thinkingButton?.className).toContain('border-gray-600');
		});

		it('should show border ring for think8k level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think8k" />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			);
			// Should have the SVG ring
			const ring = thinkingButton?.querySelector('svg.absolute');
			expect(ring).toBeTruthy();
		});

		it('should show border ring for think16k level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think16k" />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			);
			const ring = thinkingButton?.querySelector('svg.absolute');
			expect(ring).toBeTruthy();
		});

		it('should show border ring for think32k level', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} thinkingLevel="think32k" />);

			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const thinkingButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Thinking:') || false
			);
			const ring = thinkingButton?.querySelector('svg.absolute');
			expect(ring).toBeTruthy();
		});
	});

	describe('Model Family Icons', () => {
		it('should show opus icon for opus model', () => {
			const opusModelInfo: ModelInfo = {
				id: 'opus',
				name: 'Claude Opus 4',
				family: 'opus',
				isDefault: false,
			};
			const { container } = render(
				<SessionStatusBar {...defaultProps} currentModelInfo={opusModelInfo} />
			);

			// Opus icon should be visible
			expect(container.textContent).toContain('🧠');
		});

		it('should show haiku icon for haiku model', () => {
			const haikuModelInfo: ModelInfo = {
				id: 'haiku',
				name: 'Claude Haiku 3',
				family: 'haiku',
				isDefault: false,
			};
			const { container } = render(
				<SessionStatusBar {...defaultProps} currentModelInfo={haikuModelInfo} />
			);

			// Haiku icon should be visible
			expect(container.textContent).toContain('⚡');
		});

		it('should show default icon when no model info', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} currentModelInfo={null} />);

			// Default gem icon should be visible
			expect(container.textContent).toContain('💎');
		});
	});

	describe('Coordinator Mode Toggle', () => {
		it('should show spinner when coordinator is switching', () => {
			const { container } = render(
				<SessionStatusBar {...defaultProps} coordinatorSwitching={true} />
			);
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const coordinatorButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
			);
			const spinner = coordinatorButton?.querySelector('[class*="animate-spin"]');
			expect(spinner).toBeTruthy();
		});

		it('should disable coordinator button when coordinator is switching', () => {
			const { container } = render(
				<SessionStatusBar {...defaultProps} coordinatorSwitching={true} />
			);
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const coordinatorButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
			) as HTMLButtonElement;
			expect(coordinatorButton?.disabled).toBe(true);
		});

		it('should disable coordinator button when model is switching', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} modelSwitching={true} />);
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const coordinatorButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
			) as HTMLButtonElement;
			expect(coordinatorButton?.disabled).toBe(true);
		});

		it('should disable model button when coordinator is switching', () => {
			const { container } = render(
				<SessionStatusBar {...defaultProps} coordinatorSwitching={true} />
			);
			const modelButton = container.querySelector(
				'.control-btn[title*="Switch Model"]'
			) as HTMLButtonElement;
			expect(modelButton?.disabled).toBe(true);
		});

		it('should call onCoordinatorModeChange when clicked', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} coordinatorMode={true} />);
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const coordinatorButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
			)!;
			fireEvent.click(coordinatorButton);
			expect(mockOnCoordinatorModeChange).toHaveBeenCalledWith(false);
		});

		it('should show purple border when coordinator mode is enabled', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} coordinatorMode={true} />);
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const coordinatorButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
			);
			expect(coordinatorButton?.className).toContain('border-purple-500');
		});

		it('should show gray border when coordinator mode is disabled', () => {
			const { container } = render(<SessionStatusBar {...defaultProps} coordinatorMode={false} />);
			const buttons = Array.from(container.querySelectorAll('.control-btn'));
			const coordinatorButton = buttons.find(
				(btn) => btn.getAttribute('title')?.includes('Coordinator Mode') || false
			);
			expect(coordinatorButton?.className).toContain('border-gray-600');
		});
	});
});
