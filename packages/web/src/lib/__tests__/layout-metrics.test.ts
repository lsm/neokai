import { describe, expect, it } from 'vitest';
import {
	getMessagesBottomPaddingPx,
	MAX_MESSAGES_BOTTOM_PADDING_PX,
	MIN_MESSAGES_BOTTOM_PADDING_PX,
} from '../layout-metrics';

describe('layout-metrics', () => {
	it('allows the last message to reach the floating composer for normal footer heights', () => {
		expect(getMessagesBottomPaddingPx(48)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
		expect(getMessagesBottomPaddingPx(110)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
	});

	it('grows padding when the composer expands to multiple lines', () => {
		expect(getMessagesBottomPaddingPx(134)).toBe(118);
		expect(getMessagesBottomPaddingPx(158)).toBe(142);
	});

	it('adds queue-overlay headroom rows', () => {
		expect(getMessagesBottomPaddingPx(158, 3)).toBe(154);
	});

	it('caps queue-overlay headroom rows', () => {
		expect(getMessagesBottomPaddingPx(158, 99)).toBe(174);
	});

	it('caps very tall footer padding at the hard maximum', () => {
		expect(getMessagesBottomPaddingPx(900, 99)).toBe(MAX_MESSAGES_BOTTOM_PADDING_PX);
	});

	it('falls back to minimum for invalid heights', () => {
		expect(getMessagesBottomPaddingPx(Number.NaN)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
		expect(getMessagesBottomPaddingPx(0)).toBe(MIN_MESSAGES_BOTTOM_PADDING_PX);
	});
});
