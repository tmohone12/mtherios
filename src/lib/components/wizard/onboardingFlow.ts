import type { APIProfile } from '$lib/types';

export interface ProviderSetupState {
	onboardingComplete: boolean;
	profiles: APIProfile[];
}

export function hasConfiguredProviderProfile(profiles: APIProfile[]): boolean {
	return profiles.some((profile) => Boolean(profile.apiKey?.trim()));
}

/**
 * Provider choosing is a first-run onboarding concern. Once onboarding has
 * completed, new-story creation should stay focused on writing, even if the
 * user's provider profile was imported, removed, or configured elsewhere.
 */
export function shouldRequireProviderSetup(state: ProviderSetupState): boolean {
	return !state.onboardingComplete && !hasConfiguredProviderProfile(state.profiles);
}
