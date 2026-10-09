import { describe, expect, it } from 'vitest';
import { formatNarrative } from '../narrativeHtml';

describe('formatNarrative', () => {
	it('wraps quoted dialogue in a single highlighted span', () => {
		const html = formatNarrative('The guard says, "Hold the gate." Then he waits.');

		expect(html).toContain('class="dialogue"');
		expect(html).toContain('&ldquo;Hold the gate.&rdquo;');
	});

	it('uses the same dialogue class for different speakers while retaining attribution', () => {
		const html = formatNarrative(
			'Ned said, "Hold."\n\n"Needle first," Arya whispered.\n\n"Who goes there?"',
			['Ned Stark', 'Arya Stark'],
		);

		expect(html).toContain('class="dialogue" data-speaker="Ned Stark" title="Ned Stark"');
		expect(html).toContain('class="dialogue" data-speaker="Arya Stark" title="Arya Stark"');
		expect((html.match(/class="dialogue"/g) ?? []).length).toBe(3);
		expect(html).not.toContain('dialogue-tone-');
	});

	it('detects speaker labels before quoted lines', () => {
		const html = formatNarrative('Tyrion Lannister: "I drink and I know things."', ['Tyrion Lannister']);

		expect(html).toContain('class="dialogue" data-speaker="Tyrion Lannister"');
	});

	it('handles curly smart quotes from model output', () => {
		const html = formatNarrative('Arya says, \u201cNeedle first.\u201d', ['Arya Stark']);

		expect(html).toContain('class="dialogue" data-speaker="Arya Stark"');
		expect(html).toContain('&ldquo;Needle first.&rdquo;');
	});

	it('escapes prose, dialogue, and dice descriptions before returning html', () => {
		const html = formatNarrative(
			'<img src=x onerror=alert(1)> "A <sharp> word."\n\n{{dice:1d20|12|14|10|pass|Stealth|<b>Quiet</b>}}',
		);

		expect(html).not.toContain('<img');
		expect(html).not.toContain('<sharp>');
		expect(html).not.toContain('<b>Quiet</b>');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).toContain('&ldquo;A &lt;sharp&gt; word.&rdquo;');
		expect(html).toContain('&lt;b&gt;Quiet&lt;/b&gt;');
	});
});
