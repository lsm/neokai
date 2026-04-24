// The chat scroll container extends behind the floating composer so the
// glassmorphism effect reads correctly. For auto-scroll (and any browser-driven
// scrollIntoView) to leave the last message fully visible *above* the composer
// — not hidden behind it — we must:
//
//   1. Keep enough `padding-bottom` at the end of the messages list that the
//      last message can be pushed above the composer without the scroller
//      running out of content room.
//   2. Mirror the same value as `scroll-padding-bottom` on the container so
//      `scrollIntoView({ block: 'end' })` aligns below the composer instead of
//      under it.
//
// Bottom padding is derived from the live footer height plus a small clearance
// buffer, so both multiline composer growth and queue overlay rows keep the
// newest message visible. `MIN` / `MAX` clamp the result to reasonable values.

export const MIN_MESSAGES_BOTTOM_PADDING_PX = 128;
export const MAX_MESSAGES_BOTTOM_PADDING_PX = 320;
/** Breathing room between the bottom edge of the last message and the composer. */
const COMPOSER_CLEARANCE_PX = 16;
const QUEUE_OVERLAY_ROW_HEADROOM_PX = 4;
const MAX_QUEUE_OVERLAY_ROWS = 8;

export function getMessagesBottomPaddingPx(
	footerHeightPx: number,
	queueOverlayRows: number = 0
): number {
	if (!Number.isFinite(footerHeightPx) || footerHeightPx <= 0) {
		return MIN_MESSAGES_BOTTOM_PADDING_PX;
	}

	const normalizedQueueRows =
		Number.isFinite(queueOverlayRows) && queueOverlayRows > 0
			? Math.min(MAX_QUEUE_OVERLAY_ROWS, Math.floor(queueOverlayRows))
			: 0;
	const queueHeadroomPx = normalizedQueueRows * QUEUE_OVERLAY_ROW_HEADROOM_PX;

	const normalizedFooterHeightPx = Math.ceil(footerHeightPx);
	// Ensure the last message fully clears the composer: padding must cover the
	// composer's height plus a small clearance buffer. Below the MIN, clamp up.
	const computedPaddingPx = normalizedFooterHeightPx + COMPOSER_CLEARANCE_PX + queueHeadroomPx;
	return Math.min(
		MAX_MESSAGES_BOTTOM_PADDING_PX,
		Math.max(MIN_MESSAGES_BOTTOM_PADDING_PX, computedPaddingPx)
	);
}
