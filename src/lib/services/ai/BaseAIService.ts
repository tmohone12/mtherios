/**
 * BaseAIService — Mtherios
 * 
 * Base class for all AI services. Reads per-service model + prompt config
 * from the settings store. Provides structured generation via JSON mode.
 */

import { generateNarrative } from './sdk/generate';
import { createLogger } from './core/config';
import { settings } from '$lib/stores/settings.svelte';
import type { z } from 'zod';

const log = createLogger('BaseAI');

export abstract class BaseAIService {
	protected readonly serviceId: string;

	constructor(serviceId: string) {
		this.serviceId = serviceId;
	}

	/** Get per-service model override, or empty string for default. */
	protected get serviceModel(): string {
		return settings.getServiceConfig(this.serviceId).model;
	}

	/** Get per-service temperature. */
	protected get serviceTemperature(): number {
		return settings.getServiceConfig(this.serviceId).temperature;
	}

	/** Get per-service max tokens. */
	protected get serviceMaxTokens(): number {
		return settings.getServiceConfig(this.serviceId).maxTokens;
	}

	/** Get system prompt override (empty = use default). */
	protected get promptOverride(): string {
		return settings.getServiceConfig(this.serviceId).systemPromptOverride;
	}

	/** Check if service is enabled. */
	protected get isEnabled(): boolean {
		return settings.getServiceConfig(this.serviceId).enabled;
	}

	/**
	 * Generate a structured response using JSON mode.
	 * If the user has set a system prompt override, it replaces the default.
	 */
	protected async generateStructured<T>(
		schema: z.ZodType<T>,
		defaultSystem: string,
		prompt: string,
	): Promise<T> {
		const system = this.promptOverride || defaultSystem;
		const jsonInstruction = '\n\nRespond ONLY with valid JSON matching the requested schema. No markdown, no code fences, no explanation.';

		const raw = await generateNarrative({
			system: system + jsonInstruction,
			prompt,
			temperature: this.serviceTemperature,
			maxTokens: this.serviceMaxTokens,
		});

		// Strip markdown code fences if present
		let cleaned = raw.trim();
		if (cleaned.startsWith('```')) {
			cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
		}

		try {
			const parsed = JSON.parse(cleaned);
			return schema.parse(parsed);
		} catch (e) {
			log(`Structured generation parse failed for ${this.serviceId}`, { error: e, raw: cleaned.slice(0, 200) });
			throw new Error(`AI returned invalid JSON for ${this.serviceId}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Generate a plain text response.
	 */
	protected async generateText(defaultSystem: string, prompt: string): Promise<string> {
		const system = this.promptOverride || defaultSystem;
		return generateNarrative({ system, prompt, temperature: this.serviceTemperature });
	}
}
