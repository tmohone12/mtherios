import { describe, expect, it } from 'vitest';
import { shouldRequireProviderSetup } from './onboardingFlow';
import type { APIProfile } from '$lib/types';

function profile(overrides: Partial<APIProfile> = {}): APIProfile {
	return {
		id: 'profile_1',
		name: 'NanoGPT',
		providerType: 'nanogpt',
		apiKey: 'test-key',
		customModels: [],
		fetchedModels: [],
		reasoningModels: [],
		hiddenModels: [],
		favoriteModels: [],
		createdAt: 1,
		...overrides,
	};
}

describe('shouldRequireProviderSetup', () => {
	it('requires provider setup only for first-time onboarding without a configured profile', () => {
		expect(shouldRequireProviderSetup({ onboardingComplete: false, profiles: [] })).toBe(true);
		expect(shouldRequireProviderSetup({ onboardingComplete: false, profiles: [profile()] })).toBe(false);
		expect(shouldRequireProviderSetup({ onboardingComplete: true, profiles: [] })).toBe(false);
	});
});
