// @ts-nocheck
/**
 * Tests for useFileAttachments Hook
 *
 * Tests file attachment state management and API surface.
 * Note: Tests that require actual FileReader operations are skipped because
 * happy-dom doesn't support FileReader correctly in CI environments.
 */

import './setup';
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

	describe('handleFileSelect edge cases', () => {
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

		it('should reset input value after processing attempt', async () => {
			const { result } = renderHook(() => useFileAttachments());

			const file = createMockFile('test.png', 'image/png');
			const input = {
				files: createMockFileList([file]),
				value: 'test.png',
			} as unknown as HTMLInputElement;

			const event = { target: input } as unknown as Event;

			await act(async () => {
				// This may fail to add files due to FileReader, but should still reset input
				try {
					await result.current.handleFileSelect(event);
				} catch {
					// Expected in happy-dom
				}
			});

			expect(input.value).toBe('');
		});
	});

	describe('clear', () => {
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

	describe('handleRemove', () => {
		it('should be callable without throwing when no attachments', () => {
			const { result } = renderHook(() => useFileAttachments());

			// Should not throw even with no attachments
			act(() => {
				result.current.handleRemove(0);
			});

			expect(result.current.attachments.length).toBe(0);
		});
	});
});
