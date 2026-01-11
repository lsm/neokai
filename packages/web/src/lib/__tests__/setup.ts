/**
 * Test setup for DOM environment
 */
// @ts-nocheck - Happy-dom types don't perfectly match browser globals, but work fine for tests
import { Window } from 'happy-dom';

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
