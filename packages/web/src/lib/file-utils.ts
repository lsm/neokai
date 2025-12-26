/**
 * File utility functions for handling file uploads and conversions
 */

const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/**
 * Convert File object to base64 string (without data URL prefix)
 */
export async function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const base64 = reader.result as string;
			// Remove data URL prefix (e.g., "data:image/png;base64,")
			const base64Data = base64.split(',')[1];
			resolve(base64Data);
		};
		reader.onerror = () => reject(new Error('Failed to read file'));
		reader.readAsDataURL(file);
	});
}

/**
 * Validate if file type is a supported image format
 */
function isValidImageType(type: string): type is SupportedImageType {
	return SUPPORTED_IMAGE_TYPES.includes(type as SupportedImageType);
}

/**
 * Validate file size against maximum limit
 */
function isValidFileSize(size: number): boolean {
	return size > 0 && size <= MAX_IMAGE_SIZE;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
}

/**
 * Get maximum file size in MB
 */
function getMaxFileSizeMB(): number {
	return MAX_IMAGE_SIZE / (1024 * 1024);
}

/**
 * Validate image file and return error message if invalid
 */
export function validateImageFile(file: File): string | null {
	if (!isValidImageType(file.type)) {
		return `Only images are supported (PNG, JPEG, GIF, WebP)`;
	}

	if (!isValidFileSize(file.size)) {
		return `Image must be under ${getMaxFileSizeMB()}MB`;
	}

	return null;
}
