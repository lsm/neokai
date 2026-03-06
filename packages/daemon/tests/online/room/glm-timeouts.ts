/**
 * GLM provider timeout constants
 *
 * GLM models are significantly slower than Claude models for complex planning and coding tasks.
 * These constants provide GLM-aware timeout values that scale appropriately.
 */

// Check if we're running with GLM provider
export const isGlmProvider = process.env.DEFAULT_PROVIDER === 'glm';

// Planning timeout: GLM needs 7 minutes, Claude needs 5 minutes
export const PLANNING_TIMEOUT = isGlmProvider ? 420_000 : 300_000;

// Coding timeout: GLM needs 10 minutes, Claude needs 7 minutes
export const CODING_TIMEOUT = isGlmProvider ? 600_000 : 420_000;

// Approval timeout: GLM needs 3 minutes, Claude needs 2 minutes
export const APPROVAL_TIMEOUT = isGlmProvider ? 180_000 : 120_000;
