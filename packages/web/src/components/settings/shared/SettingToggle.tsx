/**
 * SettingToggle - Toggle switch for boolean settings
 *
 * A reusable toggle component with label, description, and optional inheritance badge.
 */

export interface SettingToggleProps {
	label: string;
	description?: string;
	checked: boolean;
	onChange: (checked: boolean) => void | Promise<void>;
	disabled?: boolean;
	inherited?: boolean;
	saving?: boolean;
}

export function SettingToggle({
	label,
	description,
	checked,
	onChange,
	disabled = false,
	inherited = false,
	saving = false,
}: SettingToggleProps) {
	const handleChange = async (e: Event) => {
		const target = e.target as HTMLInputElement;
		if (!disabled && !saving) {
			await onChange(target.checked);
		}
	};

	return (
		<label
			class={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
				checked
					? 'border-dark-600 bg-dark-800'
					: 'border-dark-700 bg-dark-900 opacity-60 hover:opacity-100'
			} ${disabled || saving ? 'cursor-not-allowed opacity-50' : ''}`}
		>
			<input
				type="checkbox"
				checked={checked}
				onChange={handleChange}
				disabled={disabled || saving}
				class="mt-0.5 h-4 w-4 rounded border-gray-600 bg-dark-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
			/>
			<div class="flex-1">
				<div class="flex items-center gap-2">
					<span class="text-sm font-medium text-gray-200">{label}</span>
					{inherited && (
						<span class="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs text-gray-400">
							Inherited
						</span>
					)}
				</div>
				{description && <div class="mt-0.5 text-xs text-gray-500">{description}</div>}
			</div>
		</label>
	);
}
