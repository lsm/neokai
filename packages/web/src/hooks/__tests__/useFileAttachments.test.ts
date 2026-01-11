/**
 * Tests for useFileAttachments Hook
 *
 * Tests file attachment state, validation, and base64 conversion.
 * Note: Tests that require mocking file utils are limited due to module initialization order.
 */

import { describe, it, expect } from 'bun:test';
import { renderHook, act } from '@testing-library/preact';
import { useFileAttachments } from '../useFileAttachments.ts';

// Helper to create mock file
function createMockFile(name: string, type: string, content: string = 'test content'): File {
	return new File([content], name, { type });
}

// Helper to create mock FileList
function createMockFileList(files: File[]): FileList {
	const fileList = {
		length: files.length,
		item: (index: number) => files[index] || null,
		[Symbol.iterator]: function* () {
			for (const file of files) {
				yield file;
			}
		},
	} as FileList;

	files.forEach((file, index) => {
		Object.defineProperty(fileList, index, { value: file, enumerable: true });
	});

	return fileList;
}

describe('useFileAttachments', () => {
	describe('initialization', () => {
		it('should initialize with empty attachments', () => {
			const { result } = renderHook(() => useFileAttachments());

			expect(result.current.attachments).toEqual([]);
		});

		it('should provide fileInputRef', () => {
			const { result } = renderHook(() => useFileAttachments());

			expect(result.current.fileInputRef).toBeDefined();
			expect(result.current.fileInputRef.current).toBeNull();
		});

		it('should provide all required functions', () => {
			const { result } = renderHook(() => useFileAttachments());

			expect(typeof result.current.handleFileSelect).toBe('function');
			expect(typeof result.current.handleFileDrop).toBe('function');
			expect(typeof result.current.handleRemove).toBe('function');
			expect(typeof result.current.clear).toBe('function');
			expect(typeof result.current.openFilePicker).toBe('function');
			expect(typeof result.current.getImagesForSend).toBe('function');
		});
	});

	describe('handleFileSelect', () => {
		it('should process valid image files from input', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.png', 'image/png');
			const input = {
				files: createMockFileList([file]),
				value: 'test.png',
			} as unknown as HTMLInputElement;

			const event = { target: input } as unknown as Event;

			await act(async () => {
				await result.current.handleFileSelect(event);
			});

			expect(result.current.attachments.length).toBe(1);
			expect(result.current.attachments[0].name).toBe('test.png');
			expect(result.current.attachments[0].media_type).toBe('image/png');
			// Data should be base64 encoded
			expect(typeof result.current.attachments[0].data).toBe('string');
		});

		it('should reset input value after processing', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.png', 'image/png');
			const input = {
				files: createMockFileList([file]),
				value: 'test.png',
			} as unknown as HTMLInputElement;

			const event = { target: input } as unknown as Event;

			await act(async () => {
				await result.current.handleFileSelect(event);
			});

			expect(input.value).toBe('');
		});

		it('should do nothing if no files selected', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const input = {
				files: null,
				value: '',
			} as unknown as HTMLInputElement;

			const event = { target: input } as unknown as Event;

			await act(async () => {
				await result.current.handleFileSelect(event);
			});

			expect(result.current.attachments.length).toBe(0);
		});

		it('should do nothing if files is empty', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const input = {
				files: createMockFileList([]),
				value: '',
			} as unknown as HTMLInputElement;

			const event = { target: input } as unknown as Event;

			await act(async () => {
				await result.current.handleFileSelect(event);
			});

			expect(result.current.attachments.length).toBe(0);
		});

		it('should handle multiple image files', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file1 = createMockFile('test1.png', 'image/png', 'content1');
			const file2 = createMockFile('test2.jpg', 'image/jpeg', 'content2');

			const input = {
				files: createMockFileList([file1, file2]),
				value: 'test1.png',
			} as unknown as HTMLInputElement;

			const event = { target: input } as unknown as Event;

			await act(async () => {
				await result.current.handleFileSelect(event);
			});

			expect(result.current.attachments.length).toBe(2);
			expect(result.current.attachments[0].name).toBe('test1.png');
			expect(result.current.attachments[1].name).toBe('test2.jpg');
		});
	});

	describe('handleFileDrop', () => {
		it('should process dropped image files', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('dropped.png', 'image/png');
			const fileList = createMockFileList([file]);

			await act(async () => {
				await result.current.handleFileDrop(fileList);
			});

			expect(result.current.attachments.length).toBe(1);
			expect(result.current.attachments[0].name).toBe('dropped.png');
		});
	});

	describe('handleRemove', () => {
		it('should remove attachment at specified index', async () => {
			const { result } = renderHook(() => useFileAttachments());

			// Add two files
			const file1 = createMockFile('test1.png', 'image/png');
			const file2 = createMockFile('test2.png', 'image/png');

			await act(async () => {
				await result.current.handleFileDrop(createMockFileList([file1, file2]));
			});

			expect(result.current.attachments.length).toBe(2);

			// Remove first file
			act(() => {
				result.current.handleRemove(0);
			});

			expect(result.current.attachments.length).toBe(1);
			expect(result.current.attachments[0].name).toBe('test2.png');
		});

		it('should handle removing last attachment', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.png', 'image/png');

			await act(async () => {
				await result.current.handleFileDrop(createMockFileList([file]));
			});

			act(() => {
				result.current.handleRemove(0);
			});

			expect(result.current.attachments.length).toBe(0);
		});
	});

	describe('clear', () => {
		it('should clear all attachments', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file1 = createMockFile('test1.png', 'image/png');
			const file2 = createMockFile('test2.png', 'image/png');

			await act(async () => {
				await result.current.handleFileDrop(createMockFileList([file1, file2]));
			});

			expect(result.current.attachments.length).toBe(2);

			act(() => {
				result.current.clear();
			});

			expect(result.current.attachments.length).toBe(0);
		});

		it('should work when already empty', () => {
			const { result } = renderHook(() => useFileAttachments());

			// Should not throw
			act(() => {
				result.current.clear();
			});

			expect(result.current.attachments.length).toBe(0);
		});
	});

	describe('openFilePicker', () => {
		it('should call click on fileInputRef', () => {
			const { result } = renderHook(() => useFileAttachments());

			const clickMock = mock(() => {});
			const mockInput = { click: clickMock } as unknown as HTMLInputElement;

			// Set the ref manually
			Object.defineProperty(result.current.fileInputRef, 'current', {
				value: mockInput,
				writable: true,
			});

			act(() => {
				result.current.openFilePicker();
			});

			expect(clickMock).toHaveBeenCalled();
		});

		it('should handle null fileInputRef', () => {
			const { result } = renderHook(() => useFileAttachments());

			// Should not throw
			act(() => {
				result.current.openFilePicker();
			});
		});
	});

	describe('getImagesForSend', () => {
		it('should return undefined when no attachments', () => {
			const { result } = renderHook(() => useFileAttachments());

			const images = result.current.getImagesForSend();

			expect(images).toBeUndefined();
		});

		it('should return images without name and size metadata', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.png', 'image/png');

			await act(async () => {
				await result.current.handleFileDrop(createMockFileList([file]));
			});

			const images = result.current.getImagesForSend();

			expect(images).toBeDefined();
			expect(images!.length).toBe(1);
			// Should have data and media_type
			expect(images![0].media_type).toBe('image/png');
			expect(typeof images![0].data).toBe('string');
			// Should NOT include name and size
			expect((images![0] as Record<string, unknown>).name).toBeUndefined();
			expect((images![0] as Record<string, unknown>).size).toBeUndefined();
		});
	});

	describe('function stability', () => {
		it('should return stable function references', () => {
			const { result, rerender } = renderHook(() => useFileAttachments());

			const firstHandleFileSelect = result.current.handleFileSelect;
			const firstHandleFileDrop = result.current.handleFileDrop;
			const firstHandleRemove = result.current.handleRemove;
			const firstClear = result.current.clear;
			const firstOpenFilePicker = result.current.openFilePicker;

			rerender();

			expect(result.current.handleFileSelect).toBe(firstHandleFileSelect);
			expect(result.current.handleFileDrop).toBe(firstHandleFileDrop);
			expect(result.current.handleRemove).toBe(firstHandleRemove);
			expect(result.current.clear).toBe(firstClear);
			expect(result.current.openFilePicker).toBe(firstOpenFilePicker);
		});
	});

	describe('supported image types', () => {
		it('should accept PNG files', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.png', 'image/png');

			await act(async () => {
				await result.current.handleFileDrop(createMockFileList([file]));
			});

			expect(result.current.attachments.length).toBe(1);
		});

		it('should accept JPEG files', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.jpg', 'image/jpeg');

			await act(async () => {
				await result.current.handleFileDrop(createMockFileList([file]));
			});

			expect(result.current.attachments.length).toBe(1);
		});

		it('should accept GIF files', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.gif', 'image/gif');

			await act(async () => {
				await result.current.handleFileDrop(createMockFileList([file]));
			});

			expect(result.current.attachments.length).toBe(1);
		});

		it('should accept WebP files', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.webp', 'image/webp');

			await act(async () => {
				await result.current.handleFileDrop(createMockFileList([file]));
			});

			expect(result.current.attachments.length).toBe(1);
		});
	});
});
