/**
 * SettingSelect - Select dropdown for settings
 *
 * A reusable select component with label, description, and options.
 */

export interface SelectOption {
	value: string;
	label: string;
	description?: string;
}

export interface SettingSelectProps {
	label: string;
	description?: string;
	value: string;
	options: readonly SelectOption[];
	onChange: (value: string) => void | Promise<void>;
	disabled?: boolean;
	saving?: boolean;
}

export function SettingSelect({
	label,
	description,
	value,
	options,
	onChange,
	disabled = false,
	saving = false,
}: SettingSelectProps) {
	const handleChange = async (e: Event) => {
		const target = e.target as HTMLSelectElement;
		if (!disabled && !saving) {
			await onChange(target.value);
		}
	};

	return (
		<div class="space-y-2">
			<div>
				<label class="text-sm font-medium text-gray-200">{label}</label>
				{description && <p class="mt-0.5 text-xs text-gray-500">{description}</p>}
			</div>
			<select
				value={value}
				onChange={handleChange}
				disabled={disabled || saving}
				class={`w-full rounded-lg bg-dark-900 px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
					disabled || saving ? 'border-dark-700 opacity-50' : 'border-dark-600'
				}`}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
}
