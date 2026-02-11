/**
 * Unit Test Setup
 *
 * This file is preloaded before unit tests run.
 * It clears API keys to ensure tests don't accidentally make real API calls.
 */

import { configureLogger, LogLevel } from '@neokai/shared';

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

// Explicitly configure logger to SILENT to suppress all console output during tests
// This prevents test error logs from cluttering the output
configureLogger({ level: LogLevel.SILENT });

// Suppress console.error, console.warn, and console.log during tests
// to prevent intentional test errors from cluttering output
// Store originals in case tests need to restore them
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

console.error = () => {};
console.warn = () => {};
console.log = () => {};

// Export originals for tests that need to restore console output
(globalThis as unknown as Record<string, unknown>).__originalConsole = {
	error: originalConsoleError,
	warn: originalConsoleWarn,
	log: originalConsoleLog,
};

// Clear all API keys to ensure unit tests don't make real API calls
// Use delete rather than empty strings so that tests expecting undefined work correctly
process.env.ANTHROPIC_API_KEY = '';
process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
process.env.GLM_API_KEY = '';
process.env.ZHIPU_API_KEY = '';
