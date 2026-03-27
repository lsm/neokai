/**
 * RoomSkillsSettings - Skills section for Room Settings panel
 *
 * Renders the list of global skills with per-room enable/disable toggles.
 * Built-in skills are shown but cannot be toggled (SDK manages them).
 */

import type { SkillSourceType } from '@neokai/shared';
import type { EffectiveRoomSkill } from '../../lib/room-store';
import type { UseRoomSkillsResult } from '../../hooks/useRoomSkills';
import { toast } from '../../lib/toast';

interface RoomSkillsSettingsProps {
	skills: EffectiveRoomSkill[];
	setOverride: UseRoomSkillsResult['setOverride'];
	clearOverride: UseRoomSkillsResult['clearOverride'];
	disabled?: boolean;
}

const SOURCE_TYPE_LABELS: Record<SkillSourceType, string> = {
	builtin: 'Built-in',
	plugin: 'Plugin',
	mcp_server: 'MCP Server',
};

const SOURCE_TYPE_BADGE_CLASSES: Record<SkillSourceType, string> = {
	builtin: 'bg-purple-900/40 text-purple-400',
	plugin: 'bg-green-900/40 text-green-400',
	mcp_server: 'bg-blue-900/40 text-blue-400',
};

/**
 * Groups skills by source type in display order: builtin → plugin → mcp_server.
 */
function groupBySourceType(
	skills: EffectiveRoomSkill[]
): Array<{ type: SkillSourceType; items: EffectiveRoomSkill[] }> {
	const order: SkillSourceType[] = ['builtin', 'plugin', 'mcp_server'];
	const map = new Map<SkillSourceType, EffectiveRoomSkill[]>();
	for (const skill of skills) {
		const group = map.get(skill.sourceType) ?? [];
		group.push(skill);
		map.set(skill.sourceType, group);
	}
	return order.filter((t) => map.has(t)).map((t) => ({ type: t, items: map.get(t)! }));
}

export function RoomSkillsSettings({
	skills,
	setOverride,
	clearOverride,
	disabled = false,
}: RoomSkillsSettingsProps) {
	if (skills.length === 0) {
		return (
			<div class="text-sm text-gray-500">
				No skills configured.{' '}
				<a
					href="#"
					onClick={(e) => {
						e.preventDefault();
					}}
					class="text-blue-400 hover:text-blue-300"
				>
					Add skills in Global Settings
				</a>
			</div>
		);
	}

	const groups = groupBySourceType(skills);

	return (
		<div class="space-y-4">
			{groups.map(({ type, items }) => (
				<div key={type}>
					<p class="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
						{SOURCE_TYPE_LABELS[type]}
					</p>
					<div class="space-y-2">
						{items.map((skill) => {
							const isBuiltin = skill.builtIn;
							const isToggleDisabled = disabled || isBuiltin;
							const checked = skill.enabled;

							return (
								<label
									key={skill.id}
									class={`flex items-start gap-3 bg-dark-800 border border-dark-600 rounded-lg px-3 py-2.5 transition-colors ${isBuiltin ? 'opacity-60 cursor-default' : 'cursor-pointer hover:border-dark-500'}`}
								>
									<input
										type="checkbox"
										checked={checked}
										onChange={async () => {
											if (isToggleDisabled) return;
											try {
												if (skill.overriddenByRoom) {
													// Already overridden — toggle to opposite of current
													await setOverride(skill.id, !checked);
												} else {
													// No room override yet — set one
													await setOverride(skill.id, !checked);
												}
											} catch {
												toast.error(
													`Failed to ${checked ? 'disable' : 'enable'} ${skill.displayName}`
												);
											}
										}}
										disabled={isToggleDisabled}
										class="w-4 h-4 mt-0.5 rounded border-dark-500 bg-dark-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-dark-900 cursor-pointer disabled:cursor-not-allowed"
									/>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2 flex-wrap">
											<span class="text-sm font-medium text-gray-200">{skill.displayName}</span>
											<span
												class={`text-xs px-1.5 py-0.5 rounded ${SOURCE_TYPE_BADGE_CLASSES[skill.sourceType]}`}
											>
												{SOURCE_TYPE_LABELS[skill.sourceType]}
											</span>
											{isBuiltin && (
												<span class="text-xs px-1.5 py-0.5 rounded bg-dark-700 text-gray-500">
													always on
												</span>
											)}
											{!isBuiltin && skill.overriddenByRoom && (
												<span class="text-xs px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400">
													room override
												</span>
											)}
											{!isBuiltin && !skill.overriddenByRoom && !skill.enabled && (
												<span class="text-xs px-1.5 py-0.5 rounded bg-dark-700 text-gray-500">
													disabled globally
												</span>
											)}
										</div>
										{skill.description && (
											<p class="text-xs text-gray-500 mt-0.5 truncate">{skill.description}</p>
										)}
									</div>
									{!isBuiltin && skill.overriddenByRoom && (
										<button
											type="button"
											onClick={async (e) => {
												e.preventDefault();
												if (disabled) return;
												try {
													await clearOverride(skill.id);
												} catch {
													toast.error(`Failed to clear override for ${skill.displayName}`);
												}
											}}
											disabled={disabled}
											class="text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40 mt-0.5 flex-shrink-0"
											title="Reset to global default"
										>
											Reset
										</button>
									)}
								</label>
							);
						})}
					</div>
				</div>
			))}
		</div>
	);
}
