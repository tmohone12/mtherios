import { describe, expect, it, vi } from 'vitest';
import { createTurnMemoryStream, mergeTurnMemoryUpdates, parseTurnMemoryEnvelope, TURN_MEMORY_MARKER } from './turnMemoryEnvelope';

describe('GameMaster turn memory footer', () => {
	it('keeps the footer out of a split visible stream and retains exact evidence', async () => {
		const chunks: string[] = [];
		const stream = createTurnMemoryStream(chunk => { chunks.push(chunk); });
		const quote = 'Mira gave the key to Sansa.';
		// The provider may place the marker directly after prose without a newline.
		const raw = `${quote}<turn_memory_update>{"version":1,"changes":[{"kind":"event","quote":"${quote}","visibility":"player_known","update":{"items":[{"name":"key","location":"Sansa"}]}}]}</turn_memory_update>`;
		for (const piece of raw.match(/.{1,7}/gs) ?? []) await stream.push(piece);
		await stream.finish();
		expect(chunks.join('')).toBe(quote);
		const parsed = parseTurnMemoryEnvelope(raw);
		expect(parsed.error).toBeNull();
		expect(mergeTurnMemoryUpdates(parsed.envelope!).items[0].location).toBe('Sansa');
		expect(TURN_MEMORY_MARKER).toBe('<turn_memory_update>');
	});

	it('falls back when the footer is absent or the quote is invented', () => {
		expect(parseTurnMemoryEnvelope('Visible prose.').error).toBe('missing_footer');
		const parsed = parseTurnMemoryEnvelope(`Visible prose.${TURN_MEMORY_MARKER}{"version":1,"changes":[{"kind":"event","quote":"An invented event happened.","visibility":"public","update":{}}]}</turn_memory_update>`);
		expect(parsed.narration).toBe('Visible prose.');
		expect(parsed.error).toBe('unsupported_quote');
	});
});
