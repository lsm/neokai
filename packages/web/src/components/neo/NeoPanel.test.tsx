/**
 * Tests for NeoPanel
 *
 * Verifies:
 * - Renders with correct aria attributes
 * - Panel is off-screen when panelOpen=false (-translate-x-full)
 * - Panel is on-screen when panelOpen=true (translate-x-0)
 * - Backdrop rendered; click dismisses panel
 * - Escape key closes panel
 * - Close button calls neoStore.closePanel
 * - Tab switching: Chat tab and Activity tab
 * - subscribe() called on mount; unsubscribe() on unmount
 * - Renders NeoChatView by default (chat tab)
 * - Renders NeoActivityView when activity tab is active
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Mock neoStore — signals inside factory to avoid hoisting issues
// ---------------------------------------------------------------------------

vi.mock('../../lib/neo-store.ts', async () => {
	const { signal: s } = await import('@preact/signals');
	const panelOpen = s(false);
	const activeTab = s<'chat' | 'activity'>('chat');
	const subscribe = vi.fn().mockResolvedValue(undefined);
	const unsubscribe = vi.fn();
	const closePanel = vi.fn(() => {
		panelOpen.value = false;
	});
	return {
		neoStore: { panelOpen, activeTab, subscribe, unsubscribe, closePanel },
	};
});

// Mock child views
vi.mock('./NeoChatView.tsx', () => ({
	NeoChatView: () => <div data-testid="mock-chat-view">Chat</div>,
}));

vi.mock('./NeoActivityView.tsx', () => ({
	NeoActivityView: () => <div data-testid="mock-activity-view">Activity</div>,
}));

import { NeoPanel } from './NeoPanel.tsx';
import { neoStore } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeoPanel', () => {
	beforeEach(() => {
		neoStore.panelOpen.value = false;
		neoStore.activeTab.value = 'chat';
		(neoStore.subscribe as ReturnType<typeof vi.fn>).mockClear();
		(neoStore.unsubscribe as ReturnType<typeof vi.fn>).mockClear();
		(neoStore.closePanel as ReturnType<typeof vi.fn>).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the panel with role=dialog', () => {
		const { getByTestId } = render(<NeoPanel />);
		const panel = getByTestId('neo-panel');
		expect(panel.getAttribute('role')).toBe('dialog');
	});

	it('panel has aria-modal=true', () => {
		const { getByTestId } = render(<NeoPanel />);
		expect(getByTestId('neo-panel').getAttribute('aria-modal')).toBe('true');
	});

	it('panel is off-screen when closed (-translate-x-full)', () => {
		neoStore.panelOpen.value = false;
		const { getByTestId } = render(<NeoPanel />);
		expect(getByTestId('neo-panel').className).toContain('-translate-x-full');
	});

	it('panel is on-screen when open (translate-x-0)', () => {
		neoStore.panelOpen.value = true;
		const { getByTestId } = render(<NeoPanel />);
		expect(getByTestId('neo-panel').className).toContain('translate-x-0');
	});

	it('renders backdrop', () => {
		const { getByTestId } = render(<NeoPanel />);
		expect(getByTestId('neo-panel-backdrop')).toBeTruthy();
	});

	it('backdrop click calls closePanel', () => {
		neoStore.panelOpen.value = true;
		const { getByTestId } = render(<NeoPanel />);
		fireEvent.click(getByTestId('neo-panel-backdrop'));
		expect(neoStore.closePanel).toHaveBeenCalledOnce();
	});

	it('close button calls closePanel', () => {
		neoStore.panelOpen.value = true;
		const { getByTestId } = render(<NeoPanel />);
		fireEvent.click(getByTestId('neo-panel-close'));
		expect(neoStore.closePanel).toHaveBeenCalledOnce();
	});

	it('Escape key calls closePanel when panel is open', () => {
		neoStore.panelOpen.value = true;
		render(<NeoPanel />);
		act(() => {
			fireEvent.keyDown(document, { key: 'Escape' });
		});
		expect(neoStore.closePanel).toHaveBeenCalledOnce();
	});

	it('Escape key does NOT close when panel is closed', () => {
		neoStore.panelOpen.value = false;
		render(<NeoPanel />);
		act(() => {
			fireEvent.keyDown(document, { key: 'Escape' });
		});
		expect(neoStore.closePanel).not.toHaveBeenCalled();
	});

	it('subscribe() is called on mount', () => {
		render(<NeoPanel />);
		expect(neoStore.subscribe).toHaveBeenCalledOnce();
	});

	it('unsubscribe() is called on unmount', () => {
		const { unmount } = render(<NeoPanel />);
		unmount();
		expect(neoStore.unsubscribe).toHaveBeenCalledOnce();
	});

	it('renders NeoChatView when activeTab=chat', () => {
		neoStore.activeTab.value = 'chat';
		const { getByTestId } = render(<NeoPanel />);
		expect(getByTestId('mock-chat-view')).toBeTruthy();
	});

	it('renders NeoActivityView when activeTab=activity', () => {
		neoStore.activeTab.value = 'activity';
		const { getByTestId } = render(<NeoPanel />);
		expect(getByTestId('mock-activity-view')).toBeTruthy();
	});

	it('chat tab button is aria-selected=true when on chat', () => {
		neoStore.activeTab.value = 'chat';
		const { getByTestId } = render(<NeoPanel />);
		expect(getByTestId('neo-tab-chat').getAttribute('aria-selected')).toBe('true');
		expect(getByTestId('neo-tab-activity').getAttribute('aria-selected')).toBe('false');
	});

	it('activity tab button is aria-selected=true when on activity', () => {
		neoStore.activeTab.value = 'activity';
		const { getByTestId } = render(<NeoPanel />);
		expect(getByTestId('neo-tab-activity').getAttribute('aria-selected')).toBe('true');
		expect(getByTestId('neo-tab-chat').getAttribute('aria-selected')).toBe('false');
	});

	it('clicking activity tab switches to activity view', () => {
		neoStore.activeTab.value = 'chat';
		const { getByTestId } = render(<NeoPanel />);
		act(() => {
			fireEvent.click(getByTestId('neo-tab-activity'));
		});
		expect(neoStore.activeTab.value).toBe('activity');
		expect(getByTestId('mock-activity-view')).toBeTruthy();
	});

	it('clicking chat tab switches to chat view from activity', () => {
		neoStore.activeTab.value = 'activity';
		const { getByTestId } = render(<NeoPanel />);
		act(() => {
			fireEvent.click(getByTestId('neo-tab-chat'));
		});
		expect(neoStore.activeTab.value).toBe('chat');
		expect(getByTestId('mock-chat-view')).toBeTruthy();
	});

	it('header has "Neo" text', () => {
		const { getByTestId } = render(<NeoPanel />);
		const header = getByTestId('neo-panel-header');
		expect(header.textContent).toContain('Neo');
	});
});
