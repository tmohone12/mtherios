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

	/** Get per-service API profile ID (empty = use active/default profile). */
	protected get serviceProfileId(): string {
		return settings.getServiceConfig(this.serviceId).profileId;
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
			model: this.serviceModel || undefined,
			temperature: this.serviceTemperature,
			maxTokens: this.serviceMaxTokens,
			profileId: this.serviceProfileId || undefined,
			_service: this.serviceId,
		} as any);

		// Strip markdown code fences if present
		let cleaned = raw.trim();
		if (cleaned.startsWith('```')) {
			cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
		}

		try {
			const parsed = JSON.parse(cleaned);
			return schema.parse(parsed);
		} catch (e) {
			// Attempt to salvage truncated JSON by closing open structures
			const salvaged = this.tryRepairJson(cleaned);
			if (salvaged !== null) {
				try {
					log(`Salvaged truncated JSON for ${this.serviceId}`);
					return schema.parse(salvaged);
				} catch {
					// Salvage parsed but failed schema validation — fall through
				}
			}
			log(`Structured generation parse failed for ${this.serviceId}`, { error: e, raw: cleaned.slice(0, 200) });
			throw new Error(`AI returned invalid JSON for ${this.serviceId}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Attempt to repair truncated JSON by removing the last incomplete value
	 * and closing all open brackets/braces. Returns parsed object or null.
	 */
	private tryRepairJson(raw: string): unknown | null {
		// Iterative truncation: find the last comma outside a string, trim there,
		// close open brackets, try parse. Repeat up to 5 times.
		let candidate = raw;
		for (let attempt = 0; attempt < 5; attempt++) {
			const closed = this.closeOpenBrackets(candidate);
			try {
				return JSON.parse(closed);
			} catch {
				// Find last comma outside a string and truncate there
				const commaIdx = this.findLastOutsideString(candidate, ',');
				if (commaIdx <= 0) return null;
				candidate = candidate.slice(0, commaIdx);
			}
		}
		return null;
	}

	/** Find the last index of `char` that is NOT inside a JSON string. Returns -1 if not found. */
	private findLastOutsideString(text: string, char: string): number {
		let inString = false;
		let escape = false;
		let lastIdx = -1;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (escape) { escape = false; continue; }
			if (ch === '\\' && inString) { escape = true; continue; }
			if (ch === '"') { inString = !inString; continue; }
			if (!inString && ch === char) lastIdx = i;
		}
		return lastIdx;
	}

	/** Close any unclosed brackets/braces by scanning for open structures. */
	private closeOpenBrackets(text: string): string {
		const stack: string[] = [];
		let inString = false;
		let escape = false;
		for (const ch of text) {
			if (escape) { escape = false; continue; }
			if (ch === '\\' && inString) { escape = true; continue; }
			if (ch === '"') { inString = !inString; continue; }
			if (inString) continue;
			if (ch === '{') stack.push('}');
			else if (ch === '[') stack.push(']');
			else if (ch === '}' || ch === ']') stack.pop();
		}
		return text + stack.reverse().join('');
	}

	/**
	 * Generate a plain text response.
	 */
	protected async generateText(defaultSystem: string, prompt: string): Promise<string> {
		const system = this.promptOverride || defaultSystem;
		return generateNarrative({
			system, prompt,
			model: this.serviceModel || undefined,
			temperature: this.serviceTemperature,
			maxTokens: this.serviceMaxTokens,
			profileId: this.serviceProfileId || undefined,
			_service: this.serviceId,
		} as any);
	}
}
