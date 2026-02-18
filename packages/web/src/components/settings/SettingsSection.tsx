import { ComponentChildren } from 'preact';
import { cn } from '../../lib/utils.ts';

export interface SettingsSectionProps {
	title: string;
	children: ComponentChildren;
	class?: string;
}

export function SettingsSection({ title, children, class: className }: SettingsSectionProps) {
	return (
		<div class={cn('py-4', className)}>
			<h3 class="text-sm font-medium text-gray-400 mb-3">{title}</h3>
			<div class="space-y-3">{children}</div>
		</div>
	);
}

export interface SettingsRowProps {
	label: string;
	description?: string;
	children: ComponentChildren;
}

export function SettingsRow({ label, description, children }: SettingsRowProps) {
	return (
		<div class="flex items-center justify-between gap-4">
			<div class="flex-1 min-w-0">
				<div class="text-sm text-gray-300">{label}</div>
				{description && <div class="text-xs text-gray-500 mt-0.5">{description}</div>}
			</div>
			<div class="flex-shrink-0">{children}</div>
		</div>
	);
}

export interface SettingsSelectProps {
	value: string;
	onChange: (value: string) => void;
	options: Array<{ value: string; label: string }>;
	disabled?: boolean;
}

export function SettingsSelect({ value, onChange, options, disabled }: SettingsSelectProps) {
	return (
		<select
			value={value}
			onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
			disabled={disabled}
			class={cn(
				'bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-gray-300',
				'focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500',
				'disabled:opacity-50 disabled:cursor-not-allowed',
				'min-w-[140px]'
			)}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	);
}

export interface SettingsToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
}

export function SettingsToggle({ checked, onChange, disabled }: SettingsToggleProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			class={cn(
				'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full',
				'transition-colors duration-200 ease-in-out',
				'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-dark-950',
				'disabled:opacity-50 disabled:cursor-not-allowed',
				checked ? 'bg-blue-600' : 'bg-dark-700'
			)}
		>
			<span
				class={cn(
					'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0',
					'transition duration-200 ease-in-out',
					'mt-0.5 ml-0.5',
					checked ? 'translate-x-4' : 'translate-x-0'
				)}
			/>
		</button>
	);
}
