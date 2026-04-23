/**
 * Pure logic utilities for ToolsModal.
 *
 * Extracted so both the component and unit tests import the same functions,
 * ensuring tests cover actual component logic rather than re-implementations.
 *
 * NOTE: Legacy per-server disabled-list helpers (`isServerEnabled`,
 * `toggleServer`, `toggleGroupServers`, `computeGroupState`) and the
 * `resolveSettingSources` helper were removed in M5. MCP enablement now flows
 * through the unified `app_mcp_servers` registry + `mcp_enablement` overrides
 * table; setting sources are no longer surfaced in the per-session UI because
 * the SDK is locked to `settingSources: []`.
 */

/**
 * Compute group-level toggle state for a list of app-level skills.
 * Returns `allEnabled: false` and `someEnabled: false` when the list is empty
 * to avoid vacuous-truth `[].every()` returning `true`.
 */
export function computeSkillGroupState(skills: { enabled: boolean }[]): {
	allEnabled: boolean;
	someEnabled: boolean;
	isIndeterminate: boolean;
} {
	if (skills.length === 0) {
		return { allEnabled: false, someEnabled: false, isIndeterminate: false };
	}
	const allEnabled = skills.every((s) => s.enabled);
	const someEnabled = skills.some((s) => s.enabled);
	return { allEnabled, someEnabled, isIndeterminate: someEnabled && !allEnabled };
}
