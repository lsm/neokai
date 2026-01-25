// @ts-nocheck
/**
 * Tests for file-utils.ts
 *
 * Tests file utility functions for handling file uploads and conversions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileToBase64, formatFileSize, validateImageFile } from '../file-utils';

// Helper to create mock File objects with controlled size
function createMockFile(name: string, size: number, type: string): File {
	// Create a file with the mock properties
	const file = new File([''], name, { type });

	// Override the size property to return our mock size
	Object.defineProperty(file, 'size', {
		value: size,
		writable: false,
		configurable: true,
	});

	return file;
}

describe('file-utils', () => {
	describe('formatFileSize', () => {
		it('should format 0 bytes', () => {
			expect(formatFileSize(0)).toBe('0 B');
		});

		it('should format bytes', () => {
			expect(formatFileSize(500)).toBe('500 B');
		});

		it('should format kilobytes', () => {
			expect(formatFileSize(1024)).toBe('1 KB');
			expect(formatFileSize(1536)).toBe('1.5 KB');
			expect(formatFileSize(2048)).toBe('2 KB');
		});

		it('should format megabytes', () => {
			expect(formatFileSize(1024 * 1024)).toBe('1 MB');
			expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
			expect(formatFileSize(3.75 * 1024 * 1024)).toBe('3.75 MB');
		});

		it('should format gigabytes', () => {
			expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
			expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
		});

		it('should round to 2 decimal places', () => {
			expect(formatFileSize(1234)).toBe('1.21 KB');
			expect(formatFileSize(1234567)).toBe('1.18 MB');
		});
	});

	describe('validateImageFile', () => {
		it('should return null for valid PNG file', () => {
			const file = createMockFile('test.png', 1024, 'image/png');
			expect(validateImageFile(file)).toBeNull();
		});

		it('should return null for valid JPEG file', () => {
			const file = createMockFile('test.jpg', 1024, 'image/jpeg');
			expect(validateImageFile(file)).toBeNull();
		});

		it('should return null for valid GIF file', () => {
			const file = createMockFile('test.gif', 1024, 'image/gif');
			expect(validateImageFile(file)).toBeNull();
		});

		it('should return null for valid WebP file', () => {
			const file = createMockFile('test.webp', 1024, 'image/webp');
			expect(validateImageFile(file)).toBeNull();
		});

		it('should return error for unsupported file type', () => {
			const file = createMockFile('test.pdf', 1024, 'application/pdf');
			const error = validateImageFile(file);
			expect(error).toBe('Only images are supported (PNG, JPEG, GIF, WebP)');
		});

		it('should return error for text file', () => {
			const file = createMockFile('test.txt', 1024, 'text/plain');
			const error = validateImageFile(file);
			expect(error).toBe('Only images are supported (PNG, JPEG, GIF, WebP)');
		});

		it('should return error for BMP (unsupported image type)', () => {
			const file = createMockFile('test.bmp', 1024, 'image/bmp');
			const error = validateImageFile(file);
			expect(error).toBe('Only images are supported (PNG, JPEG, GIF, WebP)');
		});

		it('should return error for empty file (0 bytes)', () => {
			const file = createMockFile('test.png', 0, 'image/png');
			const error = validateImageFile(file);
			expect(error).toContain('under');
		});

		it('should return error for file exceeding size limit', () => {
			// 4MB file (exceeds 3.75MB limit)
			const file = createMockFile('test.png', 4 * 1024 * 1024, 'image/png');
			const error = validateImageFile(file);
			expect(error).toContain('under');
			expect(error).toContain('MB');
		});

		it('should return null for file at exactly max size', () => {
			// 3.75MB file
			const file = createMockFile('test.png', 3.75 * 1024 * 1024, 'image/png');
			expect(validateImageFile(file)).toBeNull();
		});

		it('should return error for file just over max size', () => {
			// 3.76MB file
			const file = createMockFile('test.png', 3.76 * 1024 * 1024, 'image/png');
			const error = validateImageFile(file);
			expect(error).toContain('under');
		});

		it('should validate type before size', () => {
			// Large invalid type should show type error
			const file = createMockFile('test.txt', 10 * 1024 * 1024, 'text/plain');
			const error = validateImageFile(file);
			expect(error).toBe('Only images are supported (PNG, JPEG, GIF, WebP)');
		});
	});

	describe('fileToBase64', () => {
		// Mock FileReader for testing
		let originalFileReader: typeof FileReader;

		beforeEach(() => {
			originalFileReader = global.FileReader;
		});

		afterEach(() => {
			global.FileReader = originalFileReader;
		});

		it('should convert file to base64 string', async () => {
			// Create a mock FileReader that returns a known base64 string
			const mockBase64Data = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64
			const mockDataUrl = `data:image/png;base64,${mockBase64Data}`;

			class MockFileReader {
				result: string | null = null;
				onload: ((event: unknown) => void) | null = null;
				onerror: ((event: unknown) => void) | null = null;

				readAsDataURL(_file: Blob) {
					this.result = mockDataUrl;
					setTimeout(() => {
						if (this.onload) {
							this.onload({});
						}
					}, 0);
				}
			}

			global.FileReader = MockFileReader as unknown as typeof FileReader;

			const file = createMockFile('test.png', 1024, 'image/png');
			const result = await fileToBase64(file);

			expect(result).toBe(mockBase64Data);
		});

		it('should reject when FileReader fails', async () => {
			class MockFileReader {
				result: string | null = null;
				onload: ((event: unknown) => void) | null = null;
				onerror: ((event: unknown) => void) | null = null;

				readAsDataURL(_file: Blob) {
					setTimeout(() => {
						if (this.onerror) {
							this.onerror({});
						}
					}, 0);
				}
			}

			global.FileReader = MockFileReader as unknown as typeof FileReader;

			const file = createMockFile('test.png', 1024, 'image/png');

			await expect(fileToBase64(file)).rejects.toThrow('Failed to read file');
		});

		it('should reject when base64 size exceeds limit', async () => {
			// Create a large base64 string that exceeds 5MB limit
			const largeBase64Data = 'A'.repeat(6 * 1024 * 1024); // 6MB of base64
			const mockDataUrl = `data:image/png;base64,${largeBase64Data}`;

			class MockFileReader {
				result: string | null = null;
				onload: ((event: unknown) => void) | null = null;
				onerror: ((event: unknown) => void) | null = null;

				readAsDataURL(_file: Blob) {
					this.result = mockDataUrl;
					setTimeout(() => {
						if (this.onload) {
							this.onload({});
						}
					}, 0);
				}
			}

			global.FileReader = MockFileReader as unknown as typeof FileReader;

			const file = createMockFile('test.png', 4 * 1024 * 1024, 'image/png');

			await expect(fileToBase64(file)).rejects.toThrow('exceeds API limit');
		});

		it('should include file sizes in error message when base64 exceeds limit', async () => {
			const largeBase64Data = 'A'.repeat(6 * 1024 * 1024);
			const mockDataUrl = `data:image/png;base64,${largeBase64Data}`;

			class MockFileReader {
				result: string | null = null;
				onload: ((event: unknown) => void) | null = null;
				onerror: ((event: unknown) => void) | null = null;

				readAsDataURL(_file: Blob) {
					this.result = mockDataUrl;
					setTimeout(() => {
						if (this.onload) {
							this.onload({});
						}
					}, 0);
				}
			}

			global.FileReader = MockFileReader as unknown as typeof FileReader;

			const file = createMockFile('test.png', 4 * 1024 * 1024, 'image/png');

			try {
				await fileToBase64(file);
				expect.fail('Should have thrown');
			} catch (error) {
				const message = (error as Error).message;
				expect(message).toContain('MB');
				expect(message).toContain('resize');
			}
		});
	});
});
