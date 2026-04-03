/**
 * SpaceAgentEditor Component
 *
 * Modal form for creating or editing a custom agent in a Space.
 *
 * Fields:
 * - From Template (built-in seeded templates)
 * - Name (required, unique within space)
 * - Description (optional)
 * - Model (dropdown override)
 * - Tools (multi-select checkboxes from KNOWN_TOOLS)
 * - System Prompt (monospace textarea with line numbers)
 *
 * Tool presets: "Full Coding" · "Read Only" · "Custom"
 *
 * Validation: name required + unique, model required, at least one tool selected.
 */

import { useState } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { spaceStore } from '../../lib/space-store';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgent } from '@neokai/shared';
import type { SpaceAgentTemplate } from '../../lib/space-store';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect';

// ============================================================================
// Constants
// ============================================================================

type ToolName = (typeof KNOWN_TOOLS)[number];

/** Tool presets map preset name → tool selection */
const TOOL_PRESETS: Record<string, ToolName[]> = {
	'Full Coding': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
	'Read Only': ['Read', 'Grep', 'Glob'],
};

// ============================================================================
// Pure helpers (module-level to avoid re-creation on each render)
// ============================================================================

/** Detect which preset name matches a given tool list, or 'Custom' if no match */
function detectPreset(toolList: string[] | undefined): string {
	if (!toolList) return 'Full Coding';
	for (const [preset, presetTools] of Object.entries(TOOL_PRESETS)) {
		if (toolList.length === presetTools.length && presetTools.every((t) => toolList.includes(t))) {
			return preset;
		}
	}
	return 'Custom';
}

// ============================================================================
// Sub-components
// ============================================================================

interface LineNumberedTextareaProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	rows?: number;
}

/** Monospace textarea with a line-number gutter on the left */
function LineNumberedTextarea({
	value,
	onChange,
	placeholder,
	rows = 10,
}: LineNumberedTextareaProps) {
	const lineCount = value ? value.split('\n').length : 1;
	const displayLines = Math.max(lineCount, rows);

	return (
		<div class="relative flex border border-dark-600 rounded-lg overflow-hidden bg-dark-800 focus-within:border-blue-500 transition-colors">
			{/* Line numbers gutter */}
			<div
				aria-hidden="true"
				class="flex flex-col items-end px-2 py-2 select-none text-gray-600 text-xs font-mono bg-dark-850 border-r border-dark-700 flex-shrink-0"
				style="min-width: 2.5rem; line-height: 1.375rem;"
			>
				{Array.from({ length: displayLines }, (_, i) => (
					<span key={i} style="height: 1.375rem; line-height: 1.375rem;">
						{i + 1}
					</span>
				))}
			</div>
			{/* Textarea */}
			<textarea
				value={value}
				onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
				placeholder={placeholder}
				rows={rows}
				spellcheck={false}
				class="flex-1 bg-transparent py-2 px-3 text-gray-100 font-mono text-xs resize-none focus:outline-none"
				style="line-height: 1.375rem;"
			/>
		</div>
	);
}

// ============================================================================
// Main component
// ============================================================================

export interface SpaceAgentEditorProps {
	/** Existing agent to edit. Null = create mode. */
	agent: SpaceAgent | null;
	/** Names of other agents in this space (for uniqueness validation) */
	existingAgentNames: string[];
	/** Called after a successful save */
	onSave: () => void;
	/** Called when the user cancels */
	onCancel: () => void;
}

export function SpaceAgentEditor({
	agent,
	existingAgentNames,
	onSave,
	onCancel,
}: SpaceAgentEditorProps) {
	const isEdit = agent !== null;
	const builtInTemplates = spaceStore.agentTemplates.value;

	// Form state
	const [name, setName] = useState(agent?.name ?? '');
	const [description, setDescription] = useState(agent?.description ?? '');
	const [model, setModel] = useState(agent?.model ?? '');
	const [tools, setTools] = useState<string[]>(agent?.tools ?? [...TOOL_PRESETS['Full Coding']]);
	const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
	const [activePreset, setActivePreset] = useState<string>(() => detectPreset(agent?.tools));
	const [selectedTemplateName, setSelectedTemplateName] = useState<string>('');

	// UI state
	const [saving, setSaving] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [saveError, setSaveError] = useState<string | null>(null);

	const applyPreset = (presetName: string) => {
		setActivePreset(presetName);
		if (presetName in TOOL_PRESETS) {
			setTools([...TOOL_PRESETS[presetName]]);
		}
	};

	const applyTemplate = (template: SpaceAgentTemplate) => {
		if (!isEdit && !name.trim()) {
			setName(template.name);
		}
		setDescription(template.description ?? '');
		setSystemPrompt(template.systemPrompt ?? '');
		setTools([...template.tools]);
		setActivePreset(detectPreset(template.tools));
		setErrors((prev) => ({ ...prev, tools: '', name: '', model: '' }));
		setSaveError(null);
	};

	const toggleTool = (tool: string) => {
		setTools((prev) => {
			const next = prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool];
			setActivePreset(detectPreset(next));
			return next;
		});
	};

	const validate = (): boolean => {
		const newErrors: Record<string, string> = {};

		const trimmedName = name.trim();
		if (!trimmedName) {
			newErrors['name'] = 'Name is required';
		} else {
			const lower = trimmedName.toLowerCase();
			const conflict = existingAgentNames.some((n) => n.toLowerCase() === lower);
			if (conflict) {
				newErrors['name'] = 'An agent with this name already exists';
			}
		}

		if (!model.trim()) {
			newErrors['model'] = 'Model is required';
		}

		if (tools.length === 0) {
			newErrors['tools'] = 'At least one tool must be selected';
		}

		setErrors(newErrors);
		return Object.keys(newErrors).length === 0;
	};

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		if (!validate()) return;

		setSaving(true);
		setSaveError(null);

		try {
			const params = {
				name: name.trim(),
				description: description.trim() || undefined,
				model: model.trim(),
				systemPrompt: systemPrompt || undefined,
				tools: tools.length > 0 ? tools : undefined,
			};

			if (isEdit && agent) {
				await spaceStore.updateAgent(agent.id, params);
			} else {
				await spaceStore.createAgent(params);
			}

			onSave();
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : 'Failed to save agent');
		} finally {
			setSaving(false);
		}
	};

	const title = isEdit ? `Edit Agent: ${agent!.name}` : 'Create Agent';

	return (
		<Modal isOpen onClose={onCancel} title={title} size="lg">
			<form onSubmit={handleSubmit} class="space-y-5">
				{/* Save error */}
				{saveError && (
					<div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
						{saveError}
					</div>
				)}

				{/* Template selector */}
				<div>
					<label class="block text-sm font-medium text-gray-200 mb-1.5" for="agent-template-select">
						From Template
					</label>
					<select
						id="agent-template-select"
						value={selectedTemplateName}
						onChange={(e) => {
							const templateName = (e.target as HTMLSelectElement).value;
							setSelectedTemplateName(templateName);
							const template = builtInTemplates.find((item) => item.name === templateName);
							if (template) applyTemplate(template);
						}}
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500"
					>
						<option value="">Select a built-in template...</option>
						{builtInTemplates.map((template) => (
							<option key={template.name} value={template.name}>
								{template.name}
							</option>
						))}
					</select>
					{builtInTemplates.length === 0 && (
						<p class="mt-1 text-xs text-gray-500">
							No built-in templates are available for this space.
						</p>
					)}
				</div>

				{/* Name */}
				<div>
					<label class="block text-sm font-medium text-gray-200 mb-1.5">
						Name
						<span class="text-red-400 ml-1">*</span>
					</label>
					<input
						type="text"
						value={name}
						onInput={(e) => {
							setName((e.target as HTMLInputElement).value);
							if (errors['name']) setErrors((prev) => ({ ...prev, name: '' }));
						}}
						placeholder="e.g., Senior Coder"
						class={`w-full bg-dark-800 border rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 ${
							errors['name'] ? 'border-red-700' : 'border-dark-600'
						}`}
						autoFocus
					/>
					{errors['name'] && <p class="mt-1 text-xs text-red-400">{errors['name']}</p>}
				</div>

				{/* Description */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						Description
						<span class="text-gray-500 text-xs ml-2">(optional)</span>
					</label>
					<input
						type="text"
						value={description}
						onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
						placeholder="Briefly describe this agent's specialization..."
						class="w-full bg-dark-800 border border-dark-600 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500"
					/>
				</div>

				{/* Model */}
				<div>
					<label class="block text-sm font-medium text-gray-200 mb-1.5">
						Model
						<span class="text-red-400 ml-1">*</span>
					</label>
					<WorkflowModelSelect
						value={model || undefined}
						onChange={(value) => {
							setModel(value ?? '');
							if (errors['model']) setErrors((prev) => ({ ...prev, model: '' }));
						}}
						testId="space-agent-model-select"
						className={`w-full bg-dark-800 border rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500 font-mono text-sm ${
							errors['model'] ? 'border-red-700' : 'border-dark-600'
						}`}
					/>
					{errors['model'] && <p class="mt-1 text-xs text-red-400">{errors['model']}</p>}
				</div>

				{/* Tools */}
				<div>
					<div class="flex items-center justify-between mb-2">
						<label class="block text-sm font-medium text-gray-200">
							Tools
							<span class="text-red-400 ml-1">*</span>
						</label>
						{/* Tool presets */}
						<div class="flex gap-1.5">
							{[...Object.keys(TOOL_PRESETS), 'Custom'].map((preset) => (
								<button
									key={preset}
									type="button"
									onClick={() => {
										if (preset !== 'Custom') applyPreset(preset);
										else setActivePreset('Custom');
									}}
									class={`text-xs px-2.5 py-1 rounded border transition-colors ${
										activePreset === preset
											? 'border-blue-600 bg-blue-900/20 text-blue-300'
											: 'border-dark-600 text-gray-500 hover:border-dark-500 hover:text-gray-300'
									}`}
								>
									{preset}
								</button>
							))}
						</div>
					</div>
					<div class="grid grid-cols-3 gap-1.5">
						{(KNOWN_TOOLS as readonly string[]).map((tool) => {
							const checked = tools.includes(tool);
							return (
								<label
									key={tool}
									class={`flex items-center gap-2 px-3 py-1.5 rounded border cursor-pointer text-xs transition-colors ${
										checked
											? 'border-blue-700/60 bg-blue-900/15 text-blue-200'
											: 'border-dark-700 text-gray-500 hover:border-dark-600 hover:text-gray-300'
									}`}
								>
									<input
										type="checkbox"
										checked={checked}
										onChange={() => toggleTool(tool)}
										class="sr-only"
									/>
									<span
										class={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${
											checked ? 'bg-blue-600 border-blue-600' : 'border-dark-500'
										}`}
									>
										{checked && (
											<svg class="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12">
												<path d="M10 3L5 8.5 2 5.5l-1 1L5 10.5l6-7-1-1z" />
											</svg>
										)}
									</span>
									{tool}
								</label>
							);
						})}
					</div>
					{errors['tools'] && <p class="mt-1.5 text-xs text-red-400">{errors['tools']}</p>}
				</div>

				{/* System Prompt */}
				<div>
					<label class="block text-sm font-medium text-gray-300 mb-2">
						System Prompt
						<span class="text-gray-500 text-xs ml-2">(optional)</span>
					</label>
					<LineNumberedTextarea
						value={systemPrompt}
						onChange={setSystemPrompt}
						placeholder="Exact system prompt text for this agent..."
						rows={8}
					/>
				</div>

				{/* Actions */}
				<div class="flex gap-3 pt-1">
					<Button type="button" variant="secondary" onClick={onCancel} fullWidth>
						Cancel
					</Button>
					<Button type="submit" loading={saving} fullWidth>
						{isEdit ? 'Save Changes' : 'Create Agent'}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
