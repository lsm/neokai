export function isTouchSafari(): boolean {
	if (typeof navigator === 'undefined') {
		return false;
	}

	const ua = navigator.userAgent;
	const hasTouch = navigator.maxTouchPoints > 0;
	const isSafariUA =
		ua.includes('Safari') &&
		!/(Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|YaBrowser)/.test(ua);

	return hasTouch && isSafariUA;
}
