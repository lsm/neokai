// @ts-nocheck
/**
 * Setup Happy-DOM for SDK tool component tests
 *
 * IMPORTANT: This file does NOT use mock.module() to avoid polluting other tests.
 * Bun's mock.module() persists across test files in the same run.
 */

import { Window } from 'happy-dom';

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
