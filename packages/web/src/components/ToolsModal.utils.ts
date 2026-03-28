/**
 * Pure logic utilities for ToolsModal.
 *
 * Extracted so both the component and unit tests import the same functions,
 * ensuring tests cover actual component logic rather than re-implementations.
 */

/** Returns true when the server is NOT in the disabled list. */
export function isServerEnabled(disabledMcpServers: string[], serverName: string): boolean {
	return !disabledMcpServers.includes(serverName);
}

/** Toggle a single server: remove from disabled list if present, add if absent. */
export function toggleServer(disabledMcpServers: string[], serverName: string): string[] {
	if (disabledMcpServers.includes(serverName)) {
		return disabledMcpServers.filter((s) => s !== serverName);
	}
	return [...disabledMcpServers, serverName];
}

/**
 * Group toggle: if ALL servers are currently enabled, disable all of them.
 * Otherwise enable all (remove from disabled list).
 * Servers not in serverNames are unaffected.
 */
export function toggleGroupServers(disabledMcpServers: string[], serverNames: string[]): string[] {
	const allOn = serverNames.every((name) => isServerEnabled(disabledMcpServers, name));
	if (allOn) {
		const toDisable = serverNames.filter((n) => !disabledMcpServers.includes(n));
		return [...disabledMcpServers, ...toDisable];
	}
	const names = new Set(serverNames);
	return disabledMcpServers.filter((n) => !names.has(n));
}

/**
 * Compute group-level toggle state for a set of servers.
 * Returns `allEnabled: false` and `someEnabled: false` when the list is empty
 * to avoid vacuous-truth `[].every()` returning `true`.
 */
export function computeGroupState(
	disabledMcpServers: string[],
	serverNames: string[]
): { allEnabled: boolean; someEnabled: boolean; isIndeterminate: boolean } {
	if (serverNames.length === 0) {
		return { allEnabled: false, someEnabled: false, isIndeterminate: false };
	}
	const allEnabled = serverNames.every((name) => isServerEnabled(disabledMcpServers, name));
	const someEnabled = serverNames.some((name) => isServerEnabled(disabledMcpServers, name));
	return { allEnabled, someEnabled, isIndeterminate: someEnabled && !allEnabled };
}

/**
 * Compute group-level toggle state for a list of app-level skills.
 * Returns `allEnabled: false` and `someEnabled: false` when the list is empty.
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

/**
 * Resolve the setting sources from a tools config object.
 * Handles both the new `settingSources` field and the legacy `loadSettingSources` flag.
 */
export function resolveSettingSources(tools?: {
	settingSources?: string[];
	loadSettingSources?: boolean;
}): string[] {
	if (tools?.settingSources) {
		return tools.settingSources;
	}
	if (tools?.loadSettingSources === false) {
		return [];
	}
	return ['user', 'project', 'local'];
}
