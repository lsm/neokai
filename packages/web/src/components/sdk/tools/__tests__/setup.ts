/**
 * Setup Happy-DOM for SDK tool component tests
 */

import { Window } from 'happy-dom';
import { mock } from 'bun:test';

// Mock highlight.js before any components are imported
mock.module('highlight.js', () => ({
	default: {
		highlightAuto: (code: string) => ({ value: code, language: 'plaintext' }),
		highlight: (code: string, _opts: unknown) => ({ value: code }),
		getLanguage: () => true,
	},
}));

// Create a global window with Happy-DOM
const window = new Window({
	url: 'http://localhost:3000',
	settings: {
		disableJavaScriptFileLoading: true,
		disableJavaScriptEvaluation: false,
		disableCSSFileLoading: true,
		disableComputedStyleRendering: true,
	},
});

// Assign DOM globals
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	location: window.location,
	history: window.history,
	localStorage: window.localStorage,
	sessionStorage: window.sessionStorage,
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	DocumentFragment: window.DocumentFragment,
	Event: window.Event,
	CustomEvent: window.CustomEvent,
	MouseEvent: window.MouseEvent,
	KeyboardEvent: window.KeyboardEvent,
	MutationObserver: window.MutationObserver,
	requestAnimationFrame: window.requestAnimationFrame.bind(window),
	cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
});
