// Allow the last message to slide under the floating input pill instead of
// stopping above the whole footer stack. The footer still expands the padding
// when it grows tall (multiline composer, queue overlays, etc.).
export const MIN_MESSAGES_BOTTOM_PADDING_PX = 96;
export const MAX_MESSAGES_BOTTOM_PADDING_PX = 256;
const FLOATING_FOOTER_BASELINE_HEIGHT_PX = 112;
const FOOTER_GROWTH_TO_PADDING_RATIO = 1;
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
	const footerGrowthPx = Math.max(0, normalizedFooterHeightPx - FLOATING_FOOTER_BASELINE_HEIGHT_PX);
	const computedPaddingPx =
		MIN_MESSAGES_BOTTOM_PADDING_PX +
		Math.ceil(footerGrowthPx * FOOTER_GROWTH_TO_PADDING_RATIO) +
		queueHeadroomPx;
	return Math.min(
		MAX_MESSAGES_BOTTOM_PADDING_PX,
		Math.max(MIN_MESSAGES_BOTTOM_PADDING_PX, computedPaddingPx)
	);
}
