/**
 * useSkills Hook
 *
 * Lifecycle adapter that manages the global Skills registry LiveQuery subscription.
 *
 * Responsibilities:
 * - On mount: call skillsStore.subscribe()
 * - On unmount: call skillsStore.unsubscribe()
 *
 * The store owns the subscription handles and cleanup logic.
 * This hook is purely a lifecycle adapter between the Preact component
 * tree and the skills store's LiveQuery methods.
 *
 * @returns The store signals for use in components.
 *
 * @example
 * ```tsx
 * export default function SkillsRegistry() {
 *   const { skills, isLoading, error } = useSkills();
 *   if (isLoading.value) return <div>Loading...</div>;
 *   return <ul>{skills.value.map(s => <li key={s.id}>{s.displayName}</li>)}</ul>;
 * }
 * ```
 */

import { useEffect } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import type { AppSkill } from '@neokai/shared';
import { skillsStore } from '../lib/skills-store';

interface UseSkillsResult {
	skills: Signal<AppSkill[]>;
	isLoading: Signal<boolean>;
	error: Signal<string | null>;
}

/**
 * Subscribe to the global Skills registry and return reactive signals.
 *
 * Manages the LiveQuery subscription lifecycle:
 * subscribe on mount, unsubscribe on unmount.
 */
export function useSkills(): UseSkillsResult {
	useEffect(() => {
		skillsStore.subscribe().catch(() => {
			// Error is surfaced via skillsStore.error signal
		});
		return () => {
			skillsStore.unsubscribe();
		};
	}, []);

	return {
		skills: skillsStore.skills,
		isLoading: skillsStore.isLoading,
		error: skillsStore.error,
	};
}
