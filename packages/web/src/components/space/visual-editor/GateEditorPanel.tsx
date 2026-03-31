import { useState } from 'preact/hooks';
import type { Gate, GateField, GateFieldType, GateFieldCheck } from '@neokai/shared';

export interface GateEditorPanelProps {
	gate: Gate;
	onChange: (gate: Gate) => void;
	onBack: () => void;
}

const FIELD_TYPES: GateFieldType[] = ['boolean', 'string', 'number', 'map'];
const SCALAR_OPS = ['==', '!=', 'exists'] as const;

function defaultCheckForType(type: GateFieldType): GateFieldCheck {
	if (type === 'map') {
		return { op: 'count', match: 'approved', min: 1 };
	}
	return { op: 'exists' };
}

function modeButtonClass(active: boolean): string {
	return active
		? 'border-blue-500 bg-blue-500/10 text-blue-200'
		: 'border-dark-600 bg-dark-800 text-gray-400 hover:border-dark-500 hover:text-gray-200';
}

export function GateEditorPanel({ gate, onChange, onBack }: GateEditorPanelProps) {
	const [expandedField, setExpandedField] = useState<number | null>(null);

	function updateGate(partial: Partial<Gate>) {
		onChange({ ...gate, ...partial });
	}

	function updateField(index: number, updated: GateField) {
		const next = [...gate.fields];
		next[index] = updated;
		updateGate({ fields: next });
	}

	function addField() {
		const newField: GateField = {
			name: '',
			type: 'boolean',
			writers: ['*'],
			check: { op: 'exists' },
		};
		updateGate({ fields: [...gate.fields, newField] });
		setExpandedField(gate.fields.length);
	}

	function deleteField(index: number) {
		const next = gate.fields.filter((_, i) => i !== index);
		updateGate({ fields: next });
		if (expandedField === index) setExpandedField(null);
		else if (expandedField !== null && expandedField > index) setExpandedField(expandedField - 1);
	}

	function addHumanApprovalPreset() {
		const preset: GateField = {
			name: 'approved',
			type: 'boolean',
			writers: ['human'],
			check: { op: '==', value: true },
		};
		updateGate({ fields: [...gate.fields, preset] });
	}

	function addTaskResultPreset() {
		const preset: GateField = {
			name: 'result',
			type: 'string',
			writers: ['*'],
			check: { op: '==', value: 'passed' },
		};
		updateGate({ fields: [...gate.fields, preset] });
	}

	return (
		<div
			data-testid="gate-editor-panel"
			class="flex flex-col gap-3 p-4 bg-dark-850 border border-dark-700 rounded-lg text-sm text-white max-h-full overflow-y-auto"
		>
			{/* Header */}
			<div class="flex items-center gap-2">
				<button
					type="button"
					data-testid="gate-editor-back"
					onClick={onBack}
					class="text-gray-400 hover:text-white transition-colors text-xs"
					aria-label="Back"
				>
					&larr;
				</button>
				<span class="font-semibold text-white text-sm">Gate Editor</span>
			</div>

			{/* Gate ID */}
			<div class="space-y-1">
				<label class="text-[11px] uppercase tracking-[0.12em] text-gray-500">Gate ID</label>
				<div class="text-xs font-mono bg-dark-800 rounded px-2 py-1.5 text-gray-400 border border-dark-700 truncate">
					{gate.id}
				</div>
			</div>

			{/* Description */}
			<div class="space-y-1">
				<label class="text-[11px] uppercase tracking-[0.12em] text-gray-500">Description</label>
				<input
					type="text"
					data-testid="gate-editor-description"
					value={gate.description ?? ''}
					placeholder="What does this gate check?"
					onInput={(e) => updateGate({ description: (e.currentTarget as HTMLInputElement).value || undefined })}
					class="w-full text-xs bg-dark-800 border border-dark-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-700"
				/>
			</div>

			{/* Reset on cycle */}
			<label class="flex items-center gap-2 cursor-pointer">
				<input
					type="checkbox"
					data-testid="gate-editor-reset-on-cycle"
					checked={gate.resetOnCycle}
					onChange={(e) => updateGate({ resetOnCycle: (e.currentTarget as HTMLInputElement).checked })}
					class="rounded border-dark-600 text-blue-500 focus:ring-blue-500"
				/>
				<span class="text-xs text-gray-400">Reset on cycle</span>
			</label>

			{/* Fields */}
			<div class="space-y-2">
				<label class="text-[11px] uppercase tracking-[0.12em] text-gray-500">Fields</label>
				{gate.fields.length === 0 && (
					<p class="text-xs text-gray-600 italic">No fields — gate always opens</p>
				)}
				{gate.fields.map((field, i) => (
					<FieldCard
						key={i}
						field={field}
						index={i}
						expanded={expandedField === i}
						onToggle={() => setExpandedField(expandedField === i ? null : i)}
						onChange={(updated) => updateField(i, updated)}
						onDelete={() => deleteField(i)}
					/>
				))}
			</div>

			{/* Add field */}
			<button
				type="button"
				data-testid="gate-editor-add-field"
				onClick={addField}
				class="w-full rounded border border-dashed border-dark-500 px-2 py-1.5 text-xs text-gray-400 hover:border-blue-500 hover:text-blue-300 transition-colors"
			>
				+ Add Field
			</button>

			{/* Presets */}
			<div class="space-y-1">
				<label class="text-[11px] uppercase tracking-[0.12em] text-gray-500">Presets</label>
				<div class="flex gap-2">
					<button
						type="button"
						data-testid="gate-editor-preset-human"
						onClick={addHumanApprovalPreset}
						class={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${modeButtonClass(false)}`}
					>
						Human Approval
					</button>
					<button
						type="button"
						data-testid="gate-editor-preset-result"
						onClick={addTaskResultPreset}
						class={`flex-1 rounded border px-2 py-1.5 text-xs transition-colors ${modeButtonClass(false)}`}
					>
						Task Result
					</button>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// FieldCard sub-component
// ---------------------------------------------------------------------------

interface FieldCardProps {
	field: GateField;
	index: number;
	expanded: boolean;
	onToggle: () => void;
	onChange: (field: GateField) => void;
	onDelete: () => void;
}

function FieldCard({ field, index, expanded, onToggle, onChange, onDelete }: FieldCardProps) {
	function updateField(partial: Partial<GateField>) {
		onChange({ ...field, ...partial });
	}

	function handleTypeChange(type: GateFieldType) {
		updateField({ type, check: defaultCheckForType(type) });
	}

	function handleScalarOpChange(op: '==' | '!=' | 'exists') {
		if (op === 'exists') {
			updateField({ check: { op: 'exists' } });
		} else {
			updateField({ check: { op, value: field.check.op !== 'count' ? field.check.value : '' } });
		}
	}

	return (
		<div
			data-testid={`gate-field-card-${index}`}
			class="border border-dark-600 rounded bg-dark-800 overflow-hidden"
		>
			{/* Collapsed header */}
			<button
				type="button"
				class="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-dark-750 transition-colors"
				onClick={onToggle}
			>
				<span class="text-gray-500">{expanded ? '\u25BC' : '\u25B6'}</span>
				<span class="font-mono text-gray-200 truncate flex-1">{field.name || '(unnamed)'}</span>
				<span class="text-gray-500 text-[11px]">{field.type}</span>
			</button>

			{expanded && (
				<div class="px-3 pb-3 space-y-2 border-t border-dark-700 pt-2">
					{/* Name */}
					<div class="space-y-0.5">
						<label class="text-[10px] uppercase tracking-wider text-gray-600">Name</label>
						<input
							type="text"
							data-testid={`gate-field-name-${index}`}
							value={field.name}
							placeholder="field_name"
							onInput={(e) => updateField({ name: (e.currentTarget as HTMLInputElement).value })}
							class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
						/>
					</div>

					{/* Type */}
					<div class="space-y-0.5">
						<label class="text-[10px] uppercase tracking-wider text-gray-600">Type</label>
						<select
							data-testid={`gate-field-type-${index}`}
							value={field.type}
							onChange={(e) => handleTypeChange((e.currentTarget as HTMLSelectElement).value as GateFieldType)}
							class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500"
						>
							{FIELD_TYPES.map((t) => (
								<option key={t} value={t}>
									{t}
								</option>
							))}
						</select>
					</div>

					{/* Writers */}
					<div class="space-y-0.5">
						<label class="text-[10px] uppercase tracking-wider text-gray-600">Writers (comma-separated)</label>
						<input
							type="text"
							data-testid={`gate-field-writers-${index}`}
							value={field.writers.join(', ')}
							placeholder="*, human, coder"
							onInput={(e) => {
								const raw = (e.currentTarget as HTMLInputElement).value;
								const writers = raw
									.split(',')
									.map((s) => s.trim())
									.filter(Boolean);
								updateField({ writers });
							}}
							class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
						/>
					</div>

					{/* Check config — adapts to type */}
					<div class="space-y-0.5">
						<label class="text-[10px] uppercase tracking-wider text-gray-600">Check</label>
						{field.type === 'map' ? (
							// Map check: match + min
							<div class="space-y-1">
								<input
									type="text"
									data-testid={`gate-field-match-${index}`}
									value={field.check.op === 'count' ? String(field.check.match ?? '') : ''}
									placeholder="match value"
									onInput={(e) => {
										const match = (e.currentTarget as HTMLInputElement).value;
										const min = field.check.op === 'count' ? field.check.min : 1;
										updateField({ check: { op: 'count', match, min } });
									}}
									class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
								/>
								<div class="flex items-center gap-2">
									<label class="text-[10px] text-gray-600">Min count</label>
									<input
										type="number"
										min={1}
										data-testid={`gate-field-min-${index}`}
										value={field.check.op === 'count' ? field.check.min : 1}
										onInput={(e) => {
											const min = Number((e.currentTarget as HTMLInputElement).value);
											const match = field.check.op === 'count' ? field.check.match : 'approved';
											updateField({ check: { op: 'count', match, min: Math.max(1, min) } });
										}}
										class="w-16 text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500"
									/>
								</div>
							</div>
						) : (
							// Scalar check: op + value
							<div class="space-y-1">
								<select
									data-testid={`gate-field-op-${index}`}
									value={field.check.op === 'count' ? '==' : field.check.op}
									onChange={(e) => handleScalarOpChange((e.currentTarget as HTMLSelectElement).value as '==' | '!=' | 'exists')}
									class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500"
								>
									{SCALAR_OPS.map((op) => (
										<option key={op} value={op}>
											{op === 'exists' ? 'Exists' : op === '==' ? 'Equals (==)' : 'Not Equal (!=)'}
										</option>
									))}
								</select>
								{field.check.op !== 'exists' && field.check.op !== 'count' && (
									<input
										type="text"
										data-testid={`gate-field-value-${index}`}
										value={field.check.value === true ? 'true' : field.check.value === false ? 'false' : String(field.check.value ?? '')}
										placeholder="expected value"
										onInput={(e) => {
											const raw = (e.currentTarget as HTMLInputElement).value;
											let value: unknown = raw;
											if (field.type === 'boolean') {
												value = raw === 'true';
											} else if (field.type === 'number') {
												const n = Number(raw);
												value = isNaN(n) ? raw : n;
											}
											updateField({ check: { op: field.check.op as '==' | '!=', value } });
										}}
										class="w-full text-xs bg-dark-900 border border-dark-600 rounded px-2 py-1 text-gray-200 font-mono focus:outline-none focus:border-blue-500 placeholder-gray-700"
									/>
								)}
							</div>
						)}
					</div>

					{/* Delete field */}
					<button
						type="button"
						data-testid={`gate-field-delete-${index}`}
						onClick={onDelete}
						class="w-full rounded px-2 py-1 text-xs text-red-400 border border-red-800 hover:bg-red-900/30 transition-colors"
					>
						Delete field
					</button>
				</div>
			)}
		</div>
	);
}
