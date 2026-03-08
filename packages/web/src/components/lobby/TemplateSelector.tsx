/**
 * TemplateSelector Component
 *
 * Template grid + variable fill-in form for session/room creation.
 * Shows available templates as cards, with a form for variable input when selected.
 */

import type { SessionTemplate, SessionTemplateVariable } from '@neokai/shared';

interface TemplateSelectorProps {
	templates: SessionTemplate[];
	selectedTemplateId: string | undefined;
	onSelect: (templateId: string | undefined) => void;
	templateVariables: Record<string, string>;
	onVariableChange: (name: string, value: string) => void;
}

export function TemplateSelector({
	templates,
	selectedTemplateId,
	onSelect,
	templateVariables,
	onVariableChange,
}: TemplateSelectorProps) {
	const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

	if (templates.length === 0) {
		return null;
	}

	return (
		<div>
			<label class="block text-sm font-medium text-gray-300 mb-1.5">Template (optional)</label>

			{/* Template Cards */}
			<div class="grid grid-cols-2 gap-2 mb-3">
				{/* No template option */}
				<button
					type="button"
					onClick={() => onSelect(undefined)}
					class={`text-left p-2.5 rounded-lg border transition-colors text-sm ${
						!selectedTemplateId
							? 'border-blue-500 bg-blue-500/10'
							: 'border-dark-700 bg-dark-800 hover:border-dark-600'
					}`}
				>
					<div class="font-medium text-gray-200">Blank</div>
					<div class="text-xs text-gray-500 mt-0.5">Start from scratch</div>
				</button>

				{templates.map((template) => (
					<button
						key={template.id}
						type="button"
						onClick={() => onSelect(template.id)}
						class={`text-left p-2.5 rounded-lg border transition-colors text-sm ${
							selectedTemplateId === template.id
								? 'border-blue-500 bg-blue-500/10'
								: 'border-dark-700 bg-dark-800 hover:border-dark-600'
						}`}
					>
						<div class="font-medium text-gray-200 flex items-center gap-1.5">
							{template.name}
							{template.builtIn && (
								<span class="text-[10px] px-1 py-0.5 rounded bg-dark-700 text-gray-500">
									built-in
								</span>
							)}
						</div>
						{template.description && (
							<div class="text-xs text-gray-500 mt-0.5 line-clamp-2">{template.description}</div>
						)}
					</button>
				))}
			</div>

			{/* Variable Form */}
			{selectedTemplate?.variables && selectedTemplate.variables.length > 0 && (
				<VariableForm
					variables={selectedTemplate.variables}
					values={templateVariables}
					onChange={onVariableChange}
				/>
			)}
		</div>
	);
}

interface VariableFormProps {
	variables: SessionTemplateVariable[];
	values: Record<string, string>;
	onChange: (name: string, value: string) => void;
}

function VariableForm({ variables, values, onChange }: VariableFormProps) {
	return (
		<div class="space-y-3 bg-dark-800/50 border border-dark-700 rounded-lg p-3">
			<div class="text-xs font-medium text-gray-400 uppercase tracking-wide">
				Template Variables
			</div>
			{variables.map((variable) => (
				<div key={variable.name}>
					<label class="block text-sm text-gray-400 mb-1">
						{variable.label}
						{variable.required && <span class="text-red-400 ml-0.5">*</span>}
					</label>
					{variable.type === 'textarea' ? (
						<textarea
							value={values[variable.name] ?? variable.default ?? ''}
							onInput={(e) => onChange(variable.name, (e.target as HTMLTextAreaElement).value)}
							rows={3}
							class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none text-sm"
							placeholder={variable.label}
						/>
					) : variable.type === 'select' && variable.options ? (
						<select
							value={values[variable.name] ?? variable.default ?? ''}
							onChange={(e) => onChange(variable.name, (e.target as HTMLSelectElement).value)}
							class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100 focus:outline-none focus:border-blue-500 cursor-pointer text-sm"
						>
							<option value="">Select...</option>
							{variable.options.map((opt) => (
								<option key={opt} value={opt}>
									{opt}
								</option>
							))}
						</select>
					) : (
						<input
							type="text"
							value={values[variable.name] ?? variable.default ?? ''}
							onInput={(e) => onChange(variable.name, (e.target as HTMLInputElement).value)}
							class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 text-sm"
							placeholder={variable.label}
						/>
					)}
				</div>
			))}
		</div>
	);
}
