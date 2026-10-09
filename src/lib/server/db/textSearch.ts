import { sql, type SQL } from 'drizzle-orm';

/** Let PostgreSQL's dictionary decide whether a query has searchable words. */
export function englishTsQuery(input: string | SQL, mode: 'query' | 'plain' = 'query'): SQL {
	// Passing NULL avoids the notice emitted when a tsquery contains only stop
	// words. Keep the guard inside the parser argument, including for SQL tokens.
	const searchable = sql`case when length(to_tsvector('english', ${input})) > 0 then ${input} else null end`;
	return mode === 'plain'
		? sql`plainto_tsquery('english', ${searchable})`
		: sql`to_tsquery('english', ${searchable})`;
}
