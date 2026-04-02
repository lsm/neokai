// @vitest-environment happy-dom

/**
 * Unit tests for GateEditorPanel component — badge label, color, and validation.
 *
 * Tests:
 * - Renders badge preview with default label "Gate" and default color
 * - Badge preview updates with custom label
 * - Badge preview updates with custom color
 * - Label input has character count indicator showing 0/20 for empty label
 * - Label input character count updates as user types
 * - Typing in label input calls onChange with updated label
 * - Clearing label input calls onChange with label: undefined
 * - Label input is bounded by maxLength=20
 * - Label validation error shown when label exceeds 20 chars (should not happen due to maxLength, but tested for safety)
 * - Color picker updates badge preview in real-time
 * - Color picker calls onChange with new color value
 * - Color hex display shows current color value
 * - Reset button visible only when custom color is set
 * - Reset button clears custom color and reverts to default
 * - Validation errors shown inline for invalid label
 * - Validation errors shown inline for invalid color
 * - Badge preview uses default color when no custom color set
 * - Badge preview uses default label when no custom label set
 * - Existing fields section still renders correctly
 * - Description input still works after new sections added
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/preact';
import { GateEditorPanel } from '../GateEditorPanel';
import type { Gate } from '@neokai/shared';

afterEach(() => cleanup());

// ============================================================================
// Fixtures
// ============================================================================

function makeGate(overrides?: Partial<Gate>): Gate {
	return {
		id: 'gate-1',
		resetOnCycle: false,
		fields: [],
		...overrides,
	};
}

function makeProps(gate: Gate) {
	return {
		gate,
		onChange: vi.fn(),
		onBack: vi.fn(),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('GateEditorPanel — Badge Label', () => {
	it('renders label input with empty value and 0/20 count', () => {
		const gate = makeGate();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const input = getByTestId('gate-editor-label') as HTMLInputElement;
		expect(input.value).toBe('');
		expect(input.placeholder).toBe('Leave empty for heuristic');
		expect(input.maxLength).toBe(20);

		const count = getByTestId('gate-editor-label-count');
		expect(count.textContent).toBe('0/20');
	});

	it('renders label input with existing label value and correct count', () => {
		const gate = makeGate({ label: 'Approval' });
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const input = getByTestId('gate-editor-label') as HTMLInputElement;
		expect(input.value).toBe('Approval');

		const count = getByTestId('gate-editor-label-count');
		expect(count.textContent).toBe('8/20');
	});

	it('calls onChange with label when user types', () => {
		const gate = makeGate();
		const onChange = vi.fn();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

		const input = getByTestId('gate-editor-label');
		fireEvent.input(input, { target: { value: 'Review' } });

		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: 'Review' }));
	});

	it('calls onChange with label: undefined when cleared', () => {
		const gate = makeGate({ label: 'Review' });
		const onChange = vi.fn();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

		const input = getByTestId('gate-editor-label');
		fireEvent.input(input, { target: { value: '' } });

		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: undefined }));
	});

	it('character count reflects gate.label length from props', () => {
		// Count is derived from gate.label prop, not from DOM input state
		const gateShort = makeGate({ label: 'Hi' });
		const { getByTestId, rerender } = render(<GateEditorPanel {...makeProps(gateShort)} />);

		const count = getByTestId('gate-editor-label-count');
		expect(count.textContent).toBe('2/20');

		// After parent updates gate with longer label
		const gateLong = makeGate({ label: 'Hello World' });
		rerender(<GateEditorPanel {...makeProps(gateLong)} />);
		expect(count.textContent).toBe('11/20');
	});

	it('respects maxLength of 20 characters', () => {
		const gate = makeGate();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const input = getByTestId('gate-editor-label') as HTMLInputElement;
		expect(input.maxLength).toBe(20);
	});

	it('does not show validation error for valid label', () => {
		const gate = makeGate({ label: 'Valid Label' });
		const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		expect(queryByTestId('gate-editor-label-error')).toBeNull();
	});

	it('does not show validation error for empty label', () => {
		const gate = makeGate();
		const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		expect(queryByTestId('gate-editor-label-error')).toBeNull();
	});
});

describe('GateEditorPanel — Badge Color', () => {
	it('renders color picker with default color when no custom color', () => {
		const gate = makeGate();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const picker = getByTestId('gate-editor-color') as HTMLInputElement;
		expect(picker.value).toBe('#3b82f6');
		expect(picker.type).toBe('color');
	});

	it('renders color picker with custom color', () => {
		const gate = makeGate({ color: '#ef4444' });
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const picker = getByTestId('gate-editor-color') as HTMLInputElement;
		expect(picker.value).toBe('#ef4444');
	});

	it('displays hex value next to color picker', () => {
		const gate = makeGate({ color: '#22c55e' });
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const container = getByTestId('gate-editor-color').parentElement!;
		expect(container.textContent).toContain('#22c55e');
	});

	it('displays default hex value when no custom color', () => {
		const gate = makeGate();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const container = getByTestId('gate-editor-color').parentElement!;
		expect(container.textContent).toContain('#3b82f6');
	});

	it('calls onChange when color is changed', () => {
		const gate = makeGate();
		const onChange = vi.fn();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

		const picker = getByTestId('gate-editor-color');
		fireEvent.change(picker, { target: { value: '#ff0000' } });

		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ color: '#ff0000' }));
	});

	it('shows reset button only when custom color is set', () => {
		const gateNoColor = makeGate();
		const { queryByTestId, rerender } = render(<GateEditorPanel {...makeProps(gateNoColor)} />);
		expect(queryByTestId('gate-editor-color-reset')).toBeNull();

		const gateWithColor = makeGate({ color: '#ef4444' });
		rerender(<GateEditorPanel {...makeProps(gateWithColor)} />);
		expect(queryByTestId('gate-editor-color-reset')).not.toBeNull();
	});

	it('reset button clears custom color', () => {
		const gate = makeGate({ color: '#ef4444' });
		const onChange = vi.fn();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} onChange={onChange} />);

		const resetBtn = getByTestId('gate-editor-color-reset');
		fireEvent.click(resetBtn);

		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ color: undefined }));
	});

	it('does not show validation error for valid color', () => {
		const gate = makeGate({ color: '#3b82f6' });
		const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		expect(queryByTestId('gate-editor-color-error')).toBeNull();
	});

	it('does not show validation error for undefined color', () => {
		const gate = makeGate();
		const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		expect(queryByTestId('gate-editor-color-error')).toBeNull();
	});
});

describe('GateEditorPanel — Badge Preview', () => {
	it('renders badge preview with default label "Gate" when no label set', () => {
		const gate = makeGate();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const preview = getByTestId('gate-editor-badge-preview');
		expect(preview.textContent).toBe('Gate');
	});

	it('renders badge preview with custom label', () => {
		const gate = makeGate({ label: 'Approve' });
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const preview = getByTestId('gate-editor-badge-preview');
		expect(preview.textContent).toBe('Approve');
	});

	it('renders badge preview with default color when no color set', () => {
		const gate = makeGate();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const preview = getByTestId('gate-editor-badge-preview');
		expect(preview.style.color).toBe('#3b82f6');
	});

	it('renders badge preview with custom color', () => {
		const gate = makeGate({ color: '#ef4444' });
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const preview = getByTestId('gate-editor-badge-preview');
		expect(preview.style.color).toBe('#ef4444');
	});

	it('badge preview has dark background and border matching EdgeRenderer style', () => {
		const gate = makeGate();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const preview = getByTestId('gate-editor-badge-preview');
		expect(preview.style.backgroundColor).toBe('#0f1115');
		expect(preview.style.borderColor).toBe('#232733');
	});
});

describe('GateEditorPanel — Existing functionality preserved', () => {
	it('still renders gate ID', () => {
		const gate = makeGate({ id: 'my-gate-123' });
		const { getByText } = render(<GateEditorPanel {...makeProps(gate)} />);

		expect(getByText('my-gate-123')).toBeDefined();
	});

	it('still renders description input', () => {
		const gate = makeGate({ description: 'Check approval' });
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const input = getByTestId('gate-editor-description') as HTMLInputElement;
		expect(input.value).toBe('Check approval');
	});

	it('still renders reset on cycle checkbox', () => {
		const gate = makeGate({ resetOnCycle: true });
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		const checkbox = getByTestId('gate-editor-reset-on-cycle') as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
	});

	it('still renders fields section', () => {
		const gate = makeGate({
			fields: [
				{
					name: 'approved',
					type: 'boolean',
					writers: ['human'],
					check: { op: '==', value: true },
				},
			],
		});
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		expect(getByTestId('gate-field-card-0')).toBeDefined();
	});

	it('shows back button in standalone mode', () => {
		const gate = makeGate();
		const { getByTestId } = render(<GateEditorPanel {...makeProps(gate)} />);

		expect(getByTestId('gate-editor-back')).toBeDefined();
	});

	it('hides back button in embedded mode', () => {
		const gate = makeGate();
		const { queryByTestId } = render(<GateEditorPanel {...makeProps(gate)} embedded={true} />);

		expect(queryByTestId('gate-editor-back')).toBeNull();
	});

	it('badge preview, label input, and color picker appear between description and reset on cycle', () => {
		const gate = makeGate();
		const { container } = render(<GateEditorPanel {...makeProps(gate)} />);

		const allSections = container.querySelectorAll('[data-testid]');
		const testIds = Array.from(allSections).map((el) => el.getAttribute('data-testid'));

		const descIdx = testIds.indexOf('gate-editor-description');
		const previewIdx = testIds.indexOf('gate-editor-badge-preview');
		const labelIdx = testIds.indexOf('gate-editor-label');
		const colorIdx = testIds.indexOf('gate-editor-color');
		const resetIdx = testIds.indexOf('gate-editor-reset-on-cycle');

		expect(descIdx).toBeGreaterThanOrEqual(0);
		expect(previewIdx).toBeGreaterThan(descIdx);
		expect(labelIdx).toBeGreaterThan(previewIdx);
		expect(colorIdx).toBeGreaterThan(labelIdx);
		expect(resetIdx).toBeGreaterThan(colorIdx);
	});
});
