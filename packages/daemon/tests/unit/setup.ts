/**
 * Unit Test Setup
 *
 * This file is preloaded before unit tests run.
 * It clears API keys to ensure tests don't accidentally make real API calls.
 */

// Clear all API keys to ensure unit tests don't make real API calls
// Use delete rather than empty strings so that tests expecting undefined work correctly
process.env.ANTHROPIC_API_KEY = "";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "";
process.env.GLM_API_KEY = "";
process.env.ZHIPU_API_KEY = "";
