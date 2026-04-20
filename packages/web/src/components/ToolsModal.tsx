/**
 * Tools Modal Component (Redesigned)
 *
 * Unified view of all available MCP servers and tools:
 * - App Skills & MCP Servers: from skills registry (global scope – affects all sessions)
 * - Project MCP Servers: from settings files (session scope – affects this session)
 * - Advanced: Claude Code Preset & Settings Sources (hidden by default)
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
	SettingSource,
	AppSkill,
} from '@neokai/shared';
import {
	listMcpServersFromSources,
	type McpServerFromSource,
	type McpServersFromSourcesResponse,
} from '../lib/api-helpers.ts';
import { skillsStore } from '../lib/skills-store.ts';
import {
	isServerEnabled,
	toggleServer as toggleServerUtil,
	toggleGroupServers,
	computeGroupState,
	computeSkillGroupState,
	resolveSettingSources,
} from './ToolsModal.utils.ts';

interface ToolsModalProps {
	isOpen: boolean;
	onClose: () => void;
	session: Session | null;
}

// Source label mapping
const SOURCE_LABELS: Record<SettingSource, string> = {
	user: 'User (~/.claude/)',
	project: 'Project (.claude/)',
	local: 'Local (.claude/settings.local.json)',
};

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
	const mcpLoading = useSignal(true);
	const mcpServersData = useSignal<McpServersFromSourcesResponse | null>(null);
	const globalConfig = useSignal<GlobalToolsConfig | null>(null);

	// Collapsible group state (open by default)
	const appMcpGroupOpen = useSignal(true);
	const fileMcpGroupOpen = useSignal(true);
	const advancedOpen = useSignal(false);

	// Search filter for App Skills section
	const appSkillSearch = useSignal('');

	// Per-skill loading state for immediate toggles
	const skillToggling = useSignal<Set<string>>(new Set());

	// Session-local config state
	const disabledMcpServers = useSignal<string[]>([]);

	// Advanced settings (hidden by default)
	const useClaudeCodePreset = useSignal(true);
	const settingSources = useSignal<SettingSource[]>(['user', 'project', 'local']);

	// Load current config and MCP servers when modal opens
	useEffect(() => {
		if (isOpen && session) {
			loadConfig();
			loadGlobalConfig();
			void skillsStore.subscribe().catch(() => {
				toast.error('Failed to load App MCP Servers');
			});
		}
		return () => {
			skillsStore.unsubscribe();
		};
	}, [isOpen, session?.id]);

	// Reload MCP servers when setting sources change
	useEffect(() => {
		if (isOpen) {
			loadMcpServers();
		}
	}, [isOpen, settingSources.value]);

	const loadConfig = () => {
		if (!session) return;
		const tools = session.config.tools;
		useClaudeCodePreset.value = tools?.useClaudeCodePreset ?? true;
		settingSources.value = resolveSettingSources(tools) as SettingSource[];
		disabledMcpServers.value = tools?.disabledMcpServers ?? [];
		hasChanges.value = false;
	};

	const loadMcpServers = async () => {
		if (!session) return;
		try {
			mcpLoading.value = true;
			const response = await listMcpServersFromSources(session.id);
			mcpServersData.value = response;
		} catch {
			mcpServersData.value = null;
		} finally {
			mcpLoading.value = false;
		}
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

	const isMcpAllowed = useComputed(() => globalConfig.value?.mcp?.allowProjectMcp ?? true);
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

	// File-based MCP server helpers
	const handleToggleServer = (serverName: string) => {
		disabledMcpServers.value = toggleServerUtil(disabledMcpServers.value, serverName);
		hasChanges.value = true;
	};

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

	// Group toggle for file-based servers by source
	const toggleFileMcpGroup = (source: SettingSource) => {
		const servers = mcpServersData.value?.servers[source] ?? [];
		disabledMcpServers.value = toggleGroupServers(
			disabledMcpServers.value,
			servers.map((s) => s.name)
		);
		hasChanges.value = true;
	};

	// Group toggle for all file-based servers across all sources
	const toggleAllFileMcp = () => {
		const allServerNames = (['user', 'project', 'local'] as SettingSource[])
			.filter((src) => settingSources.value.includes(src))
			.flatMap((src) => (mcpServersData.value?.servers[src] ?? []).map((s) => s.name));
		disabledMcpServers.value = toggleGroupServers(disabledMcpServers.value, allServerNames);
		hasChanges.value = true;
	};

	const toggleSettingSource = (source: SettingSource, enabled: boolean) => {
		if (enabled) {
			if (!settingSources.value.includes(source)) {
				settingSources.value = [...settingSources.value, source];
			}
		} else {
			const newSources = settingSources.value.filter((s) => s !== source);
			if (newSources.length === 0) {
				toast.error('At least one setting source must be enabled');
				return;
			}
			settingSources.value = newSources;
		}
		hasChanges.value = true;
	};

	const handleSave = async () => {
		if (!session || !hasChanges.value) return;
		try {
			saving.value = true;
			const toolsConfig: ToolsConfig = {
				useClaudeCodePreset: useClaudeCodePreset.value,
				settingSources: settingSources.value,
				disabledMcpServers: disabledMcpServers.value,
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

	// Compute file-based server counts
	const enabledSources = (['user', 'project', 'local'] as SettingSource[]).filter((src) =>
		settingSources.value.includes(src)
	);
	const allFileMcpServers = enabledSources.flatMap(
		(src) => mcpServersData.value?.servers[src] ?? []
	);
	const allFileMcpServerNames = allFileMcpServers.map((s) => s.name);
	const { allEnabled: fileMcpAllOn, someEnabled: fileMcpSomeOn } = computeGroupState(
		disabledMcpServers.value,
		allFileMcpServerNames
	);

	// App MCP counts (based on all, not filtered)
	const appSkills = appMcpSkills.value;
	const visibleAppSkills = filteredAppSkills.value;
	const { allEnabled: appAllOn, someEnabled: appSomeOn } = computeSkillGroupState(appSkills);
	const anySkillToggling = appSkills.some((s) => skillToggling.value.has(s.id));

	return (
		<Modal isOpen={isOpen} onClose={handleCancel} title="Tools" size="md">
			<div class="space-y-4">
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
									{/* 2-column grid */}
									{visibleAppSkills.length === 0 ? (
										<div class="text-xs text-gray-600 py-1">
											No skills match &ldquo;{appSkillSearch.value}&rdquo;.
										</div>
									) : (
										<div class="grid grid-cols-2 gap-1">
											{visibleAppSkills.map((skill) => {
												const isToggling = skillToggling.value.has(skill.id);
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

				{/* File-based MCP Servers Section */}
				<div>
					{!isMcpAllowed.value ? (
						<div class="text-sm text-gray-500 py-2 italic">
							MCP servers are disabled in global settings.
						</div>
					) : mcpLoading.value ? (
						<div class="flex items-center gap-2 text-sm text-gray-400 py-2">
							<div class="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
							Loading servers...
						</div>
					) : (
						<>
							<GroupHeader
								title="Project MCP Servers"
								isOpen={fileMcpGroupOpen.value}
								onToggleOpen={() => {
									fileMcpGroupOpen.value = !fileMcpGroupOpen.value;
								}}
								allEnabled={fileMcpAllOn}
								someEnabled={fileMcpSomeOn}
								onToggleAll={toggleAllFileMcp}
								scope="session"
								itemCount={allFileMcpServers.length}
							/>
							{fileMcpGroupOpen.value && (
								<div class="mt-1 ml-5">
									{allFileMcpServers.length === 0 ? (
										<div class="text-xs text-gray-600 py-2">
											No MCP servers found in enabled setting sources.
										</div>
									) : (
										<div class="space-y-3">
											{enabledSources.map((source) => {
												const servers = mcpServersData.value?.servers[source] ?? [];
												if (servers.length === 0) return null;
												const { allEnabled: srcAllOn, someEnabled: srcSomeOn } = computeGroupState(
													disabledMcpServers.value,
													servers.map((s) => s.name)
												);
												return (
													<div key={source}>
														<div class="flex items-center justify-between mb-1">
															<span class="text-xs font-medium text-gray-500 uppercase tracking-wider">
																{SOURCE_LABELS[source]}
															</span>
															<label class="flex items-center gap-1.5 cursor-pointer text-xs text-gray-500">
																<input
																	type="checkbox"
																	checked={srcAllOn}
																	ref={(el) => {
																		if (el) el.indeterminate = srcSomeOn && !srcAllOn;
																	}}
																	onChange={() => toggleFileMcpGroup(source)}
																	class="w-3.5 h-3.5 rounded border-gray-600 text-blue-500"
																/>
															</label>
														</div>
														<div class="space-y-1">
															{servers.map((server: McpServerFromSource) => (
																<label
																	key={`${source}-${server.name}`}
																	class="flex items-center justify-between p-2 rounded-lg bg-dark-800/50 hover:bg-dark-800 transition-colors cursor-pointer"
																>
																	<div class="flex items-center gap-2 flex-1 min-w-0">
																		<svg
																			class="w-4 h-4 text-purple-400 flex-shrink-0"
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
																			<div class="text-sm text-gray-200 truncate">
																				{server.name}
																			</div>
																			{server.command && (
																				<div class="text-xs text-gray-500 truncate">
																					{server.command}
																				</div>
																			)}
																		</div>
																	</div>
																	<input
																		type="checkbox"
																		checked={isServerEnabled(disabledMcpServers.value, server.name)}
																		onChange={() => handleToggleServer(server.name)}
																		class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
																	/>
																</label>
															))}
														</div>
													</div>
												);
											})}
										</div>
									)}
								</div>
							)}
						</>
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

							{/* Setting Sources */}
							<div>
								<h4 class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
									Setting Sources
								</h4>
								<div class="space-y-1.5">
									{(['user', 'project', 'local'] as SettingSource[]).map((source) => {
										const isEnabled = settingSources.value.includes(source);
										return (
											<label
												key={source}
												class="flex items-center gap-3 p-2 rounded-lg bg-dark-800/50 hover:bg-dark-800 cursor-pointer"
											>
												<input
													type="checkbox"
													checked={isEnabled}
													onChange={(e) =>
														toggleSettingSource(source, (e.target as HTMLInputElement).checked)
													}
													class="w-4 h-4 rounded border-gray-600 bg-dark-900 text-blue-500"
												/>
												<div>
													<div class="text-sm text-gray-200">
														{source.charAt(0).toUpperCase() + source.slice(1)}
													</div>
													<div class="text-xs text-gray-500">{SOURCE_LABELS[source]}</div>
												</div>
											</label>
										);
									})}
								</div>
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
