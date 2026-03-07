/**
 * ImageGenerationService — Mtherios
 * 
 * Generates scene images from narrative text using various providers.
 * Supports NanoGPT image API, Pollinations, and OpenAI-compatible endpoints.
 */

import { createLogger } from '../core/config';
import { getSetting } from '$lib/services/database';
import type { APIProfile } from '$lib/types';

const log = createLogger('ImageGen');

export interface ImageGenerationOptions {
	prompt: string;
	style?: string;
	width?: number;
	height?: number;
	negativePrompt?: string;
}

export interface GeneratedImage {
	url: string;
	prompt: string;
	width: number;
	height: number;
}

export class ImageGenerationService {
	/**
	 * Generate a scene image from a narrative description.
	 */
	async generateSceneImage(
		narrative: string,
		style = 'dark fantasy, atmospheric, detailed',
	): Promise<GeneratedImage | null> {
		log('generateSceneImage', { narrativeLen: narrative.length });

		try {
			const profilesJson = await getSetting('apiProfiles');
			if (!profilesJson) return null;
			const profiles: APIProfile[] = JSON.parse(profilesJson);
			const profile = profiles[0];
			if (!profile?.apiKey) return null;

			// Build image prompt from narrative
			const imagePrompt = `${style}. Scene: ${narrative.slice(0, 500)}`;

			// Use NanoGPT image endpoint if available
			if (profile.providerType === 'nanogpt') {
				return this.generateViaNanoGPT(profile.apiKey, imagePrompt);
			}

			// Fallback: Pollinations (free, no API key needed)
			return this.generateViaPollinations(imagePrompt);
		} catch (e) {
			log('Image generation failed', { error: e });
			return null;
		}
	}

	private async generateViaNanoGPT(apiKey: string, prompt: string): Promise<GeneratedImage | null> {
		const response = await fetch('https://nano-gpt.com/api/v1/images/generations', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				prompt,
				model: 'flux-schnell',
				n: 1,
				size: '1024x576',
			}),
		});

		if (!response.ok) return null;
		const data = await response.json();
		const url = data.data?.[0]?.url;
		if (!url) return null;

		return { url, prompt, width: 1024, height: 576 };
	}

	private async generateViaPollinations(prompt: string): Promise<GeneratedImage> {
		const encoded = encodeURIComponent(prompt);
		const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=576&nologo=true`;
		return { url, prompt, width: 1024, height: 576 };
	}
}
