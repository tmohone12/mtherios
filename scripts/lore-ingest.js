#!/usr/bin/env node

/**
 * Lore Ingestion Pipeline — Mtherios
 *
 * Universal lore ingestion into Qdrant vector DB.
 * Supports multiple source types:
 *   - AWOIAF wiki scraping (A Wiki of Ice and Fire)
 *   - Local text/markdown files
 *   - JSON lore dumps
 *
 * Usage:
 *   node scripts/lore-ingest.js scrape-awoiaf [--category houses|characters|locations|events|all] [--limit 100]
 *   node scripts/lore-ingest.js ingest-files <directory> --source "my-world" [--category character]
 *   node scripts/lore-ingest.js ingest-json <file.json> --source "my-world"
 *   node scripts/lore-ingest.js setup [--collection westeros_lore] [--dimension 768]
 *   node scripts/lore-ingest.js status
 *   node scripts/lore-ingest.js search "query text" [--limit 5]
 *   node scripts/lore-ingest.js nuke [--collection westeros_lore]  (delete all points)
 *
 * Environment:
 *   QDRANT_URL     — Qdrant endpoint (default: http://localhost:6333)
 *   OLLAMA_URL     — Ollama endpoint (default: http://localhost:11434)
 *   EMBED_MODEL    — Embedding model (default: nomic-embed-text)
 *   COLLECTION     — Qdrant collection name (default: westeros_lore)
 */

import fs from 'fs';
import path from 'path';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const DEFAULT_COLLECTION = process.env.COLLECTION || 'westeros_lore';

// ── Helpers ──

async function embed(text) {
	const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: EMBED_MODEL, input: text }),
	});
	if (!resp.ok) throw new Error(`Embedding failed: ${resp.status} ${await resp.text()}`);
	const data = await resp.json();
	return data.embeddings?.[0] ?? data.embedding;
}

async function embedBatch(texts, batchSize = 8) {
	const results = [];
	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize);
		const promises = batch.map(t => embed(t));
		const vectors = await Promise.all(promises);
		results.push(...vectors);
		if (i + batchSize < texts.length) {
			process.stdout.write(`  Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length}\r`);
		}
	}
	console.log(`  Embedded ${texts.length}/${texts.length}`);
	return results;
}

async function qdrantRequest(method, path, body) {
	const resp = await fetch(`${QDRANT_URL}${path}`, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Qdrant ${method} ${path}: ${resp.status} ${text}`);
	}
	return resp.json();
}

function chunkText(text, maxChars = 1500, overlap = 200) {
	const chunks = [];
	if (text.length <= maxChars) {
		chunks.push(text.trim());
		return chunks;
	}

	// Try to split on paragraph boundaries first
	const paragraphs = text.split(/\n\n+/);
	let current = '';

	for (const para of paragraphs) {
		if (current.length + para.length + 2 > maxChars && current.length > 0) {
			chunks.push(current.trim());
			// Overlap: keep last portion of current chunk
			const words = current.split(/\s+/);
			const overlapWords = Math.floor(overlap / 5); // ~5 chars per word
			current = words.slice(-overlapWords).join(' ') + '\n\n' + para;
		} else {
			current += (current ? '\n\n' : '') + para;
		}
	}

	if (current.trim()) {
		chunks.push(current.trim());
	}

	return chunks;
}

function generateId() {
	// UUID v4 compatible with Qdrant
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	});
}

// ── AWOIAF Scraper ──

// ── Wiki Sources ──
// AWOIAF is currently 403-blocked for API access.
// Primary source: Game of Thrones Fandom Wiki (MediaWiki API accessible).
// Approach: search-based discovery since Fandom uses non-standard categories.

const WIKI_SOURCES = {
	fandom: {
		base: 'https://gameofthrones.fandom.com',
		api: 'https://gameofthrones.fandom.com/api.php',
		label: 'GoT Fandom Wiki',
	},
	awoiaf: {
		base: 'https://awoiaf.westeros.org',
		api: 'https://awoiaf.westeros.org/api.php',
		label: 'AWOIAF',
	},
};

// Seed queries for discovering ASOIAF content by topic
const ASOIAF_SEED_QUERIES = {
	characters: [
		'Aegon Targaryen', 'Daenerys Targaryen', 'Jon Snow', 'Cersei Lannister',
		'Tyrion Lannister', 'Jaime Lannister', 'Sansa Stark', 'Arya Stark',
		'Bran Stark', 'Robb Stark', 'Eddard Stark', 'Catelyn Stark',
		'Robert Baratheon', 'Stannis Baratheon', 'Renly Baratheon',
		'Joffrey Baratheon', 'Tommen Baratheon', 'Myrcella Baratheon',
		'Tywin Lannister', 'Oberyn Martell', 'Doran Martell', 'Arianne Martell',
		'Petyr Baelish', 'Varys', 'Melisandre', 'Davos Seaworth',
		'Brienne of Tarth', 'Sandor Clegane', 'Gregor Clegane',
		'Theon Greyjoy', 'Euron Greyjoy', 'Balon Greyjoy', 'Asha Greyjoy',
		'Samwell Tarly', 'Margaery Tyrell', 'Olenna Tyrell', 'Loras Tyrell',
		'Rhaegar Targaryen', 'Viserys Targaryen', 'Aerys Targaryen',
		'Maegor Targaryen', 'Jaehaerys Targaryen', 'Aegon the Conqueror',
		'Bloodraven', 'Daemon Blackfyre', 'Bittersteel', 'Aemon Targaryen',
		'Rhaenyra Targaryen', 'Daemon Targaryen', 'Alicent Hightower',
		'Cregan Stark', 'Torrhen Stark', 'Brandon the Builder',
		'Mance Rayder', 'Tormund Giantsbane', "Night's King",
		'Khal Drogo', 'Illyrio Mopatis', 'Hizdahr zo Loraq',
	],
	houses: [
		'House Targaryen', 'House Stark', 'House Lannister', 'House Baratheon',
		'House Tyrell', 'House Martell', 'House Greyjoy', 'House Arryn',
		'House Tully', 'House Bolton', 'House Frey', 'House Hightower',
		'House Velaryon', 'House Blackfyre', 'House Dayne', 'House Reed',
		'House Mormont', 'House Karstark', 'House Umber', 'House Manderly',
		'House Clegane', 'House Tarly', 'House Redwyne', 'House Florent',
	],
	locations: [
		"King's Landing", 'Winterfell', 'The Wall', 'Castle Black',
		'Casterly Rock', 'Highgarden', 'Sunspear', 'Storm\'s End',
		'The Eyrie', 'Riverrun', 'Pyke', 'Dragonstone', 'Harrenhal',
		'The Twins', 'Oldtown', 'The Citadel', 'Braavos', 'Pentos',
		'Volantis', 'Meereen', 'Astapor', 'Yunkai', 'Valyria',
		'Asshai', 'Yi Ti', 'The Iron Throne', 'The Red Keep',
		'The Great Sept of Baelor', 'The Kingsroad', 'God\'s Eye',
		'Isle of Faces', 'Dreadfort', 'Horn Hill', 'Starfall',
		'The Neck', 'Moat Cailin', 'White Harbor', 'Bear Island',
	],
	events: [
		"Robert's Rebellion", 'The Dance of the Dragons', 'The Doom of Valyria',
		'Aegon\'s Conquest', 'The Blackfyre Rebellion', 'The War of the Five Kings',
		'Red Wedding', 'Battle of the Blackwater', 'The Long Night',
		'The Field of Fire', 'Battle of the Trident', 'Sack of King\'s Landing',
		'The Faith Militant uprising', 'The Great Council', 'Greyjoy Rebellion',
		'Battle of the Bastards', 'The Purple Wedding', 'Hardhome',
		'The Tourney at Harrenhal', 'The Tower of Joy',
	],
	lore: [
		'The Faith of the Seven', 'The Old Gods', 'R\'hllor', 'The Drowned God',
		'The Night\'s Watch', 'The Kingsguard', 'The Small Council',
		'Valyrian steel', 'Wildfire', 'Dragonglass', 'Weirwood',
		'White Walkers', 'Children of the Forest', 'Giants',
		'Faceless Men', 'Iron Bank of Braavos', 'The Golden Company',
		'Maesters', 'The Citadel', 'Greensight', 'Warging',
		'Dothraki', 'Unsullied', 'Ironborn', 'Free Folk',
		'The Doom of Valyria', 'Dragon', 'Direwolf',
		'Azor Ahai', 'The Prince That Was Promised', 'Lightbringer',
		'Trial by combat', 'Trial of seven', 'Guest right',
		'The Iron Throne succession', 'Bastard names in Westeros',
	],
};

async function searchWikiPages(wikiSource, query, limit = 10) {
	const params = new URLSearchParams({
		action: 'query',
		list: 'search',
		srsearch: query,
		srlimit: String(limit),
		format: 'json',
	});

	const resp = await fetch(`${wikiSource.api}?${params}`);
	if (!resp.ok) return [];
	const data = await resp.json();
	return data.query?.search ?? [];
}

async function fetchPageContent(wikiSource, title) {
	const params = new URLSearchParams({
		action: 'query',
		titles: title,
		prop: 'extracts|categories',
		explaintext: '1',
		exsectionformat: 'plain',
		cllimit: '20',
		format: 'json',
	});

	const resp = await fetch(`${wikiSource.api}?${params}`);
	if (!resp.ok) return null;
	const data = await resp.json();

	const pages = data.query?.pages;
	if (!pages) return null;

	const page = Object.values(pages)[0];
	if (!page || page.missing !== undefined) return null;

	const categories = (page.categories ?? []).map(c =>
		c.title.replace('Category:', '').toLowerCase()
	);

	return {
		title: page.title,
		content: page.extract ?? '',
		categories,
		url: `${wikiSource.base}/wiki/${encodeURIComponent(title)}`,
	};
}

function inferCategory(title, wikiCategories) {
	const cats = wikiCategories.join(' ').toLowerCase();
	const t = title.toLowerCase();

	if (cats.includes('house ') || t.startsWith('house ')) return 'house';
	if (cats.includes('characters') || cats.includes('people')) return 'character';
	if (cats.includes('castle') || cats.includes('cities') || cats.includes('places') || cats.includes('regions')) return 'location';
	if (cats.includes('battle') || cats.includes('war') || cats.includes('events')) return 'event';
	if (cats.includes('religion')) return 'religion';
	if (cats.includes('culture')) return 'culture';
	if (cats.includes('organization') || cats.includes('order')) return 'organization';
	if (cats.includes('weapon') || cats.includes('sword')) return 'weapon';
	if (cats.includes('ship')) return 'ship';
	if (cats.includes('animal') || cats.includes('dragon')) return 'creature';

	return 'general';
}

function extractTags(title, content, wikiCategories) {
	const tags = new Set();

	// From wiki categories
	for (const cat of wikiCategories) {
		const cleaned = cat.replace(/_/g, ' ').toLowerCase();
		if (cleaned.length < 30) tags.add(cleaned);
	}

	// Named entity extraction from title
	const titleWords = title.split(/\s+/);
	if (titleWords.length <= 4) tags.add(title.toLowerCase());

	// House detection
	const houseMatch = content.match(/House (\w+)/g);
	if (houseMatch) {
		for (const h of houseMatch.slice(0, 5)) {
			tags.add(h.toLowerCase());
		}
	}

	// Region detection
	const regions = ['the north', 'the reach', 'the vale', 'the westerlands', 'the stormlands',
		'dorne', 'the riverlands', 'the crownlands', 'the iron islands', 'essos',
		'braavos', "king's landing", 'winterfell', 'casterly rock', 'highgarden',
		'the wall', 'beyond the wall', 'valyria', 'old valyria'];
	for (const region of regions) {
		if (content.toLowerCase().includes(region)) tags.add(region);
	}

	return [...tags].slice(0, 15);
}

async function scrapeAWOIAF(categoryKey = 'all', limit = 500, collection = DEFAULT_COLLECTION) {
	const wiki = WIKI_SOURCES.fandom; // Primary source (AWOIAF API is 403-blocked)

	console.log(`\n🐉 Scraping ${wiki.label} — category: ${categoryKey}, limit: ${limit}`);
	console.log(`   Collection: ${collection}`);

	// Determine which seed query sets to use
	const availableCategories = Object.keys(ASOIAF_SEED_QUERIES);
	const categoriesToScrape = categoryKey === 'all'
		? availableCategories
		: [categoryKey];

	if (!availableCategories.includes(categoryKey) && categoryKey !== 'all') {
		console.error(`Unknown category: ${categoryKey}. Available: ${availableCategories.join(', ')}, all`);
		process.exit(1);
	}

	let allArticles = [];
	const seenTitles = new Set();

	for (const catKey of categoriesToScrape) {
		const seeds = ASOIAF_SEED_QUERIES[catKey];
		const perCatLimit = categoryKey === 'all' ? Math.ceil(limit / categoriesToScrape.length) : limit;

		console.log(`\n📂 Category: ${catKey} (${seeds.length} seed queries, limit: ${perCatLimit})`);
		let catArticles = 0;

		for (const seed of seeds) {
			if (catArticles >= perCatLimit) break;

			// Search for pages matching this seed
			const results = await searchWikiPages(wiki, seed, 3);

			for (const result of results) {
				if (seenTitles.has(result.title) || catArticles >= perCatLimit) continue;
				seenTitles.add(result.title);

				process.stdout.write(`   Fetching: ${result.title}                    \r`);

				const page = await fetchPageContent(wiki, result.title);
				if (!page || page.content.length < 100) continue;

				const category = inferCategory(page.title, page.categories);
				const tags = extractTags(page.title, page.content, page.categories);

				const chunks = chunkText(page.content);

				for (let ci = 0; ci < chunks.length; ci++) {
					allArticles.push({
						content: chunks[ci],
						metadata: {
							source: 'asoiaf-wiki',
							title: page.title,
							category,
							tags,
							url: page.url,
							chunk_index: ci,
						},
					});
				}

				catArticles++;
			}

			// Rate limit: be respectful
			await new Promise(r => setTimeout(r, 500));
		}
		console.log(`\n   Processed ${catKey}: ${catArticles} pages`);
	}

	console.log(`\n📊 Total chunks to ingest: ${allArticles.length}`);

	if (allArticles.length === 0) {
		console.log('Nothing to ingest.');
		return;
	}

	// Embed all chunks
	console.log('\n🧠 Generating embeddings...');
	const texts = allArticles.map(a => `${a.metadata.title}: ${a.content}`);
	const vectors = await embedBatch(texts);

	// Upsert into Qdrant
	console.log('\n📦 Upserting into Qdrant...');
	const batchSize = 100;
	for (let i = 0; i < allArticles.length; i += batchSize) {
		const batch = allArticles.slice(i, i + batchSize);
		const batchVectors = vectors.slice(i, i + batchSize);

		const points = batch.map((article, j) => ({
			id: generateId(),
			vector: batchVectors[j],
			payload: {
				content: article.content,
				...article.metadata,
			},
		}));

		await qdrantRequest('PUT', `/collections/${collection}/points`, { points });
		process.stdout.write(`  Upserted ${Math.min(i + batchSize, allArticles.length)}/${allArticles.length}\r`);
	}

	console.log(`\n\n✅ Done! Ingested ${allArticles.length} chunks into ${collection}`);
}

// ── File Ingestion ──

async function ingestFiles(directory, source, category = 'general', collection = DEFAULT_COLLECTION) {
	console.log(`\n📁 Ingesting files from: ${directory}`);
	console.log(`   Source: ${source}, Category: ${category}, Collection: ${collection}`);

	const files = fs.readdirSync(directory).filter(f =>
		f.endsWith('.txt') || f.endsWith('.md') || f.endsWith('.markdown')
	);

	if (files.length === 0) {
		console.log('No .txt or .md files found.');
		return;
	}

	console.log(`   Found ${files.length} files`);

	const allChunks = [];

	for (const file of files) {
		const content = fs.readFileSync(path.join(directory, file), 'utf-8');
		const title = path.basename(file, path.extname(file)).replace(/[-_]/g, ' ');

		const chunks = chunkText(content);
		for (let ci = 0; ci < chunks.length; ci++) {
			allChunks.push({
				content: chunks[ci],
				metadata: {
					source,
					title,
					category,
					tags: [source],
					chunk_index: ci,
				},
			});
		}
	}

	console.log(`📊 Total chunks: ${allChunks.length}`);

	// Embed
	console.log('\n🧠 Generating embeddings...');
	const texts = allChunks.map(c => `${c.metadata.title}: ${c.content}`);
	const vectors = await embedBatch(texts);

	// Upsert
	console.log('\n📦 Upserting into Qdrant...');
	const batchSize = 100;
	for (let i = 0; i < allChunks.length; i += batchSize) {
		const batch = allChunks.slice(i, i + batchSize);
		const batchVectors = vectors.slice(i, i + batchSize);

		const points = batch.map((chunk, j) => ({
			id: generateId(),
			vector: batchVectors[j],
			payload: {
				content: chunk.content,
				...chunk.metadata,
			},
		}));

		await qdrantRequest('PUT', `/collections/${collection}/points`, { points });
	}

	console.log(`\n✅ Ingested ${allChunks.length} chunks from ${files.length} files`);
}

// ── JSON Ingestion ──

async function ingestJSON(filePath, source, collection = DEFAULT_COLLECTION) {
	console.log(`\n📄 Ingesting JSON: ${filePath}`);

	const raw = fs.readFileSync(filePath, 'utf-8');
	const data = JSON.parse(raw);

	// Expected format: array of { title, content, category?, tags? }
	// Or: { entries: [...] }
	const entries = Array.isArray(data) ? data : data.entries ?? [];

	if (entries.length === 0) {
		console.log('No entries found in JSON.');
		return;
	}

	const allChunks = [];

	for (const entry of entries) {
		const title = entry.title || entry.name || 'Untitled';
		const content = entry.content || entry.description || entry.text || '';
		const category = entry.category || entry.type || 'general';
		const tags = entry.tags || entry.keywords || [source];

		if (!content || content.length < 20) continue;

		const chunks = chunkText(content);
		for (let ci = 0; ci < chunks.length; ci++) {
			allChunks.push({
				content: chunks[ci],
				metadata: {
					source: source || entry.source || 'json-import',
					title,
					category,
					tags: Array.isArray(tags) ? tags : [tags],
					chunk_index: ci,
				},
			});
		}
	}

	console.log(`📊 Total chunks: ${allChunks.length}`);

	// Embed
	console.log('\n🧠 Generating embeddings...');
	const texts = allChunks.map(c => `${c.metadata.title}: ${c.content}`);
	const vectors = await embedBatch(texts);

	// Upsert
	console.log('\n📦 Upserting into Qdrant...');
	const batchSize = 100;
	for (let i = 0; i < allChunks.length; i += batchSize) {
		const batch = allChunks.slice(i, i + batchSize);
		const batchVectors = vectors.slice(i, i + batchSize);

		const points = batch.map((chunk, j) => ({
			id: generateId(),
			vector: batchVectors[j],
			payload: {
				content: chunk.content,
				...chunk.metadata,
			},
		}));

		await qdrantRequest('PUT', `/collections/${collection}/points`, { points });
	}

	console.log(`\n✅ Ingested ${allChunks.length} chunks from JSON`);
}

// ── Setup / Status / Search ──

async function setup(collection = DEFAULT_COLLECTION, dimension = 768) {
	console.log(`\n🔧 Setting up collection: ${collection} (dim: ${dimension})`);

	// Check if collection exists
	try {
		const resp = await fetch(`${QDRANT_URL}/collections/${collection}`);
		if (resp.ok) {
			const data = await resp.json();
			console.log(`   Collection already exists: ${data.result?.points_count ?? 0} points`);
			return;
		}
	} catch { /* doesn't exist, create it */ }

	// Detect embedding dimension
	console.log('   Detecting embedding dimension...');
	try {
		const testVec = await embed('test');
		dimension = testVec.length;
		console.log(`   Detected dimension: ${dimension}`);
	} catch (e) {
		console.log(`   Could not detect dimension, using default: ${dimension}`);
	}

	// Create collection
	await qdrantRequest('PUT', `/collections/${collection}`, {
		vectors: {
			size: dimension,
			distance: 'Cosine',
		},
		optimizers_config: {
			indexing_threshold: 0, // index immediately for small collections
		},
	});

	// Create payload indices for filtering
	await qdrantRequest('PUT', `/collections/${collection}/index`, {
		field_name: 'source',
		field_schema: 'keyword',
	});
	await qdrantRequest('PUT', `/collections/${collection}/index`, {
		field_name: 'category',
		field_schema: 'keyword',
	});
	await qdrantRequest('PUT', `/collections/${collection}/index`, {
		field_name: 'tags',
		field_schema: 'keyword',
	});
	await qdrantRequest('PUT', `/collections/${collection}/index`, {
		field_name: 'title',
		field_schema: 'keyword',
	});

	console.log(`\n✅ Collection ${collection} created with payload indices`);
}

async function status(collection = DEFAULT_COLLECTION) {
	console.log('\n📊 Lore RAG Status\n');

	// Qdrant
	try {
		const resp = await fetch(`${QDRANT_URL}/collections`);
		const data = await resp.json();
		const collections = data.result?.collections ?? [];
		console.log(`Qdrant: ✅ (${collections.length} collections)`);

		for (const col of collections) {
			const colResp = await fetch(`${QDRANT_URL}/collections/${col.name}`);
			const colData = await colResp.json();
			const count = colData.result?.points_count ?? 0;
			const marker = col.name === collection ? ' ← active' : '';
			console.log(`  📚 ${col.name}: ${count} points${marker}`);
		}
	} catch (e) {
		console.log(`Qdrant: ❌ (${e.message})`);
	}

	// Ollama
	try {
		const resp = await fetch(`${OLLAMA_URL}/api/tags`);
		const data = await resp.json();
		const models = (data.models ?? []).map(m => m.name);
		const hasEmbed = models.some(m => m.includes(EMBED_MODEL));
		console.log(`\nOllama: ✅ (${models.length} models)`);
		console.log(`  Embed model (${EMBED_MODEL}): ${hasEmbed ? '✅' : '❌ not found'}`);
	} catch (e) {
		console.log(`\nOllama: ❌ (${e.message})`);
	}
}

async function search(query, limit = 5, collection = DEFAULT_COLLECTION) {
	console.log(`\n🔍 Searching: "${query}" (limit: ${limit})\n`);

	const vector = await embed(query);

	const data = await qdrantRequest('POST', `/collections/${collection}/points/search`, {
		vector,
		limit,
		with_payload: true,
	});

	const results = data.result ?? [];
	if (results.length === 0) {
		console.log('No results found.');
		return;
	}

	for (const point of results) {
		const p = point.payload;
		const score = point.score.toFixed(3);
		const preview = (p.content ?? '').slice(0, 200).replace(/\n/g, ' ');
		console.log(`[${score}] ${p.title} (${p.category}) — ${p.source}`);
		console.log(`  ${preview}...`);
		if (p.tags?.length) console.log(`  Tags: ${p.tags.join(', ')}`);
		console.log();
	}
}

async function nuke(collection = DEFAULT_COLLECTION) {
	console.log(`\n💀 Deleting collection: ${collection}`);
	try {
		await qdrantRequest('DELETE', `/collections/${collection}`);
		console.log('✅ Collection deleted');
	} catch (e) {
		console.log(`❌ ${e.message}`);
	}
}

// ── CLI ──

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	function getArg(name, fallback = '') {
		const idx = args.indexOf(`--${name}`);
		return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
	}

	switch (command) {
		case 'setup':
			await setup(
				getArg('collection', DEFAULT_COLLECTION),
				parseInt(getArg('dimension', '768')),
			);
			break;

		case 'scrape-awoiaf':
			await setup(getArg('collection', DEFAULT_COLLECTION));
			await scrapeAWOIAF(
				getArg('category', 'all'),
				parseInt(getArg('limit', '500')),
				getArg('collection', DEFAULT_COLLECTION),
			);
			break;

		case 'ingest-files':
			if (!args[1] || args[1].startsWith('--')) {
				console.error('Usage: lore-ingest.js ingest-files <directory> --source "name" [--category type]');
				process.exit(1);
			}
			await setup(getArg('collection', DEFAULT_COLLECTION));
			await ingestFiles(
				args[1],
				getArg('source', 'custom'),
				getArg('category', 'general'),
				getArg('collection', DEFAULT_COLLECTION),
			);
			break;

		case 'ingest-json':
			if (!args[1] || args[1].startsWith('--')) {
				console.error('Usage: lore-ingest.js ingest-json <file.json> --source "name"');
				process.exit(1);
			}
			await setup(getArg('collection', DEFAULT_COLLECTION));
			await ingestJSON(
				args[1],
				getArg('source', 'json-import'),
				getArg('collection', DEFAULT_COLLECTION),
			);
			break;

		case 'status':
			await status(getArg('collection', DEFAULT_COLLECTION));
			break;

		case 'search':
			if (!args[1] || args[1].startsWith('--')) {
				console.error('Usage: lore-ingest.js search "query" [--limit 5]');
				process.exit(1);
			}
			await search(
				args[1],
				parseInt(getArg('limit', '5')),
				getArg('collection', DEFAULT_COLLECTION),
			);
			break;

		case 'nuke':
			await nuke(getArg('collection', DEFAULT_COLLECTION));
			break;

		default:
			console.log(`
Mtherios Lore Ingestion Pipeline
================================

Commands:
  setup                          Create Qdrant collection with indices
  scrape-awoiaf                  Scrape A Wiki of Ice and Fire
  ingest-files <dir>             Ingest .txt/.md files from a directory
  ingest-json <file>             Ingest from JSON array
  status                         Show Qdrant + Ollama status
  search "query"                 Test search against the collection
  nuke                           Delete the collection entirely

Options:
  --collection <name>            Qdrant collection (default: ${DEFAULT_COLLECTION})
  --category <type>              Filter: characters|houses|locations|events|all
  --limit <n>                    Max items to process
  --source <name>                Source label for ingested data
  --dimension <n>                Vector dimension (auto-detected)

Examples:
  node scripts/lore-ingest.js setup
  node scripts/lore-ingest.js scrape-awoiaf --category characters --limit 100
  node scripts/lore-ingest.js scrape-awoiaf --category all --limit 500
  node scripts/lore-ingest.js ingest-files ./my-lore --source "forgotten-realms" --category location
  node scripts/lore-ingest.js ingest-json ./lore-dump.json --source "custom-world"
  node scripts/lore-ingest.js search "Blackfyre Rebellion"
  node scripts/lore-ingest.js status
			`);
	}
}

main().catch(e => {
	console.error('\n❌ Fatal error:', e.message);
	process.exit(1);
});
