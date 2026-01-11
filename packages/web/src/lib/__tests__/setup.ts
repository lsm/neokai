/**
 * Test setup for DOM environment
 */
// @ts-nocheck - Happy-dom types don't perfectly match browser globals, but work fine for tests
import { Window } from 'happy-dom';
import { mock } from 'bun:test';
import { signal } from '@preact/signals';

// Mock highlight.js globally
mock.module('highlight.js', () => ({
	default: {
		highlightAuto: (code: string) => ({ value: code, language: 'plaintext' }),
		highlight: (code: string, _opts: unknown) => ({ value: code }),
		getLanguage: () => true,
	},
}));

// Create shared signal for connection state
const connectionStateSignal = signal<string>('disconnected');

// Mock state module with actual signal
mock.module('../state', () => ({
	connectionState: connectionStateSignal,
	currentSession: signal(null),
	sessions: signal([]),
	error: signal(null),
}));

// Mock toast module
mock.module('../toast', () => ({
	toast: {
		success: mock(() => 'toast-id'),
		error: mock(() => 'toast-id'),
		info: mock(() => 'toast-id'),
		warning: mock(() => 'toast-id'),
	},
	toastsSignal: signal([]),
	dismissToast: mock(() => {}),
}));

// Create and register DOM globals
const window = new Window();
const document = window.document;

// Assign to global scope
global.window = window as unknown as Window & typeof globalThis;
global.document = document;
global.HTMLElement = window.HTMLElement;
global.customElements = window.customElements;
global.CustomEvent = window.CustomEvent;
global.Event = window.Event;
global.KeyboardEvent = window.KeyboardEvent;
global.MouseEvent = window.MouseEvent;
global.File = window.File;
global.FileList = window.FileList;
global.FileReader = window.FileReader;
global.Blob = window.Blob;
global.URL = window.URL;
global.ResizeObserver =
	window.ResizeObserver ||
	class MockResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
