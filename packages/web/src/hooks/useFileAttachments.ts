/**
 * useFileAttachments Hook
 *
 * Handles file attachment state, validation, and base64 conversion.
 * Extracted from MessageInput.tsx for better separation of concerns.
 */

import type { RefObject } from 'preact';
import { useState, useCallback, useRef } from 'preact/hooks';
import type { MessageImage } from '@liuboer/shared';
import { toast } from '../lib/toast.ts';
import { fileToBase64, validateImageFile } from '../lib/file-utils.ts';

export interface AttachmentWithMetadata extends MessageImage {
	name: string;
	size: number;
}

export interface UseFileAttachmentsResult {
	attachments: AttachmentWithMetadata[];
	fileInputRef: RefObject<HTMLInputElement>;
	handleFileSelect: (e: Event) => Promise<void>;
	handleRemove: (index: number) => void;
	clear: () => void;
	openFilePicker: () => void;
	getImagesForSend: () => MessageImage[] | undefined;
}

/**
 * Hook for managing file attachments
 */
export function useFileAttachments(): UseFileAttachmentsResult {
	const [attachments, setAttachments] = useState<AttachmentWithMetadata[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleFileSelect = useCallback(async (e: Event) => {
		const input = e.target as HTMLInputElement;
		const files = input.files;
		if (!files || files.length === 0) return;

		for (const file of Array.from(files)) {
			const error = validateImageFile(file);
			if (error) {
				toast.error(error);
				continue;
			}

			try {
				const base64Data = await fileToBase64(file);
				setAttachments((prev) => [
					...prev,
					{
						data: base64Data,
						media_type: file.type as MessageImage['media_type'],
						name: file.name,
						size: file.size,
					},
				]);
			} catch (error) {
				console.error('Failed to read file:', error);
				toast.error(`Failed to read ${file.name}`);
			}
		}

		input.value = '';
	}, []);

	const handleRemove = useCallback((index: number) => {
		setAttachments((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const clear = useCallback(() => {
		setAttachments([]);
	}, []);

	const openFilePicker = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	// Strip metadata for sending
	const getImagesForSend = useCallback((): MessageImage[] | undefined => {
		if (attachments.length === 0) return undefined;
		return attachments.map(({ data, media_type }) => ({ data, media_type }));
	}, [attachments]);

	return {
		attachments,
		fileInputRef,
		handleFileSelect,
		handleRemove,
		clear,
		openFilePicker,
		getImagesForSend,
	};
}
