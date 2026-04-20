// @ts-nocheck
/**
 * SpaceSystemInitCard tests — verify the collapsed card renders at the same
 * "chrome" as SDKResultMessage so the two cards line up vertically in the
 * compact task feed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { SpaceSystemInitCard } from './SpaceSystemInitCard';
import { SDKResultMessage } from '../../../sdk/SDKResultMessage';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';

function makeInitMessage(overrides: Partial<Record<string, unknown>> = {}): SDKMessage {
	return {
		type: 'system',
		subtype: 'init',
		model: 'claude-sonnet-4-5-20250929',
		permissionMode: 'default',
		cwd: '/workspace',
		tools: ['Read', 'Write', 'Bash'],
		mcp_servers: [{ name: 'example', status: 'connected' }],
		slash_commands: ['init'],
		agents: ['coder'],
		apiKeySource: 'env',
		...overrides,
	} as unknown as SDKMessage;
}

function makeSuccessResult() {
	return {
		type: 'result',
		subtype: 'success',
		uuid: 'result-1',
		usage: {
			input_tokens: 100,
			output_tokens: 50,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		total_cost_usd: 0.0123,
		duration_ms: 1500,
		duration_api_ms: 1200,
		num_turns: 2,
		modelUsage: {},
		permission_denials: [],
		result: 'done',
	} as any;
}

describe('SpaceSystemInitCard', () => {
	afterEach(() => cleanup());

	describe('collapsed state', () => {
		it('renders as a single-row toggle with "Session Started" label', () => {
			const { getByTestId, container } = render(
				<SpaceSystemInitCard message={makeInitMessage()} />
			);
			expect(getByTestId('compact-system-init-card')).toBeTruthy();
			const toggle = getByTestId('compact-system-init-toggle') as HTMLButtonElement;
			expect(toggle.textContent).toContain('Session Started');
			// Collapsed — no details
			expect(container.querySelector('[data-testid="compact-system-init-details"]')).toBeNull();
		});

		it('applies the same padding + text-size classes as SDKResultMessage for height parity', () => {
			// Render both cards and compare the collapsed header button's
			// utility classes. These are the only classes that affect
			// collapsed-state row height (padding and text size).
			const { getByTestId: getInitTestId } = render(
				<SpaceSystemInitCard message={makeInitMessage()} />
			);
			const initButton = getInitTestId('compact-system-init-toggle') as HTMLButtonElement;

			const result = render(<SDKResultMessage message={makeSuccessResult()} />);
			const resultButton = result.container.querySelector('button') as HTMLButtonElement;
			expect(resultButton).toBeTruthy();

			// SDKResultMessage's collapsed header uses `px-3 py-2` + a `text-xs`
			// inner container. SpaceSystemInitCard must match.
			expect(initButton.className).toContain('px-3');
			expect(initButton.className).toContain('py-2');
			expect(resultButton.className).toContain('px-3');
			expect(resultButton.className).toContain('py-2');

			// Both cards should have a text-xs container with the row
			// contents so the inner line-height matches.
			const initInner = initButton.querySelector('.text-xs');
			const resultInner = resultButton.querySelector('.text-xs');
			expect(initInner).toBeTruthy();
			expect(resultInner).toBeTruthy();
		});

		it('does NOT use the legacy small paddings/text sizes', () => {
			const { getByTestId } = render(<SpaceSystemInitCard message={makeInitMessage()} />);
			const toggle = getByTestId('compact-system-init-toggle') as HTMLButtonElement;
			// Regression guards for the previous hand-tuned sizes that
			// produced a visibly shorter card than SDKResultMessage.
			expect(toggle.className).not.toContain('px-2.5');
			expect(toggle.className).not.toContain('py-1.5');
			expect(toggle.innerHTML).not.toContain('text-[11px]');
			expect(toggle.innerHTML).not.toContain('text-[10px]');
		});
	});

	describe('expanded state', () => {
		it('reveals details when toggled', () => {
			const { getByTestId, container } = render(
				<SpaceSystemInitCard message={makeInitMessage()} />
			);
			const toggle = getByTestId('compact-system-init-toggle');
			fireEvent.click(toggle);
			expect(container.querySelector('[data-testid="compact-system-init-details"]')).toBeTruthy();
			expect(container.textContent).toContain('/workspace');
		});
	});

	describe('model/permissionMode rendering', () => {
		it('strips the claude- prefix and shows permissionMode', () => {
			const { container } = render(
				<SpaceSystemInitCard
					message={makeInitMessage({ model: 'claude-opus-4-7', permissionMode: 'plan' })}
				/>
			);
			expect(container.textContent).toContain('opus-4-7');
			expect(container.textContent).toContain('plan');
		});

		it('falls back to "unknown model" when model is missing', () => {
			const { container } = render(
				<SpaceSystemInitCard message={makeInitMessage({ model: undefined })} />
			);
			expect(container.textContent).toContain('unknown model');
		});
	});
});
