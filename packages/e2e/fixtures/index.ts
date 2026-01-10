/**
 * Playwright Test Fixtures
 *
 * This module exports the test and expect functions that should be used
 * by all e2e tests. It provides:
 *
 * - Automatic V8 coverage collection when COVERAGE=true
 * - All standard Playwright test/expect functionality
 *
 * Usage in test files:
 *   // Instead of: import { test, expect } from '@playwright/test';
 *   import { test, expect } from '../fixtures';
 *
 * To run with coverage:
 *   bun run test:coverage
 */

export { test, expect, devices } from './coverage';
