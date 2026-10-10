import { countTokens, truncateToTokenBudget } from '$lib/utils/tokens';

const EVIDENCE_TOKENS = 4096;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const reference = (v: unknown) => typeof v === 'string' && v.length <= 240 ? v : undefined;
const refs = (v: unknown) => Array.isArray(v) ? v.filter(reference).slice(0, 8) : [];

/** The canonical retrieval packet is evidence. Raw nodes and ranking traces are inspection artifacts. */
export function memoryRecallEvidence(value: unknown): { content: string; sourceRefs: Array<Record<string, unknown>> } | null {
  const raw = object(value);
  if (typeof raw.packet !== 'string' || typeof raw.storyId !== 'string' || !Array.isArray(raw.nodes)
    || !Array.isArray(raw.renderedItems)) return null;
  const items = raw.renderedItems.map(object).filter(item => reference(item.id) && typeof item.text === 'string');
  const selected = new Set(items.map(item => item.id));
  const sourceRefs = raw.nodes.map(object).filter(node => selected.has(node.id)).slice(0, 16).map(node => {
    const metadata = object(node.metadata);
    return {
      nodeId: node.id, sourceId: node.id, visibility: reference(node.visibility),
      sourceEntryIds: refs(node.sourceEntryIds), sourceEventIds: refs(node.sourceEventIds), sourcePatchIds: refs(node.sourcePatchIds),
      ...(Number.isInteger(metadata.sourcePosition) ? { sourcePosition: metadata.sourcePosition } : {}),
      ...(reference(metadata.sourceHash) ? { sourceHash: metadata.sourceHash } : {}),
      ...(reference(node.updatedAt) ? { updatedAt: node.updatedAt } : {}),
      ...(Number.isInteger(node.serverVersion) ? { revision: node.serverVersion } : {}),
      ...(reference(metadata.believerEntityId) ? { beliefOwnerEntityId: metadata.believerEntityId } : {}),
      sourceEntryCount: Array.isArray(node.sourceEntryIds) ? node.sourceEntryIds.length : 0,
    };
  });
  const envelope = {
    storyId: raw.storyId, evidenceType: 'scoped_memory_recall', sourceRefs,
    notice: 'Source-linked evidence, not new canon or NPC knowledge. Raw nodes and retrieval diagnostics remain in the durable tool receipt. Use a source entry ID with world.record.get (type: transcript, recordId: sourceEntryId), or sourcePosition with campaign.entriesAround, for exact transcript evidence. Omitted or partial evidence must be reread before claiming its details.',
  };
  // Preserve the complete already-bounded retrieval packet whenever it fits. Do not summarize quotes.
  let packet = raw.packet;
  let partial = false;
  if (countTokens(JSON.stringify({ ...envelope, packet, partial })) > EVIDENCE_TOKENS) {
    const allowance = Math.max(0, EVIDENCE_TOKENS - countTokens(JSON.stringify(envelope)) - 96);
    packet = truncateToTokenBudget(packet, allowance);
    partial = true;
  }
  const content = JSON.stringify({ ...envelope, packet, partial });
  // Conservative envelope guard for malformed/provider-independent oversized records.
  if (countTokens(content) > EVIDENCE_TOKENS) {
    const first = sourceRefs[0];
    const minimalRefs = first ? [{ nodeId: first.nodeId, sourceEntryIds: refs(first.sourceEntryIds).slice(0, 1),
      ...(Number.isInteger(first.sourcePosition) ? { sourcePosition: first.sourcePosition } : {}) }] : [];
    return {
      content: JSON.stringify({ evidenceType: 'scoped_memory_recall', packet: '', partial: true, sourceRefs: minimalRefs,
        notice: 'This evidence exceeds the request allowance. Read the referenced source before claiming its contents.' }),
      sourceRefs: minimalRefs,
    };
  }
  return { content, sourceRefs };
}
