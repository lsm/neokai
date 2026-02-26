export const MIN_MESSAGES_BOTTOM_PADDING_PX = 128;
// Keep last message clear of the floating footer's gradient/focus glow.
const MESSAGES_BOTTOM_PADDING_BUFFER_PX = 24;
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

	return Math.max(
		MIN_MESSAGES_BOTTOM_PADDING_PX,
		Math.ceil(footerHeightPx) + MESSAGES_BOTTOM_PADDING_BUFFER_PX + queueHeadroomPx
	);
}
