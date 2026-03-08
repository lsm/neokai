/**
 * CreateRoomModal Component
 *
 * Modal form for creating a new room with:
 * - Room name (required)
 * - Background context (optional)
 * - Form validation and error handling
 */

import { useState } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { TemplateSelector } from './TemplateSelector';
import { t } from '../../lib/i18n';
import type { SessionTemplate } from '@neokai/shared';

interface CreateRoomModalProps {
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (params: {
		name: string;
		background?: string;
		templateId?: string;
		templateVariables?: Record<string, string>;
	}) => Promise<void>;
	templates?: SessionTemplate[];
}

export function CreateRoomModal({ isOpen, onClose, onSubmit, templates }: CreateRoomModalProps) {
	const [name, setName] = useState('');
	const [background, setBackground] = useState('');
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>();
	const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({});
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: Event) => {
		e.preventDefault();
		if (!name.trim()) {
			setError(t('createRoom.nameRequired'));
			return;
		}

		// Validate required template variables
		if (selectedTemplateId && templates) {
			const tmpl = templates.find((t) => t.id === selectedTemplateId);
			if (tmpl?.variables) {
				const missing = tmpl.variables
					.filter((v) => v.required && !templateVariables[v.name]?.trim())
					.map((v) => v.label);
				if (missing.length > 0) {
					setError(`Required template fields: ${missing.join(', ')}`);
					return;
				}
			}
		}

		try {
			setSubmitting(true);
			setError(null);

			await onSubmit({
				name: name.trim(),
				background: background.trim() || undefined,
				templateId: selectedTemplateId,
				templateVariables:
					selectedTemplateId && Object.keys(templateVariables).length > 0
						? templateVariables
						: undefined,
			});

			// Reset form on success
			setName('');
			setBackground('');
			setSelectedTemplateId(undefined);
			setTemplateVariables({});
		} catch (err) {
			setError(err instanceof Error ? err.message : t('createRoom.failed'));
		} finally {
			setSubmitting(false);
		}
	};

	const handleClose = () => {
		setName('');
		setBackground('');
		setSelectedTemplateId(undefined);
		setTemplateVariables({});
		setError(null);
		onClose();
	};

	return (
		<Modal isOpen={isOpen} onClose={handleClose} title={t('createRoom.title')} size="md">
			<form onSubmit={handleSubmit} class="space-y-4">
				{error && (
					<div class="bg-red-900/20 border border-red-800 rounded-lg px-4 py-3 text-red-400 text-sm">
						{error}
					</div>
				)}

				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						{t('createRoom.nameLabel')}
					</label>
					<input
						type="text"
						value={name}
						onInput={(e) => setName((e.target as HTMLInputElement).value)}
						placeholder={t('createRoom.namePlaceholder')}
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500"
						autoFocus
					/>
				</div>

				<div>
					<label class="block text-sm font-medium text-gray-300 mb-1.5">
						{t('createRoom.backgroundLabel')}
					</label>
					<p class="text-xs text-gray-500 mb-2">{t('createRoom.backgroundHelp')}</p>
					<textarea
						value={background}
						onInput={(e) => setBackground((e.target as HTMLTextAreaElement).value)}
						placeholder={t('createRoom.backgroundPlaceholder')}
						rows={4}
						class="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-gray-100
              placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
					/>
				</div>

				{/* Template Section */}
				{templates && templates.length > 0 && (
					<TemplateSelector
						templates={templates}
						selectedTemplateId={selectedTemplateId}
						onSelect={(id) => {
							setSelectedTemplateId(id);
							// Initialize templateVariables with default values from the template
							const tmpl = templates.find((t) => t.id === id);
							const defaults: Record<string, string> = {};
							if (tmpl?.variables) {
								for (const v of tmpl.variables) {
									if (v.default) defaults[v.name] = v.default;
								}
							}
							setTemplateVariables(defaults);
						}}
						templateVariables={templateVariables}
						onVariableChange={(name, value) =>
							setTemplateVariables((prev) => ({ ...prev, [name]: value }))
						}
					/>
				)}

				<div class="flex gap-3 pt-2">
					<Button type="button" variant="secondary" onClick={handleClose} fullWidth>
						{t('common.cancel')}
					</Button>
					<Button type="submit" loading={submitting} fullWidth>
						{t('createRoom.createRoom')}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
