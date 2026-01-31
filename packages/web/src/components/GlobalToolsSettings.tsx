/**
 * Global Tools Settings Component
 *
 * Two-stage control for tools:
 * - First stage: Is the tool allowed or not (permission)
 * - Second stage: Is the tool default ON for new sessions
 *
 * This applies globally to all sessions, not per-session.
 *
 * SDK Terms Reference:
 * - systemPrompt: { type: 'preset', preset: 'claude_code' } - The Claude Code system prompt
 * - settingSources: ['project', 'local', 'user'] - Which config files to load
 */

import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { borderColors } from '../lib/design-tokens.ts';
import type { GlobalToolsConfig } from '@neokai/shared';

const DEFAULT_CONFIG: GlobalToolsConfig = {
	systemPrompt: {
		claudeCodePreset: {
			allowed: true,
			defaultEnabled: true,
		},
	},
	settingSources: {
		project: {
			allowed: true,
			defaultEnabled: true,
		},
	},
	mcp: {
		allowProjectMcp: true,
		defaultProjectMcp: false,
	},
	kaiTools: {
		memory: {
			allowed: true,
			defaultEnabled: false,
		},
	},
};

export function GlobalToolsSettings() {
	const loading = useSignal(true);
	const saving = useSignal(false);
	const config = useSignal<GlobalToolsConfig>(DEFAULT_CONFIG);

	useEffect(() => {
		loadConfig();
	}, []);

	const loadConfig = async () => {
		try {
			loading.value = true;
			const hub = await connectionManager.getHub();
			const response = await hub.call<{ config: GlobalToolsConfig }>('globalTools.getConfig');
			config.value = response.config ?? DEFAULT_CONFIG;
		} catch (error) {
			console.error('Failed to load global tools config:', error);
			config.value = DEFAULT_CONFIG;
		} finally {
			loading.value = false;
		}
	};

	const saveConfig = async (newConfig: GlobalToolsConfig) => {
		try {
			saving.value = true;
			const hub = await connectionManager.getHub();
			await hub.call('globalTools.saveConfig', { config: newConfig });
			config.value = newConfig;
			toast.success('Global tools settings saved');
		} catch (error) {
			console.error('Failed to save global tools config:', error);
			toast.error('Failed to save global tools settings');
		} finally {
			saving.value = false;
		}
	};

	const updateSystemPromptConfig = (key: 'allowed' | 'defaultEnabled', value: boolean) => {
		const newConfig = {
			...config.value,
			systemPrompt: {
				...(config.value.systemPrompt ?? DEFAULT_CONFIG.systemPrompt),
				claudeCodePreset: {
					...(config.value.systemPrompt?.claudeCodePreset ??
						DEFAULT_CONFIG.systemPrompt.claudeCodePreset),
					[key]: value,
				},
			},
		};
		// If disabling permission, also disable default
		if (key === 'allowed' && !value) {
			newConfig.systemPrompt.claudeCodePreset.defaultEnabled = false;
		}
		saveConfig(newConfig);
	};

	if (loading.value) {
		return (
			<div class="text-center py-4">
				<div class="text-gray-400">Loading tools settings...</div>
			</div>
		);
	}

	return (
		<div class="space-y-4">
			<div class={`bg-dark-800 rounded-lg p-4 border ${borderColors.ui.secondary}`}>
				<h3 class="text-sm font-medium text-gray-300 mb-3">Global Tools Settings</h3>
				<p class="text-xs text-gray-400 mb-4">
					Configure which tools are allowed and their defaults for new sessions. Changes apply to
					new sessions only.
				</p>

				{/* System Prompt Section */}
				<div class="mb-6">
					<h4 class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
						System Prompt
					</h4>

					<div class="space-y-3">
						{/* Claude Code Preset */}
						<div class="flex items-center justify-between p-3 rounded-lg bg-dark-700/50">
							<div class="flex items-center gap-3">
								<svg
									class="w-5 h-5 text-blue-400"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
									/>
								</svg>
								<div>
									<div class="text-sm text-gray-200">Claude Code Preset</div>
									<div class="text-xs text-gray-500">
										Use official Claude Code system prompt with tools
									</div>
								</div>
							</div>
							<div class="flex items-center gap-4">
								<label class="flex items-center gap-2 cursor-pointer">
									<span class="text-xs text-gray-400">Allowed</span>
									<input
										type="checkbox"
										checked={config.value.systemPrompt?.claudeCodePreset?.allowed ?? true}
										onChange={(e) =>
											updateSystemPromptConfig('allowed', (e.target as HTMLInputElement).checked)
										}
										disabled={saving.value}
										class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
									/>
								</label>
								<label
									class={`flex items-center gap-2 ${config.value.systemPrompt?.claudeCodePreset?.allowed ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
								>
									<span class="text-xs text-gray-400">Default ON</span>
									<input
										type="checkbox"
										checked={config.value.systemPrompt?.claudeCodePreset?.defaultEnabled ?? true}
										onChange={(e) =>
											updateSystemPromptConfig(
												'defaultEnabled',
												(e.target as HTMLInputElement).checked
											)
										}
										disabled={saving.value || !config.value.systemPrompt?.claudeCodePreset?.allowed}
										class="w-4 h-4 rounded border-gray-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900"
									/>
								</label>
							</div>
						</div>
					</div>
				</div>

				{/* SDK Built-in Tools Info (read-only) */}
				<div>
					<h4 class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
						Claude Agent SDK Built-in
					</h4>
					<p class="text-xs text-gray-500 mb-3">
						These tools are provided by Claude Agent SDK and always available.
					</p>

					<div class="space-y-2 opacity-70">
						{/* Tools list */}
						<div class="flex items-center gap-3 p-2 rounded-lg bg-dark-700/30">
							<svg
								class="w-4 h-4 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
								/>
							</svg>
							<span class="text-xs text-gray-400">Read, Write, Edit, Glob, Grep, Bash, NotebookEdit, TodoWrite</span>
						</div>
						{/* Slash Commands */}
						<div class="flex items-center gap-3 p-2 rounded-lg bg-dark-700/30">
							<svg
								class="w-4 h-4 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
								/>
							</svg>
							<span class="text-xs text-gray-400">/help, /context, /clear, /config, /bug</span>
						</div>
						{/* Sub-agents */}
						<div class="flex items-center gap-3 p-2 rounded-lg bg-dark-700/30">
							<svg
								class="w-4 h-4 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
								/>
							</svg>
							<span class="text-xs text-gray-400">
								Task agents (general-purpose, Explore, Plan, Bash)
							</span>
						</div>
						{/* Web tools */}
						<div class="flex items-center gap-3 p-2 rounded-lg bg-dark-700/30">
							<svg
								class="w-4 h-4 text-gray-500"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"
								/>
							</svg>
							<span class="text-xs text-gray-400">WebSearch, WebFetch</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
