type Source = { kind: 'content' | 'content_type' | 'story_entry' | 'file'; id: string; revision: number | string; sourceRef?: string; sha256?: string; startLine?: number; endLine?: number; runId?: string };
type Observation = { tool: string; result: unknown };

type Evidence = Source & { text: string };

function sourceText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(sourceText).join(' ');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).filter(([key]) => !['id', 'revision', 'server_version'].includes(key))
    .map(([, item]) => sourceText(item)).join(' ');
}

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();

// Only material delivered in this run can become a source link. Older digests are leads to re-read.
export function observedAssistantSources(reply: string, context: unknown[], observations: Observation[]): Source[] {
  const sources = new Map<string, Evidence>();
  const add = (kind: Source['kind'], value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id || !Number.isInteger(row.revision) || Number(row.revision) < 1) return;
    sources.set(`${kind}:${row.id}`, { kind, id: row.id, revision: Number(row.revision), text: sourceText(row) });
  };
  for (const value of context) {
    const row = value as { kind?: Source['kind'] };
    if (row && (row.kind === 'content' || row.kind === 'story_entry')) add(row.kind, value);
  }
  for (const observation of observations) {
    const result = observation.result as Record<string, unknown> | null;
    if (!result) continue;
    if (observation.tool === 'read' && typeof result.sourceRef === 'string' && typeof result.text === 'string'
      && typeof result.sha256 === 'string' && typeof result.revision === 'string' && Number.isInteger(result.startLine) && Number.isInteger(result.endLine)) {
      sources.set(`file:${result.sourceRef}:${result.startLine}:${result.endLine}`, { kind: 'file', id: result.sourceRef, sourceRef: result.sourceRef,
        revision: result.revision, sha256: result.sha256, startLine: Number(result.startLine), endLine: Number(result.endLine), text: result.text });
      continue;
    }
    if (result.truncated === true) continue;
    if (observation.tool === 'read' || observation.tool === 'list') {
      if (Array.isArray(result.items)) for (const item of result.items) add('content', item);
      if (Array.isArray(result.types)) for (const type of result.types) add('content_type', type);
      if (typeof result.type_id === 'string') add('content', result);
      if (result.definition) add('content_type', result);
    }
    if (result.applied === true) {
      if (typeof result.itemId === 'string') add('content', { id: result.itemId, revision: result.afterRevision });
      if (typeof result.typeId === 'string') add('content_type', { id: result.typeId, revision: result.afterRevision });
    }
  }
  const cited = new Map<string, Source>();
  const citations = [
    ...reply.matchAll(/\[source:([a-zA-Z0-9][a-zA-Z0-9_%./:-]{0,1999})\]/g),
    ...reply.matchAll(/\*{0,2}source\s*id\*{0,2}:\*{0,2}\s*`?([a-zA-Z0-9][a-zA-Z0-9_./:-]{0,199})`?/gi),
  ];
  for (const match of citations) {
    const precedingQuote = reply.slice(Math.max(0, match.index - 450), match.index)
      .match(/(?:“([^”]{12,400})”|"([^"]{12,400})")\s*$/u);
    const quote = precedingQuote?.[1] ?? precedingQuote?.[2];
    const source = [...sources.values()].find(row => row.id === match[1] && row.text && quote && normalized(row.text).includes(normalized(quote)));
    if (!source || !quote || !normalized(source.text).includes(normalized(quote)))
      throw new Error(`Assistant source citation ${match[1]} lacks an exact observed quote.`);
    const { text: _text, ...reference } = source;
    cited.set(`${source.kind}:${source.id}:${source.startLine ?? ''}`, reference);
  }
  // Applied write receipts are authoritative for this run even though they have no source prose to quote.
  for (const observation of observations) {
    const result = observation.result as Record<string, unknown> | null;
    if (!result || result.applied !== true) continue;
    for (const [kind, id] of [['content', result.itemId], ['content_type', result.typeId]] as const) {
      if (typeof id !== 'string' || !reply.includes(id)) continue;
      const source = sources.get(`${kind}:${id}`);
      if (source) cited.set(`${kind}:${id}:`, { kind, id, revision: source.revision });
    }
  }
  return [...cited.values()].slice(0, 32);
}
