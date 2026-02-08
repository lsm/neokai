/**
 * SettingOverrideBadge - Badge showing setting inheritance status
 *
 * Displays whether a setting is inherited from global settings,
 * overridden at session level, or custom.
 */

export type OverrideType = 'inherited' | 'overridden' | 'custom';

export interface SettingOverrideBadgeProps {
	type: OverrideType;
}

export function SettingOverrideBadge({ type }: SettingOverrideBadgeProps) {
	const config = {
		inherited: {
			label: 'Inherited',
			className: 'border-gray-500/20 bg-gray-500/10 text-gray-400',
		},
		overridden: {
			label: 'Overridden',
			className: 'border-blue-500/20 bg-blue-500/10 text-blue-400',
		},
		custom: {
			label: 'Custom',
			className: 'border-purple-500/20 bg-purple-500/10 text-purple-400',
		},
	} as const;

	const { label, className } = config[type];

	return <span class={`rounded border px-1.5 py-0.5 text-xs ${className}`}>{label}</span>;
}
