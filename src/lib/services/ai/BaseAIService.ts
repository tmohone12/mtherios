/**
 * BaseAIService — Mtherios
 * 
 * Base class for all AI services. Reads per-service model + prompt config
 * from the settings store. Provides structured generation via JSON mode.
 */

import { generateNarrative, stripThinkTags } from './sdk/generate';
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
		// Mention "json" explicitly — DeepSeek's JSON output mode requires the
		// word to appear in the system or user prompt, otherwise the API errors.
		const jsonInstruction = '\n\nRespond ONLY with valid json matching the requested schema. No markdown, no code fences, no explanation.';

		const raw = await generateNarrative({
			system: system + jsonInstruction,
			prompt,
			model: this.serviceModel || undefined,
			temperature: this.serviceTemperature,
			maxTokens: this.serviceMaxTokens,
			profileId: this.serviceProfileId || undefined,
			// Strict JSON mode — providers that don't support it ignore the
			// field; for deepseek-reasoner this is what makes the difference
			// between getting valid JSON and getting empty content mid-thinking.
			responseFormat: 'json_object',
			_service: this.serviceId,
		} as any);

		// Strip leaked `<think>` blocks (some proxies put reasoning content
		// directly into `message.content`) and any wrapping markdown code fence.
		let cleaned = stripThinkTags(raw).trim();
		if (cleaned.startsWith('```')) {
			cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
		}

		try {
			const parsed = JSON.parse(cleaned);
			return schema.parse(parsed);
		} catch (e) {
			// Try extracting a JSON object/array from within text
			// Handles cases where the LLM wraps JSON in prose or adds a preamble.
			// Validates against schema before accepting — never blindly treat extracted
			// JSON as a valid tool call if it doesn't match the expected structure.
			const extracted = this.extractJsonFromText(cleaned);
			if (extracted !== null) {
				try {
					const validated = schema.parse(extracted);
					log(`Extracted JSON from text response for ${this.serviceId}`);
					return validated;
				} catch {
					// Extracted JSON doesn't match schema — fall through to repair
				}
			}

			// Attempt to salvage truncated JSON by closing open structures
			const salvaged = this.tryRepairJson(cleaned);
			if (salvaged !== null) {
				try {
					const validated = schema.parse(salvaged);
					log(`Salvaged truncated JSON for ${this.serviceId}`);
					return validated;
				} catch {
					// Salvage parsed but failed schema validation — fall through
				}
			}
			log(`Structured generation parse failed for ${this.serviceId}`, { error: e, raw: cleaned.slice(0, 200) });
			throw new Error(`AI returned invalid JSON for ${this.serviceId}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Find the first JSON object or array in a text response and parse it.
	 * Handles cases where the LLM adds prose before or after the JSON payload.
	 * Returns the parsed value or null if no valid JSON structure is found.
	 * Intentionally does NOT validate against any schema — callers must do that.
	 */
	private extractJsonFromText(text: string): unknown | null {
		const objectStart = text.indexOf('{');
		const arrayStart = text.indexOf('[');
		// Prefer whichever comes first
		const starts = [objectStart, arrayStart].filter(i => i >= 0);
		if (starts.length === 0) return null;
		const start = Math.min(...starts);
		const candidate = text.slice(start);
		try {
			return JSON.parse(candidate);
		} catch {
			return this.tryRepairJson(candidate);
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
