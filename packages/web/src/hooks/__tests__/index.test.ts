// @ts-nocheck
/**
 * Tests for Hooks Index (barrel export)
 *
 * Verifies that all exports from the hooks index file are accessible.
 */

import {
	useModal,
	useInputDraft,
	useModelSwitcher,
	MODEL_FAMILY_ICONS,
	useMessageHub,
	useCommandAutocomplete,
	useInterrupt,
	useFileAttachments,
} from '../index.ts';

describe('Hooks Index', () => {
	describe('Hook exports', () => {
		it('should export useModal', () => {
			expect(useModal).toBeDefined();
			expect(typeof useModal).toBe('function');
		});

		it('should export useInputDraft', () => {
			expect(useInputDraft).toBeDefined();
			expect(typeof useInputDraft).toBe('function');
		});

		it('should export useModelSwitcher', () => {
			expect(useModelSwitcher).toBeDefined();
			expect(typeof useModelSwitcher).toBe('function');
		});

		it('should export MODEL_FAMILY_ICONS constant', () => {
			expect(MODEL_FAMILY_ICONS).toBeDefined();
			expect(typeof MODEL_FAMILY_ICONS).toBe('object');
		});

		it('should export useMessageHub', () => {
			expect(useMessageHub).toBeDefined();
			expect(typeof useMessageHub).toBe('function');
		});

		it('should export useCommandAutocomplete', () => {
			expect(useCommandAutocomplete).toBeDefined();
			expect(typeof useCommandAutocomplete).toBe('function');
		});

		it('should export useInterrupt', () => {
			expect(useInterrupt).toBeDefined();
			expect(typeof useInterrupt).toBe('function');
		});

		it('should export useFileAttachments', () => {
			expect(useFileAttachments).toBeDefined();
			expect(typeof useFileAttachments).toBe('function');
		});
	});
});
