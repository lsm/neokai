/**
 * Shared test session configuration
 *
 * Provides a consistent session config across all online tests to:
 * - Reduce prompt tokens sent to SDK (tools config is pre-defined)
 * - Ensure consistent test behavior across test suites
 * - Make test configuration easier to maintain in one place
 *
 * Usage:
 * ```ts
 * import { getTestSessionConfig } from '../../helpers/test-session-config';
 *
 * const sessionId = await ctx.sessionManager.createSession({
 *     workspacePath: process.cwd(),
 *     config: getTestSessionConfig(),
 * });
 * ```
 */

import type { SessionConfig } from '@liuboer/shared';

/**
 * Standard test session configuration for online tests
 *
 * Key settings:
 * - model: 'haiku' - Provider-agnostic, maps to glm-4.5-air with GLM_API_KEY
 * - permissionMode: 'acceptEdits' - Explicitly set for CI (bypassPermissions fails on root)
 * - tools: Minimal config to reduce prompt tokens sent to SDK
 */
export function getTestSessionConfig(): Partial<SessionConfig> {
	return {
		model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
		permissionMode: 'acceptEdits', // Explicitly set for CI (bypass permissions fails on root)
		tools: {
			useClaudeCodePreset: false,
			liuboerTools: {},
			settingSources: [],
		},
	};
}
