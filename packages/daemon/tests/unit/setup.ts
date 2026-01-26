/**
 * Unit Test Setup
 *
 * This file is preloaded before unit tests run.
 * It clears API keys to ensure tests don't accidentally make real API calls.
 */

// Clear all API keys to ensure unit tests don't make real API calls
// Use delete rather than empty strings so that tests expecting undefined work correctly
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.GLM_API_KEY;
delete process.env.ZHIPU_API_KEY;

// Set test environment
process.env.NODE_ENV = 'test';
