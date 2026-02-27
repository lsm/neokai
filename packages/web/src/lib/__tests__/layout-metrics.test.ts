import { describe, expect, it } from 'vitest';
import { getMessagesBottomPaddingPx, MIN_MESSAGES_BOTTOM_PADDING_PX } from '../layout-metrics';

describe('layout-metrics', () => {
	it('keeps a safe minimum padding for normal footer heights', () => {
		expect(getMessagesBottomPaddingPx(48)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
	});

	it('grows padding when footer becomes tall', () => {
		expect(getMessagesBottomPaddingPx(220)).toBe(244);
	});

	it('adds queue-overlay headroom rows', () => {
		expect(getMessagesBottomPaddingPx(220, 3)).toBe(256);
	});

	it('caps queue-overlay headroom rows', () => {
		expect(getMessagesBottomPaddingPx(220, 99)).toBe(276);
	});

	it('falls back to minimum for invalid heights', () => {
		expect(getMessagesBottomPaddingPx(Number.NaN)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
		expect(getMessagesBottomPaddingPx(0)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
	});
});
