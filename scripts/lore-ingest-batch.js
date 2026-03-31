#!/usr/bin/env node

/**
 * Lore Ingest — Batch Mode
 * Fetches pages one at a time, embeds, and upserts immediately.
 * No accumulation — each page is committed to Qdrant before moving to the next.
 */

import fs from 'fs';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const COLLECTION = process.env.COLLECTION || 'westeros_lore';

const WIKI_API = 'https://gameofthrones.fandom.com/api.php';
const WIKI_BASE = 'https://gameofthrones.fandom.com';

// ── Core pages to ingest — curated for ASOIAF RP relevance ──
const CORE_PAGES = [
	// Major Characters
	'Aegon Targaryen', 'Daenerys Targaryen', 'Jon Snow', 'Cersei Lannister',
	'Tyrion Lannister', 'Jaime Lannister', 'Sansa Stark', 'Arya Stark',
	'Bran Stark', 'Robb Stark', 'Eddard Stark', 'Catelyn Stark',
	'Robert Baratheon', 'Stannis Baratheon', 'Tywin Lannister',
	'Oberyn Martell', 'Petyr Baelish', 'Varys', 'Melisandre',
	'Davos Seaworth', 'Brienne of Tarth', 'Sandor Clegane', 'Theon Greyjoy',
	'Samwell Tarly', 'Margaery Tyrell', 'Olenna Tyrell',
	'Rhaegar Targaryen', 'Aerys Targaryen', 'Maegor Targaryen',
	'Jaehaerys Targaryen', 'Rhaenyra Targaryen', 'Daemon Targaryen',
	'Alicent Hightower', 'Viserys Targaryen (son of Aerys II)',
	'Daemon Blackfyre', 'Brynden Rivers', 'Aemon Targaryen',
	// Houses
	'House Targaryen', 'House Stark', 'House Lannister', 'House Baratheon',
	'House Tyrell', 'House Martell', 'House Greyjoy', 'House Arryn',
	'House Tully', 'House Bolton', 'House Frey', 'House Hightower',
	'House Velaryon',
	// Locations
	"King's Landing", 'Winterfell', 'The Wall', 'Castle Black',
	'Casterly Rock', 'Highgarden', 'Dragonstone', 'Harrenhal',
	'The Twins', 'Oldtown', 'Braavos', 'Valyria',
	'The Red Keep', 'The Iron Throne',
	// Events
	"Robert's Rebellion", 'Dance of the Dragons',
	'War of the Five Kings', 'Red Wedding',
	'Battle of the Blackwater', 'Doom of Valyria',
	// Lore
	'Faith of the Seven', 'The Old Gods', "Night's Watch", 'Kingsguard',
	'Small Council', 'Valyrian steel', 'Wildfire', 'Dragonglass',
	'White Walkers', 'Children of the Forest', 'Faceless Men',
	'Iron Bank of Braavos', 'Maesters', 'Warging', 'Greensight',
	'Dragon', 'Direwolf', 'Dothraki', 'Unsullied', 'Free Folk',
	'Guest right', 'Trial by combat',
];

// ── Helpers ──

async function embed(text) {
	const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: EMBED_MODEL, input: text }),
	});
	if (!resp.ok) throw new Error(`Embed failed: ${resp.status}`);
	const data = await resp.json();
	return data.embeddings?.[0] ?? data.embedding;
}

function chunkText(text, maxChars = 3000, overlap = 300) {
	if (text.length <= maxChars) return [text.trim()];
	const paragraphs = text.split(/\n\n+/);
	const chunks = [];
	let current = '';
	for (const para of paragraphs) {
		if (current.length + para.length + 2 > maxChars && current.length > 0) {
			chunks.push(current.trim());
			const words = current.split(/\s+/);
			const overlapWords = Math.floor(overlap / 5);
			current = words.slice(-overlapWords).join(' ') + '\n\n' + para;
		} else {
			current += (current ? '\n\n' : '') + para;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
}

function uuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
}

/**
 * Strip MediaWiki markup to plain text.
 * Handles templates, links, refs, HTML, tables, etc.
 */
function stripWikitext(text) {
	let s = text;
	// Remove everything before the first section or after infobox templates
	// Strip nested templates {{...}} — iterative for nesting
	for (let i = 0; i < 10; i++) {
		const prev = s;
		s = s.replace(/\{\{[^{}]*\}\}/g, '');
		if (s === prev) break;
	}
	// Strip remaining unclosed templates
	s = s.replace(/\{\{[^}]*$/gm, '');
	// Strip refs: <ref>...</ref> and <ref ... />
	s = s.replace(/<ref[^>]*\/>/gi, '');
	s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
	// Strip HTML tags
	s = s.replace(/<[^>]+>/g, '');
	// Convert wiki links [[Target|Display]] → Display, [[Target]] → Target
	s = s.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
	// Strip external links [url text] → text
	s = s.replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1');
	// Strip bold/italic markers
	s = s.replace(/'{2,5}/g, '');
	// Strip category links
	s = s.replace(/\[\[Category:[^\]]+\]\]/gi, '');
	// Strip file/image links
	s = s.replace(/\[\[(?:File|Image):[^\]]+\]\]/gi, '');
	// Strip tables {| ... |}
	s = s.replace(/\{\|[\s\S]*?\|\}/g, '');
	// Strip table row/cell markers
	s = s.replace(/^[|!].*$/gm, '');
	// Strip section headers to just text
	s = s.replace(/^=+\s*(.*?)\s*=+$/gm, '\n$1\n');
	// Strip bullet/number list markers (keep text)
	s = s.replace(/^[*#:;]+\s*/gm, '');
	// Collapse whitespace
	s = s.replace(/\n{3,}/g, '\n\n');
	s = s.replace(/[ \t]+/g, ' ');
	return s.trim();
}

function inferCategory(title, categories) {
	const cats = categories.join(' ').toLowerCase();
	const t = title.toLowerCase();
	if (cats.includes('house ') || t.startsWith('house ')) return 'house';
	if (cats.includes('characters') || cats.includes('people')) return 'character';
	if (cats.includes('castle') || cats.includes('cities') || cats.includes('places') || cats.includes('regions')) return 'location';
	if (cats.includes('battle') || cats.includes('war') || cats.includes('events')) return 'event';
	if (cats.includes('religion')) return 'religion';
	if (cats.includes('culture')) return 'culture';
	return 'general';
}

function extractTags(title, content) {
	const tags = new Set();
	tags.add(title.toLowerCase());

	const houseMatch = content.match(/House (\w+)/g);
	if (houseMatch) for (const h of houseMatch.slice(0, 5)) tags.add(h.toLowerCase());

	const regions = ['the north', 'the reach', 'the vale', 'the westerlands', 'the stormlands',
		'dorne', 'the riverlands', 'the crownlands', 'the iron islands', 'essos',
		"king's landing", 'winterfell', 'the wall', 'valyria'];
	for (const r of regions) {
		if (content.toLowerCase().includes(r)) tags.add(r);
	}

	return [...tags].slice(0, 10);
}

// ── Main ──

async function main() {
	console.log(`\n🐉 Lore Ingest — Batch Mode`);
	console.log(`   Collection: ${COLLECTION}`);
	console.log(`   Pages to process: ${CORE_PAGES.length}\n`);

	let totalChunks = 0;
	let pagesProcessed = 0;
	let pagesFailed = 0;

	for (let i = 0; i < CORE_PAGES.length; i++) {
		const title = CORE_PAGES[i];
		process.stdout.write(`[${i + 1}/${CORE_PAGES.length}] ${title}...`);

		try {
			// Search for exact page
			const searchParams = new URLSearchParams({
				action: 'query', list: 'search', srsearch: title,
				srlimit: '1', format: 'json',
			});
			const searchResp = await fetch(`${WIKI_API}?${searchParams}`);
			if (!searchResp.ok) { console.log(' ❌ search failed'); pagesFailed++; continue; }
			const searchData = await searchResp.json();
			const pageTitle = searchData.query?.search?.[0]?.title;
			if (!pageTitle) { console.log(' ❌ not found'); pagesFailed++; continue; }

			// Fetch content via revisions (Fandom wikis don't support TextExtracts)
			const pageParams = new URLSearchParams({
				action: 'query', titles: pageTitle,
				prop: 'revisions|categories',
				rvprop: 'content', rvlimit: '1', rvslots: 'main',
				cllimit: '20', format: 'json',
			});
			const pageResp = await fetch(`${WIKI_API}?${pageParams}`);
			if (!pageResp.ok) { console.log(' ❌ fetch failed'); pagesFailed++; continue; }
			const pageData = await pageResp.json();
			const page = Object.values(pageData.query?.pages ?? {})[0];
			const rawWikitext = page?.revisions?.[0]?.slots?.main?.['*'] ?? '';
			if (!page || page.missing !== undefined || rawWikitext.length < 200) {
				console.log(' ⏭️ stub/empty');
				pagesFailed++;
				continue;
			}

			// Strip wikitext to plain text
			const plainText = stripWikitext(rawWikitext);
			if (plainText.length < 100) {
				console.log(' ⏭️ stripped too short');
				pagesFailed++;
				continue;
			}

			const categories = (page.categories ?? []).map(c => c.title.replace('Category:', '').toLowerCase());
			const category = inferCategory(pageTitle, categories);
			const tags = extractTags(pageTitle, plainText);

			// Chunk
			const chunks = chunkText(plainText);

			// Embed & upsert each chunk
			const points = [];
			for (let ci = 0; ci < chunks.length; ci++) {
				const text = `${pageTitle}: ${chunks[ci]}`;
				const vector = await embed(text);
				points.push({
					id: uuid(),
					vector,
					payload: {
						content: chunks[ci],
						source: 'asoiaf-wiki',
						title: pageTitle,
						category,
						tags,
						url: `${WIKI_BASE}/wiki/${encodeURIComponent(pageTitle)}`,
						chunk_index: ci,
					},
				});
			}

			// Upsert batch
			const upsertResp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ points }),
			});

			if (upsertResp.ok) {
				totalChunks += chunks.length;
				pagesProcessed++;
				console.log(` ✅ ${chunks.length} chunks`);
			} else {
				console.log(` ❌ upsert failed: ${upsertResp.status}`);
				pagesFailed++;
			}

		} catch (e) {
			console.log(` ❌ ${e.message}`);
			pagesFailed++;
		}

		// Rate limit
		await new Promise(r => setTimeout(r, 300));
	}

	console.log(`\n${'═'.repeat(50)}`);
	console.log(`✅ Done!`);
	console.log(`   Pages processed: ${pagesProcessed}`);
	console.log(`   Pages failed: ${pagesFailed}`);
	console.log(`   Total chunks ingested: ${totalChunks}`);
	console.log(`   Collection: ${COLLECTION}`);
}

main().catch(e => {
	console.error(`\n❌ Fatal: ${e.message}`);
	process.exit(1);
});
