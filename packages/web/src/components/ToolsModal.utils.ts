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

import type { AppSkill, SessionMcpServerEntry } from '@neokai/shared';

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

/**
 * The runtime state of an mcp_server-backed skill with respect to a specific
 * session. Used by the Tools modal to explain *why* a skill the user sees as
 * "enabled" may not actually be injected into the current query.
 *
 *   - `active`           — the backing MCP server is effectively enabled for
 *                          this session and the skill's enablement chain does
 *                          not block it. The SDK will see the tools at the
 *                          next `build()`.
 *   - `skill-disabled`   — the skill itself is off in the app-level registry,
 *                          so the skill bridge skips it regardless of MCP
 *                          overrides.
 *   - `server-off`       — the backing `app_mcp_servers` entry is disabled
 *                          (either by its registry default or by an explicit
 *                          `mcp_enablement` override along this session's
 *                          scope chain). `overrideSource` pinpoints which
 *                          scope owns the decision.
 *   - `server-missing`   — the skill's `appMcpServerId` points at an
 *                          `app_mcp_servers` row that no longer exists.
 *                          Orphaned skill — never reaches any session.
 *   - `unknown`          — we could not determine runtime state (e.g. the
 *                          session-MCP list hasn't loaded yet). Treated as
 *                          "no indicator shown" by callers.
 */
export type McpSkillRuntimeStatus =
	| 'active'
	| 'skill-disabled'
	| 'server-off'
	| 'server-missing'
	| 'unknown';

export interface McpSkillRuntimeState {
	status: McpSkillRuntimeStatus;
	/** The `app_mcp_servers.id` the skill points at, when known. */
	appMcpServerId?: string;
	/**
	 * Which level of the scope chain owns the `server-off` decision. Present
	 * only when `status === 'server-off'`; omitted for other statuses.
	 */
	overrideSource?: SessionMcpServerEntry['source'];
	/** Short label suitable for rendering under the skill name. */
	label: string;
}

/**
 * Compute the runtime state of a single skill relative to a session.
 *
 * For non-`mcp_server` skills (builtin / plugin) we return `status: 'unknown'`
 * because there is no analogous session-scope override path; the component
 * should render no indicator.
 *
 * @param skill            The app-level skill whose runtime state to compute.
 * @param sessionMcpList   The `SessionMcpListResponse.entries` payload for
 *                         the current session. When empty (not yet loaded or
 *                         no registry entries), we return `unknown` even for
 *                         `mcp_server` skills so the UI stays calm.
 * @param sessionMcpLoaded Explicit flag from the caller saying the list has
 *                         been populated at least once. Without this we can't
 *                         distinguish "no entries" (stable) from "not loaded
 *                         yet" (loading).
 */
export function computeMcpSkillRuntimeState(
	skill: AppSkill,
	sessionMcpList: SessionMcpServerEntry[],
	sessionMcpLoaded: boolean
): McpSkillRuntimeState {
	if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') {
		return { status: 'unknown', label: '' };
	}

	const appMcpServerId = skill.config.appMcpServerId;

	if (!sessionMcpLoaded) {
		return { status: 'unknown', appMcpServerId, label: '' };
	}

	// If the skill itself is off, the skill bridge never injects it regardless
	// of the backing server's enablement. Surface that first so users aren't
	// misled by a green "active" indicator when their own checkbox is off.
	if (!skill.enabled) {
		const entry = sessionMcpList.find((e) => e.server.id === appMcpServerId);
		if (!entry) {
			return {
				status: 'server-missing',
				appMcpServerId,
				label: 'No backing MCP server',
			};
		}
		return {
			status: 'skill-disabled',
			appMcpServerId,
			label: 'Skill off — not injected',
		};
	}

	const entry = sessionMcpList.find((e) => e.server.id === appMcpServerId);
	if (!entry) {
		return {
			status: 'server-missing',
			appMcpServerId,
			label: 'No backing MCP server',
		};
	}

	if (!entry.enabled) {
		const where =
			entry.source === 'session'
				? 'this session'
				: entry.source === 'room'
					? 'room'
					: entry.source === 'space'
						? 'space'
						: 'registry';
		return {
			status: 'server-off',
			appMcpServerId,
			overrideSource: entry.source,
			label: `MCP server disabled at ${where}`,
		};
	}

	return {
		status: 'active',
		appMcpServerId,
		label: 'Active in this session',
	};
}

/**
 * For each `app_mcp_servers` entry, look up the (single) skill that wraps it.
 * Skills are stored with `sourceType === 'mcp_server'` and
 * `config.appMcpServerId` pointing at an `app_mcp_servers.id`. Returns a map
 * keyed by server ID so the Global Settings MCP Servers page can render "this
 * server is exposed as skill X" in O(1) per row.
 *
 * When multiple skills point at the same server ID (pathological — seed +
 * user clone) we keep the first; the UI shouldn't encourage that topology.
 */
export function computeMcpServerSkillLinkage(skills: AppSkill[]): Map<string, AppSkill> {
	const map = new Map<string, AppSkill>();
	for (const skill of skills) {
		if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') continue;
		const serverId = skill.config.appMcpServerId;
		if (!serverId) continue;
		if (!map.has(serverId)) {
			map.set(serverId, skill);
		}
	}
	return map;
}
