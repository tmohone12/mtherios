/**
 * BaseAIService — Mtherios
 * 
 * Base class for all AI services. Provides structured generation via
 * the active provider profile. Services extend this and define their
 * own system prompts + Zod schemas.
 */

import { generateNarrative } from './sdk/generate';
import { createLogger } from './core/config';
import type { z } from 'zod';

const log = createLogger('BaseAI');

export abstract class BaseAIService {
	protected readonly serviceId: string;

	constructor(serviceId: string) {
		this.serviceId = serviceId;
	}

	/**
	 * Generate a structured response using JSON mode.
	 * Sends the schema description in the system prompt and parses the response.
	 */
	protected async generateStructured<T>(
		schema: z.ZodType<T>,
		system: string,
		prompt: string,
	): Promise<T> {
		const jsonInstruction = '\n\nRespond ONLY with valid JSON matching the requested schema. No markdown, no code fences, no explanation.';

		const raw = await generateNarrative({
			system: system + jsonInstruction,
			prompt,
			temperature: 0.3,
			maxTokens: 4096,
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
	protected async generateText(system: string, prompt: string, temperature = 1.0): Promise<string> {
		return generateNarrative({ system, prompt, temperature });
	}
}
