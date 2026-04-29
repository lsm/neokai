import { describe, expect, it } from 'vitest';
import { MAIN_NAV_ITEMS } from '../nav-config';

describe('nav-config', () => {
	it('keeps Spaces as the primary navigation surface', () => {
		expect(MAIN_NAV_ITEMS.map((item) => item.id)).toEqual(['spaces', 'inbox', 'chats']);
	});
});
