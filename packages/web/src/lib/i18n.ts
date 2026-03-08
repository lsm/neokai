import { computed, signal } from '@preact/signals';
import { en } from './i18n/en';
import { zh } from './i18n/zh';

export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'neokai-locale';

const translations: Record<Locale, Record<string, string>> = { en, zh };

function detectDefaultLocale(): Locale {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'en' || stored === 'zh') {
			return stored;
		}
	} catch {
		// localStorage unavailable (SSR, privacy mode, etc.)
	}

	if (typeof navigator !== 'undefined') {
		const lang = navigator.language || '';
		if (lang.startsWith('zh')) {
			return 'zh';
		}
	}

	return 'en';
}

export const locale = signal<Locale>(detectDefaultLocale());

const currentTranslations = computed(() => translations[locale.value]);

export function setLocale(newLocale: Locale): void {
	locale.value = newLocale;
	try {
		localStorage.setItem(STORAGE_KEY, newLocale);
	} catch {
		// localStorage unavailable
	}
}

export function t(key: string, params?: Record<string, string | number>): string {
	let value = currentTranslations.value[key] ?? en[key] ?? key;

	if (params) {
		for (const [param, replacement] of Object.entries(params)) {
			value = value.replaceAll(`{${param}}`, String(replacement));
		}
	}

	return value;
}
