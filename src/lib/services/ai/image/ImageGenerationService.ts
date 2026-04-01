/**
 * ImageGenerationService — Mtherios
 *
 * Generates scene images from narrative text using various providers.
 * Supports NanoGPT image API, Pollinations, and OpenAI-compatible endpoints.
 *
 * Uses a Magali Villeneuve / ASOIAF official art style guide by default.
 */

import { createLogger } from '../core/config';
import { getSetting } from '$lib/services/database';
import { PROVIDERS } from '../sdk/providers/config';
import type { APIProfile, ProviderType, VisualDescriptors } from '$lib/types';

const log = createLogger('ImageGen');

// ── ASOIAF / Magali Villeneuve style guide ──

const ASOIAF_STYLE = [
	'highly detailed digital fantasy illustration in the style of Magali Villeneuve and A Song of Ice and Fire official art',
	'rich oil painting textures, cinematic composition',
	'dramatic chiaroscuro with volumetric god rays',
	'deep crimsons, burnished golds, warm amber tones, and desaturated earth tones with selective color saturation on focal points',
	'intricate costume details with medieval-historical accuracy mixed with fantasy elements',
	'atmospheric perspective, painterly brushwork with visible texture in shadows',
	'8k detail, dramatic rim lighting, romanticized historical aesthetic',
	'metallic sheen on armor and fabric, subtle magical atmosphere',
].join(', ');

const NEGATIVE_PROMPT = [
	'cartoon', 'anime', 'chibi', 'low quality', 'blurry', 'watermark', 'text',
	'modern clothing', 'contemporary', 'neon colors', 'oversaturated',
	'plastic skin', 'smooth airbrush', 'flat lighting',
].join(', ');

export interface SceneContext {
	characters?: { name: string; visualDescriptors?: VisualDescriptors }[];
	currentLocation?: { name: string; description?: string | null };
}

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

export interface ImageGenerationResult {
	image: GeneratedImage | null;
	error?: string;
}

export class ImageGenerationService {
	/**
	 * Extract a visual scene description from narrative prose + world context.
	 * Strips dialogue, internal thoughts, and game mechanics to focus on
	 * what a painter would actually depict.
	 */
	private extractVisualScene(narrative: string, context?: SceneContext): string {
		// Take last ~600 chars (most recent scene beat)
		const raw = narrative.slice(-600);

		// Strip quoted dialogue
		let visual = raw.replace(/"[^"]*"/g, '');
		// Strip parenthetical game mechanics like [Roll: ...]
		visual = visual.replace(/\[[^\]]*\]/g, '');
		// Collapse whitespace
		visual = visual.replace(/\s+/g, ' ').trim();

		// If stripping left us with very little, fall back to raw
		if (visual.length < 40) visual = raw.replace(/\s+/g, ' ').trim();

		// Cap at 300 chars to leave room for context
		visual = visual.slice(0, 300);

		// Append character visual descriptors
		if (context?.characters?.length) {
			const charDescs = context.characters.slice(0, 3).map(c => {
				const vd = c.visualDescriptors;
				if (!vd) return c.name;
				const parts = [c.name];
				if (vd.face) parts.push(vd.face);
				if (vd.hair) parts.push(vd.hair);
				if (vd.clothing) parts.push(vd.clothing);
				if (vd.build) parts.push(vd.build);
				if (vd.distinguishing) parts.push(vd.distinguishing);
				return parts.join(', ');
			});
			visual += '. Characters: ' + charDescs.join('; ');
		}

		// Append location context
		if (context?.currentLocation) {
			const loc = context.currentLocation;
			visual += `. Setting: ${loc.name}`;
			if (loc.description) visual += ` — ${loc.description.slice(0, 100)}`;
		}

		return visual.slice(0, 600);
	}

	/**
	 * Generate a scene image from a narrative description.
	 */
	async generateSceneImage(
		narrative: string,
		context?: SceneContext,
		style = ASOIAF_STYLE,
	): Promise<ImageGenerationResult> {
		log('generateSceneImage', { narrativeLen: narrative.length });

		try {
			const profilesJson = await getSetting('apiProfiles');
			const activeProfileId = await getSetting('activeProfileId');
			if (!profilesJson) return { image: null, error: 'No API profiles configured.' };
			const profiles: APIProfile[] = JSON.parse(profilesJson);

			// Use active profile, not just the first one
			const profile = activeProfileId
				? profiles.find(p => p.id === activeProfileId) ?? profiles[0]
				: profiles[0];
			if (!profile) return { image: null, error: 'No API profile found.' };

			const scene = this.extractVisualScene(narrative, context);
			const imagePrompt = `${scene}, ${style}`;

			const providerType = profile.providerType as ProviderType;
			const providerConfig = PROVIDERS[providerType];

			log('generateSceneImage', { provider: providerType, hasKey: !!profile.apiKey });

			let image: GeneratedImage | null = null;

			// Provider-specific image generation
			if (providerType === 'nanogpt' && profile.apiKey) {
				const model = providerConfig?.imageDefaults?.defaultModel ?? 'flux-schnell';
				image = await this.generateViaOpenAICompat(
					'https://nano-gpt.com/api/v1/images/generations',
					profile.apiKey,
					imagePrompt,
					model,
				);
			} else if (providerType === 'openrouter' && profile.apiKey) {
				const model = providerConfig?.imageDefaults?.defaultModel ?? 'google/gemini-2.5-flash-image';
				image = await this.generateViaOpenAICompat(
					'https://openrouter.ai/api/v1/images/generations',
					profile.apiKey,
					imagePrompt,
					model,
				);
			} else if (providerType === 'openai' && profile.apiKey) {
				const model = providerConfig?.imageDefaults?.defaultModel ?? 'dall-e-3';
				image = await this.generateViaOpenAICompat(
					'https://api.openai.com/v1/images/generations',
					profile.apiKey,
					imagePrompt,
					model,
				);
			} else if ((providerType === 'google' || providerType === 'google-ai-studio') && profile.apiKey) {
				const model = providerConfig?.imageDefaults?.defaultModel ?? 'gemini-2.0-flash';
				image = await this.generateViaGemini(
					profile.apiKey,
					imagePrompt,
					model,
				);
			} else if (providerType === 'pollinations') {
				image = await this.generateViaPollinations(imagePrompt);
			} else if (providerType === 'chutes' && profile.apiKey) {
				const model = providerConfig?.imageDefaults?.defaultModel ?? 'z-image-turbo';
				image = await this.generateViaOpenAICompat(
					'https://api.chutes.ai/v1/images/generations',
					profile.apiKey,
					imagePrompt,
					model,
				);
			} else if (providerConfig?.capabilities.imageGeneration && profile.apiKey && profile.baseUrl) {
				// Generic OpenAI-compatible fallback
				const baseUrl = profile.baseUrl.replace(/\/+$/, '');
				const endpoint = baseUrl.endsWith('/v1') ? `${baseUrl}/images/generations` : `${baseUrl}/v1/images/generations`;
				image = await this.generateViaOpenAICompat(
					endpoint,
					profile.apiKey,
					imagePrompt,
					providerConfig.imageDefaults?.defaultModel ?? 'flux-schnell',
				);
			} else {
				// Fallback: Pollinations (free, no API key needed)
				log('generateSceneImage', 'Falling back to Pollinations');
				image = await this.generateViaPollinations(imagePrompt);
			}

			if (!image) {
				return { image: null, error: `Image generation returned no result (${providerType}).` };
			}
			return { image };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log('Image generation failed', { error: e });
			return { image: null, error: msg };
		}
	}

	private async generateViaOpenAICompat(
		endpoint: string,
		apiKey: string,
		prompt: string,
		model: string,
	): Promise<GeneratedImage | null> {
		log('generateViaOpenAICompat', { endpoint, model });

		// DALL-E 3 only accepts 1024x1024, 1024x1792, 1792x1024
		const isDalle = model.toLowerCase().includes('dall-e');
		const size = isDalle ? '1792x1024' : '1024x576';
		const [width, height] = size.split('x').map(Number);

		const body: Record<string, unknown> = {
			prompt,
			model,
			n: 1,
			size,
		};
		// negative_prompt is not part of the OpenAI API spec — only send for non-OpenAI endpoints
		if (!isDalle) {
			body.negative_prompt = NEGATIVE_PROMPT;
		}

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => 'unknown');
			log('Image API error', { status: response.status, body: errText.slice(0, 200) });
			return null;
		}
		const data = await response.json();
		// OpenAI format: data[0].url or data[0].b64_json
		const url = data.data?.[0]?.url;
		const b64 = data.data?.[0]?.b64_json;
		if (url) return { url, prompt, width, height };
		if (b64) return { url: `data:image/png;base64,${b64}`, prompt, width, height };
		return null;
	}

	/**
	 * Generate image via Gemini's native generateContent API.
	 * Uses responseModalities: ['IMAGE'] to get inline base64 image data.
	 */
	private async generateViaGemini(
		apiKey: string,
		prompt: string,
		model = 'gemini-2.0-flash-exp',
	): Promise<GeneratedImage | null> {
		log('generateViaGemini', { model });
		const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
				generationConfig: {
					responseModalities: ['IMAGE', 'TEXT'],
				},
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => 'unknown');
			log('Gemini image error', { status: response.status, body: errText.slice(0, 300) });
			return null;
		}

		const data = await response.json();
		const parts = data.candidates?.[0]?.content?.parts;
		if (!parts) return null;

		// Find the image part (inline_data with mimeType image/*)
		for (const part of parts) {
			if (part.inlineData?.mimeType?.startsWith('image/')) {
				const mime = part.inlineData.mimeType;
				const b64 = part.inlineData.data;
				return {
					url: `data:${mime};base64,${b64}`,
					prompt,
					width: 1024,
					height: 1024,
				};
			}
		}

		log('Gemini image: no image part in response');
		return null;
	}

	private async generateViaPollinations(prompt: string): Promise<GeneratedImage> {
		const encoded = encodeURIComponent(prompt);
		const negEncoded = encodeURIComponent(NEGATIVE_PROMPT);
		const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=576&nologo=true&negative=${negEncoded}`;
		return { url, prompt, width: 1024, height: 576 };
	}
}
