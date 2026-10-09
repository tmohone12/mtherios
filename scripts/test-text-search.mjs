import assert from 'node:assert/strict';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { databaseUrl } from './db-env.mjs';
import { englishTsQuery } from '../src/lib/server/db/textSearch.ts';

// Read-only integration check against the configured PostgreSQL dictionary.
const notices = [];
const client = postgres(databaseUrl(), { max: 1, prepare: false, onnotice: notice => notices.push(notice) });
const dialect = new PgDialect();
async function run(statement) {
	const query = dialect.sqlToQuery(statement);
	return client.unsafe(query.sql, query.params);
}

try {
	await client`select plainto_tsquery('english', 'through')`;
	assert.equal(notices.some(notice => notice.routine === 'cleanup_tsquery_stopwords'), true);
	notices.length = 0;

	for (const text of ['', '!!!', 'through', 'during', 'the and through']) {
		for (const mode of ['query', 'plain']) {
			const input = mode === 'query' ? text.split(' ').join(' | ') : text;
			const [row] = await run(sql`select ${englishTsQuery(input, mode)} as query`);
			assert.equal(row.query, null, `${mode}: ${text}`);
		}
	}
	const [matches] = await run(sql`select
		to_tsvector('english', 'dragon') @@ ${englishTsQuery('through | dragons | markets')} as any_match,
		to_tsvector('english', 'dragon') @@ ${englishTsQuery('through dragons markets', 'plain')} as all_match,
		to_tsvector('english', 'dragon market') @@ ${englishTsQuery('through dragons markets', 'plain')} as both_match,
		to_tsvector('english', 'harbor') @@ ${englishTsQuery('through | dragons | markets')} as unrelated_match`);
	assert.deepEqual({ ...matches }, { any_match: true, all_match: false, both_match: true, unrelated_match: false });

	const [rank] = await run(sql`select count(*)::int as score
		from unnest(array['through', 'during', 'dragons', 'markets']::text[]) as token
		where to_tsvector('english', 'dragon market') @@ ${englishTsQuery(sql`token`, 'plain')}`);
	assert.equal(rank.score, 2);
	assert.deepEqual(notices, []);
	console.log('Text search passed: empty queries, stemming, OR/AND matching and per-word ranking; zero notices.');
} finally {
	await client.end({ timeout: 1 });
}
