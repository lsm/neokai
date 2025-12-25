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
