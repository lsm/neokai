/**
 * Tools Modal Component
 *
 * Unified view of MCP servers and tools for a session:
 * - Agent Runtime Tools: in-process MCPs attached at session-spawn time
 *   (space-agent-tools, db-query, task-agent, node-agent, etc.) — read-only.
 * - Session MCP Servers: per-session overrides of registry servers. Toggles
 *   write an `mcp_enablement` row at scope='session' so the override is
 *   applied on top of any room/space/registry defaults. Takes effect on the
 *   next session respawn (M6 of `unify-mcp-config-model`).
 * - App Skills & MCP Servers: from the unified skills registry, toggled
 *   globally (changes affect all sessions).
 * - Advanced: Claude Code preset toggle.
 */

import { useSignal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { Modal } from './ui/Modal.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import type {
	Session,
	ToolsConfig,
	GlobalToolsConfig,
	AppSkill,
	SessionMcpListResponse,
	SessionMcpServerEntry,
	McpEnablementSetOverrideResponse,
	McpEnablementClearOverrideResponse,
} from '@neokai/shared';
import { listRuntimeMcpServers } from '../lib/api-helpers.ts';
import { skillsStore } from '../lib/skills-store.ts';

/**
 * Human-friendly labels for runtime-attached (SDK-type) MCP servers.
 * Keys must match the names used in `SessionConfig.mcpServers` — i.e., the
 * names passed to `mergeRuntimeMcpServers` on the daemon side.
 *
 * Unknown names fall through to the raw server name so new runtime MCPs are
 * still surfaced even before a label is added.
 */
const RUNTIME_MCP_LABELS: Record<string, { title: string; description: string }> = {
	'space-agent-tools': {
		title: 'Space coordination',
		description: 'send_message_to_agent, list_peers, gate I/O, task management',
	},
	'db-query': {
		title: 'Database queries',
		description: 'Read-only SQLite access scoped to this space',
	},
	'task-agent': {
		title: 'Task agent',
		description: 'Workflow execution, node activation, sub-agent spawning',
	},
	'node-agent': {
		title: 'Node agent',
		description: 'Workflow node tools: peers, channels, gates',
	},
	'room-tools': {
		title: 'Room tools',
		description: 'Room-scoped coordination between co-located agents',
	},
};
import {
	computeMcpSkillRuntimeState,
	computeSkillGroupState,
	getMcpSkillRuntimeClasses,
} from './ToolsModal.utils.ts';

interface ToolsModalProps {
	isOpen: boolean;
	onClose: () => void;
	session: Session | null;
}

// Scope badge component
function ScopeBadge({ scope }: { scope: 'global' | 'session' }) {
	if (scope === 'global') {
		return <span class="text-xs text-amber-500/70 font-medium">All sessions</span>;
	}
	return <span class="text-xs text-sky-500/70 font-medium">This session</span>;
}

// Collapsible group header component
interface GroupHeaderProps {
	title: string;
	isOpen: boolean;
	onToggleOpen: () => void;
	allEnabled: boolean;
	someEnabled: boolean;
	onToggleAll: () => void;
	scope: 'global' | 'session';
	itemCount: number;
	disabled?: boolean;
}

function GroupHeader({
	title,
	isOpen,
	onToggleOpen,
	allEnabled,
	someEnabled,
	onToggleAll,
	scope,
	itemCount,
	disabled = false,
}: GroupHeaderProps) {
	const isIndeterminate = someEnabled && !allEnabled;

	return (
		<div class="flex items-center justify-between py-2 cursor-pointer select-none group">
			<button
				type="button"
				class="flex items-center gap-2 flex-1 text-left hover:text-gray-200 transition-colors"
				onClick={onToggleOpen}
				aria-expanded={isOpen}
			>
				<svg
					class={`w-3.5 h-3.5 text-gray-500 transition-transform ${isOpen ? 'rotate-90' : ''}`}
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M9 5l7 7-7 7" />
				</svg>
				<span class="text-sm font-medium text-gray-300">{title}</span>
				<span class="text-xs text-gray-600">({itemCount})</span>
			</button>
			<div class="flex items-center gap-3">
				<ScopeBadge scope={scope} />
				<label
					class="flex items-center gap-1.5 cursor-pointer"
					title={allEnabled ? 'Disable all' : 'Enable all'}
				>
					<span class="text-xs text-gray-500">
						{allEnabled ? 'All on' : someEnabled ? 'Mixed' : 'All off'}
					</span>
					<input
						type="checkbox"
						checked={allEnabled}
						ref={(el) => {
							if (el) el.indeterminate = isIndeterminate;
						}}
						onChange={onToggleAll}
						disabled={disabled}
						class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
					/>
				</label>
			</div>
		</div>
	);
}

export function ToolsModal({ isOpen, onClose, session }: ToolsModalProps) {
	const saving = useSignal(false);
	const hasChanges = useSignal(false);
	const globalConfig = useSignal<GlobalToolsConfig | null>(null);

	// Collapsible group state (open by default)
	const runtimeMcpGroupOpen = useSignal(true);
	const appMcpGroupOpen = useSignal(true);
	const advancedOpen = useSignal(false);

	// Runtime-attached (SDK-type) MCP servers for this session —
	// space-agent-tools, db-query, task-agent, node-agent, etc.
	const runtimeMcpServers = useSignal<string[]>([]);

	// Per-session MCP registry state (MCP M6).
	//
	// The daemon resolves session > room > space > registry precedence and
	// returns, for each registry entry, its effective enabled flag and which
	// scope owns that decision. Toggles write an `mcp_enablement` row at
	// scope='session' so it always wins over less-specific scopes; clearing
	// reverts to inheritance.
	const sessionMcpGroupOpen = useSignal(true);
	const sessionMcpEntries = useSignal<SessionMcpServerEntry[]>([]);
	const sessionMcpToggling = useSignal<Set<string>>(new Set());
	const sessionMcpSearch = useSignal('');
	// Tracks whether the per-session MCP list has been fetched at least once.
	// We can't use `sessionMcpEntries.length > 0` as a proxy because an empty
	// registry is a legitimate stable state — without this flag, runtime
	// indicators on `mcp_server` skills would flicker as "unknown" → "missing"
	// during the initial load.
	const sessionMcpLoaded = useSignal(false);

	// Search filter for App Skills section
	const appSkillSearch = useSignal('');

	// Per-skill loading state for immediate toggles
	const skillToggling = useSignal<Set<string>>(new Set());

	// Advanced settings (hidden by default)
	const useClaudeCodePreset = useSignal(true);

	// Load current config and MCP servers when modal opens
	useEffect(() => {
		if (isOpen && session) {
			loadConfig();
			loadGlobalConfig();
			loadRuntimeMcpServers();
			void loadSessionMcpEntries();
			void skillsStore.subscribe().catch(() => {
				toast.error('Failed to load App MCP Servers');
			});
		}
		return () => {
			skillsStore.unsubscribe();
		};
	}, [isOpen, session?.id]);

	const loadConfig = () => {
		if (!session) return;
		const tools = session.config.tools;
		useClaudeCodePreset.value = tools?.useClaudeCodePreset ?? true;
		hasChanges.value = false;
	};

	const loadGlobalConfig = async () => {
		try {
			const hub = await connectionManager.getHub();
			const response = await hub.request<{ config: GlobalToolsConfig }>('globalTools.getConfig');
			globalConfig.value = response.config;
		} catch {
			// Error loading global config
		}
	};

	const loadRuntimeMcpServers = async () => {
		if (!session) return;
		try {
			const response = await listRuntimeMcpServers(session.id);
			runtimeMcpServers.value = response.servers.map((s) => s.name);
		} catch {
			runtimeMcpServers.value = [];
		}
	};

	const loadSessionMcpEntries = async () => {
		if (!session) {
			sessionMcpEntries.value = [];
			sessionMcpLoaded.value = false;
			return;
		}
		try {
			const hub = await connectionManager.getHub();
			const response = await hub.request<SessionMcpListResponse>('session.mcp.list', {
				sessionId: session.id,
			});
			sessionMcpEntries.value = response.entries ?? [];
			sessionMcpLoaded.value = true;
		} catch {
			// Typically means the daemon rejected the session id; show nothing
			// rather than an error banner — the empty state is self-explanatory.
			sessionMcpEntries.value = [];
			// Keep sessionMcpLoaded=false: we genuinely don't know the effective
			// MCP state, so per-skill runtime indicators stay hidden ("unknown")
			// rather than risk showing a misleading "server missing" when the
			// backing data just wasn't retrieved.
			sessionMcpLoaded.value = false;
		}
	};

	/**
	 * Toggle the effective enablement of a single MCP server for this session.
	 *
	 * Precedence matters here: we always write an `mcp_enablement` row at
	 * scope='session' on toggle, because the alternative ("clear the override
	 * if new state matches the inherited state") leaks inheritance details
	 * into the UI — users who want a stable on/off for this session shouldn't
	 * have to care whether the room or space flipped underneath them later.
	 * The "Clear override" affordance (handleClearSessionMcpOverride) is the
	 * escape hatch for users who explicitly want to revert to inheritance.
	 */
	const toggleSessionMcp = async (entry: SessionMcpServerEntry) => {
		if (!session) return;
		const serverId = entry.server.id;
		const next = !entry.enabled;
		const toggling = new Set(sessionMcpToggling.value);
		toggling.add(serverId);
		sessionMcpToggling.value = toggling;
		try {
			const hub = await connectionManager.getHub();
			await hub.request<McpEnablementSetOverrideResponse>('mcp.enablement.setOverride', {
				scopeType: 'session',
				scopeId: session.id,
				serverId,
				enabled: next,
			});
			await loadSessionMcpEntries();
		} catch {
			toast.error(`Failed to toggle ${entry.server.name}`);
		} finally {
			const done = new Set(sessionMcpToggling.value);
			done.delete(serverId);
			sessionMcpToggling.value = done;
		}
	};

	/**
	 * Delete the session-scope override row for a server, reverting to the
	 * next most-specific scope (room → space → registry default). No-op when
	 * the effective decision isn't already a session override.
	 */
	const handleClearSessionMcpOverride = async (entry: SessionMcpServerEntry) => {
		if (!session) return;
		if (entry.source !== 'session') return;
		const serverId = entry.server.id;
		const toggling = new Set(sessionMcpToggling.value);
		toggling.add(serverId);
		sessionMcpToggling.value = toggling;
		try {
			const hub = await connectionManager.getHub();
			await hub.request<McpEnablementClearOverrideResponse>('mcp.enablement.clearOverride', {
				scopeType: 'session',
				scopeId: session.id,
				serverId,
			});
			await loadSessionMcpEntries();
		} catch {
			toast.error(`Failed to clear override for ${entry.server.name}`);
		} finally {
			const done = new Set(sessionMcpToggling.value);
			done.delete(serverId);
			sessionMcpToggling.value = done;
		}
	};

	const isClaudeCodePresetAllowed = useComputed(
		() => globalConfig.value?.systemPrompt?.claudeCodePreset?.allowed ?? true
	);

	// App-level MCP and builtin skills (all)
	const appMcpSkills = useComputed(() =>
		skillsStore.skills.value.filter(
			(s) => s.sourceType === 'mcp_server' || s.sourceType === 'builtin'
		)
	);

	// Filtered by search query
	const filteredAppSkills = useComputed(() => {
		const q = appSkillSearch.value.trim().toLowerCase();
		if (!q) return appMcpSkills.value;
		return appMcpSkills.value.filter(
			(s) =>
				s.displayName.toLowerCase().includes(q) ||
				(s.description?.toLowerCase().includes(q) ?? false)
		);
	});

	// Filtered session MCP entries (MCP M6).
	const filteredSessionMcpEntries = useComputed(() => {
		const q = sessionMcpSearch.value.trim().toLowerCase();
		if (!q) return sessionMcpEntries.value;
		return sessionMcpEntries.value.filter(
			(e) =>
				e.server.name.toLowerCase().includes(q) ||
				(e.server.description?.toLowerCase().includes(q) ?? false)
		);
	});

	// App-level skill toggle (immediate, global)
	const toggleSkill = async (skill: AppSkill) => {
		const toggling = new Set(skillToggling.value);
		toggling.add(skill.id);
		skillToggling.value = toggling;
		try {
			await skillsStore.setEnabled(skill.id, !skill.enabled);
		} catch {
			toast.error(`Failed to toggle ${skill.displayName}`);
		} finally {
			const done = new Set(skillToggling.value);
			done.delete(skill.id);
			skillToggling.value = done;
		}
	};

	// Group toggle for app-level skills
	const toggleAppMcpGroup = async () => {
		const skills = appMcpSkills.value;
		if (skills.length === 0) return;
		const allOn = skills.every((s) => s.enabled);
		const newEnabled = !allOn;
		const toToggle = skills.filter((s) => s.enabled !== newEnabled);

		// Mark all as toggling
		skillToggling.value = new Set([...skillToggling.value, ...toToggle.map((s) => s.id)]);

		await Promise.allSettled(
			toToggle.map((skill) =>
				skillsStore.setEnabled(skill.id, newEnabled).catch(() => {
					toast.error(`Failed to toggle ${skill.displayName}`);
				})
			)
		);

		// Clear toggling state for all
		const done = new Set(skillToggling.value);
		for (const skill of toToggle) done.delete(skill.id);
		skillToggling.value = done;
	};

	const handleSave = async () => {
		if (!session || !hasChanges.value) return;
		try {
			saving.value = true;
			const toolsConfig: ToolsConfig = {
				useClaudeCodePreset: useClaudeCodePreset.value,
			};
			const hub = await connectionManager.getHub();
			const result = await hub.request<{ success: boolean; error?: string }>('tools.save', {
				sessionId: session.id,
				tools: toolsConfig,
			});
			if (result.success) {
				hasChanges.value = false;
				toast.success('Tools configuration saved');
				onClose();
			} else {
				toast.error(result.error || 'Failed to save tools configuration');
			}
		} catch {
			toast.error('Failed to save tools configuration');
		} finally {
			saving.value = false;
		}
	};

	const handleCancel = () => {
		loadConfig();
		onClose();
	};

	if (!session) return null;

	// App MCP counts (based on all, not filtered)
	const appSkills = appMcpSkills.value;
	const visibleAppSkills = filteredAppSkills.value;
	const { allEnabled: appAllOn, someEnabled: appSomeOn } = computeSkillGroupState(appSkills);
	const anySkillToggling = appSkills.some((s) => skillToggling.value.has(s.id));

	return (
		<Modal isOpen={isOpen} onClose={handleCancel} title="Tools" size="md">
			<div class="space-y-4">
				{/* Agent Runtime Tools Section — shown only when the session has
				    runtime-attached SDK-type MCP servers (e.g. space sessions). */}
				{runtimeMcpServers.value.length > 0 && (
					<>
						<div>
							<div class="flex items-center justify-between py-2 select-none group">
								<button
									type="button"
									class="flex items-center gap-2 flex-1 text-left hover:text-gray-200 transition-colors"
									onClick={() => {
										runtimeMcpGroupOpen.value = !runtimeMcpGroupOpen.value;
									}}
									aria-expanded={runtimeMcpGroupOpen.value}
								>
									<svg
										class={`w-3.5 h-3.5 text-gray-500 transition-transform ${runtimeMcpGroupOpen.value ? 'rotate-90' : ''}`}
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M9 5l7 7-7 7"
										/>
									</svg>
									<span class="text-sm font-medium text-gray-300">Agent Runtime Tools</span>
									<span class="text-xs text-gray-600">({runtimeMcpServers.value.length})</span>
								</button>
								<span class="text-xs text-emerald-500/70 font-medium">Built-in</span>
							</div>
							{runtimeMcpGroupOpen.value && (
								<div class="mt-1 ml-5 space-y-1">
									{runtimeMcpServers.value.map((name) => {
										const label = RUNTIME_MCP_LABELS[name];
										return (
											<div
												key={`runtime-${name}`}
												class="flex items-center gap-2 p-2 rounded-lg bg-dark-800/50 min-w-0"
											>
												<svg
													class="w-3.5 h-3.5 text-emerald-400 flex-shrink-0"
													fill="none"
													viewBox="0 0 24 24"
													stroke="currentColor"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width={2}
														d="M13 10V3L4 14h7v7l9-11h-7z"
													/>
												</svg>
												<div class="flex-1 min-w-0">
													<div class="text-sm text-gray-200 truncate">{label?.title ?? name}</div>
													<div class="text-xs text-gray-500 truncate">
														{label?.description ?? name}
													</div>
												</div>
											</div>
										);
									})}
								</div>
							)}
						</div>
						<div class={`border-t ${borderColors.ui.secondary}`} />
					</>
				)}

				{/* Session MCP Servers (MCP M6) —
				    Per-session overrides of the app-level registry. Hidden when the
				    registry is empty so users aren't presented with a blank section
				    during initial setup. */}
				{sessionMcpEntries.value.length > 0 && (
					<>
						<div>
							<div class="flex items-center justify-between py-2 cursor-pointer select-none group">
								<button
									type="button"
									class="flex items-center gap-2 flex-1 text-left hover:text-gray-200 transition-colors"
									onClick={() => {
										sessionMcpGroupOpen.value = !sessionMcpGroupOpen.value;
									}}
									aria-expanded={sessionMcpGroupOpen.value}
								>
									<svg
										class={`w-3.5 h-3.5 text-gray-500 transition-transform ${sessionMcpGroupOpen.value ? 'rotate-90' : ''}`}
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M9 5l7 7-7 7"
										/>
									</svg>
									<span class="text-sm font-medium text-gray-300">Session MCP Servers</span>
									<span class="text-xs text-gray-600">({sessionMcpEntries.value.length})</span>
								</button>
								<ScopeBadge scope="session" />
							</div>
							{sessionMcpGroupOpen.value && (
								<div class="mt-2 ml-5 space-y-2">
									<div class="text-xs text-gray-500">
										Overrides apply to this session only. Changes take effect on the next respawn.
									</div>
									{sessionMcpEntries.value.length > 4 && (
										<input
											type="search"
											placeholder="Filter MCP servers…"
											value={sessionMcpSearch.value}
											onInput={(e) => {
												sessionMcpSearch.value = (e.target as HTMLInputElement).value;
											}}
											class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2.5 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
										/>
									)}
									{filteredSessionMcpEntries.value.length === 0 ? (
										<div class="text-xs text-gray-600 py-1">
											No servers match &ldquo;{sessionMcpSearch.value}&rdquo;.
										</div>
									) : (
										<div class="space-y-1">
											{filteredSessionMcpEntries.value.map((entry) => {
												const isToggling = sessionMcpToggling.value.has(entry.server.id);
												const sourceLabel =
													entry.source === 'session'
														? 'Session override'
														: entry.source === 'room'
															? 'Inherited from room'
															: entry.source === 'space'
																? 'Inherited from space'
																: 'Registry default';
												return (
													<div
														key={`session-mcp-${entry.server.id}`}
														class={`flex items-center gap-2 p-2 rounded-lg bg-dark-800/50 min-w-0 ${
															isToggling ? 'opacity-60' : ''
														}`}
													>
														<svg
															class="w-3.5 h-3.5 text-amber-400 flex-shrink-0"
															fill="none"
															viewBox="0 0 24 24"
															stroke="currentColor"
														>
															<path
																stroke-linecap="round"
																stroke-linejoin="round"
																stroke-width={2}
																d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2"
															/>
														</svg>
														<div class="flex-1 min-w-0">
															<div class="text-xs text-gray-200 truncate">{entry.server.name}</div>
															<div class="text-[10px] text-gray-500 truncate">{sourceLabel}</div>
														</div>
														<div class="flex items-center gap-2 flex-shrink-0">
															{entry.source === 'session' && (
																<button
																	type="button"
																	class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
																	title="Revert this session back to the inherited value"
																	onClick={() => void handleClearSessionMcpOverride(entry)}
																	disabled={isToggling}
																>
																	Clear
																</button>
															)}
															{isToggling && (
																<div class="w-2.5 h-2.5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
															)}
															<input
																type="checkbox"
																checked={entry.enabled}
																onChange={() => void toggleSessionMcp(entry)}
																disabled={isToggling}
																class="w-3.5 h-3.5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
															/>
														</div>
													</div>
												);
											})}
										</div>
									)}
								</div>
							)}
						</div>
						<div class={`border-t ${borderColors.ui.secondary}`} />
					</>
				)}

				{/* App Skills & MCP Servers Section */}
				<div>
					{appSkills.length > 0 ? (
						<>
							<GroupHeader
								title="App Skills & MCP Servers"
								isOpen={appMcpGroupOpen.value}
								onToggleOpen={() => {
									appMcpGroupOpen.value = !appMcpGroupOpen.value;
								}}
								allEnabled={appAllOn}
								someEnabled={appSomeOn}
								onToggleAll={toggleAppMcpGroup}
								scope="global"
								itemCount={appSkills.length}
								disabled={anySkillToggling}
							/>
							{appMcpGroupOpen.value && (
								<div class="mt-2 ml-5 space-y-2">
									{/* Search filter */}
									{appSkills.length > 4 && (
										<input
											type="search"
											placeholder="Filter skills…"
											value={appSkillSearch.value}
											onInput={(e) => {
												appSkillSearch.value = (e.target as HTMLInputElement).value;
											}}
											class="w-full text-xs bg-dark-900 border border-dark-700 rounded px-2.5 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-500/50"
										/>
									)}
									{/* 2-column grid.
									    Note: the checkbox reflects the registry toggle (global, all
									    sessions). For MCP-backed skills we also surface the runtime
									    effective state below each name so users can tell when an
									    "enabled" skill actually reaches this session. */}
									{visibleAppSkills.length === 0 ? (
										<div class="text-xs text-gray-600 py-1">
											No skills match &ldquo;{appSkillSearch.value}&rdquo;.
										</div>
									) : (
										<div class="grid grid-cols-2 gap-1">
											{visibleAppSkills.map((skill) => {
												const isToggling = skillToggling.value.has(skill.id);
												const runtime = computeMcpSkillRuntimeState(
													skill,
													sessionMcpEntries.value,
													sessionMcpLoaded.value
												);
												// Colour pair is derived from a pure util so the mapping is
												// unit-tested and stays consistent with the amber orphan-
												// warning in AppMcpServersSettings (see getMcpSkillRuntimeClasses).
												const { dot: runtimeDotClass, text: runtimeTextClass } =
													getMcpSkillRuntimeClasses(runtime.status);
												return (
													<label
														key={skill.id}
														class={`flex items-center gap-2 p-2 rounded-lg bg-dark-800/50 transition-colors min-w-0 ${
															isToggling ? 'opacity-60' : 'hover:bg-dark-800 cursor-pointer'
														}`}
													>
														{skill.sourceType === 'builtin' ? (
															<svg
																class="w-3.5 h-3.5 text-blue-400 flex-shrink-0"
																fill="none"
																viewBox="0 0 24 24"
																stroke="currentColor"
															>
																<path
																	stroke-linecap="round"
																	stroke-linejoin="round"
																	stroke-width={2}
																	d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
																/>
															</svg>
														) : (
															<svg
																class="w-3.5 h-3.5 text-amber-400 flex-shrink-0"
																fill="none"
																viewBox="0 0 24 24"
																stroke="currentColor"
															>
																<path
																	stroke-linecap="round"
																	stroke-linejoin="round"
																	stroke-width={2}
																	d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2"
																/>
															</svg>
														)}
														<div class="flex-1 min-w-0">
															<div class="text-xs text-gray-200 truncate">{skill.displayName}</div>
															{runtime.status !== 'unknown' && runtime.label && (
																<div
																	class={`text-[10px] truncate flex items-center gap-1 ${runtimeTextClass}`}
																	title={runtime.label}
																	data-testid={`skill-runtime-${skill.name}`}
																	data-status={runtime.status}
																>
																	<span
																		class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${runtimeDotClass}`}
																	/>
																	<span class="truncate">{runtime.label}</span>
																</div>
															)}
														</div>
														<div class="flex items-center gap-1 flex-shrink-0">
															{isToggling && (
																<div class="w-2.5 h-2.5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
															)}
															<input
																type="checkbox"
																checked={skill.enabled}
																onChange={() => void toggleSkill(skill)}
																disabled={isToggling}
																class="w-3.5 h-3.5 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
															/>
														</div>
													</label>
												);
											})}
										</div>
									)}
								</div>
							)}
						</>
					) : (
						<div class="flex items-center gap-2 py-1">
							<svg
								class="w-3.5 h-3.5 text-gray-600"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M9 5l7 7-7 7"
								/>
							</svg>
							<span class="text-sm font-medium text-gray-500">App Skills & MCP Servers</span>
							<span class="text-xs text-gray-700">(none configured)</span>
						</div>
					)}
				</div>

				<div class={`border-t ${borderColors.ui.secondary}`} />

				{/* Advanced Section (collapsed by default) */}
				<div>
					<button
						type="button"
						class="flex items-center gap-2 w-full text-left py-1 hover:text-gray-300 transition-colors"
						onClick={() => {
							advancedOpen.value = !advancedOpen.value;
						}}
						aria-expanded={advancedOpen.value}
					>
						<svg
							class={`w-3.5 h-3.5 text-gray-600 transition-transform ${advancedOpen.value ? 'rotate-90' : ''}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M9 5l7 7-7 7"
							/>
						</svg>
						<span class="text-sm font-medium text-gray-500">Advanced</span>
					</button>

					{advancedOpen.value && (
						<div class="mt-3 space-y-4 ml-5">
							{/* Claude Code Preset */}
							<div>
								<h4 class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
									System Prompt
								</h4>
								<label
									class={`flex items-center justify-between p-2 rounded-lg bg-dark-800/50 transition-colors ${isClaudeCodePresetAllowed.value ? 'hover:bg-dark-800 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
								>
									<div>
										<div class="text-sm text-gray-200">Claude Code Preset</div>
										<div class="text-xs text-gray-500">Use official Claude Code system prompt</div>
									</div>
									<input
										type="checkbox"
										checked={useClaudeCodePreset.value}
										onChange={() => {
											useClaudeCodePreset.value = !useClaudeCodePreset.value;
											hasChanges.value = true;
										}}
										disabled={!isClaudeCodePresetAllowed.value}
										class="w-4 h-4 rounded border-gray-600 text-blue-500"
									/>
								</label>
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div class={`pt-4 border-t ${borderColors.ui.secondary} flex gap-3 justify-end`}>
					<button
						type="button"
						onClick={handleCancel}
						class="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSave}
						disabled={!hasChanges.value || saving.value}
						class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
							hasChanges.value && !saving.value
								? 'bg-blue-500 text-white hover:bg-blue-600'
								: 'bg-dark-700 text-gray-500 cursor-not-allowed'
						}`}
					>
						{saving.value ? (
							<span class="flex items-center gap-2">
								<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
								Saving...
							</span>
						) : (
							'Save'
						)}
					</button>
				</div>
			</div>
		</Modal>
	);
}
