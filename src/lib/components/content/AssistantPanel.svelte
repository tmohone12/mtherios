<script lang="ts">
  import { onMount } from 'svelte';
  import { postEngineCommand } from '$lib/services/backendMemory';
  import PrivateImagePreview from './PrivateImagePreview.svelte';
  import { imageUsageCostLabel } from '$lib/utils/imageUsage';

  type Conversation = { id: string; title: string; project_id: string; game_id: string | null };
  type Usage = { model?: string | null; totalTokens?: number | null; providerCostUsd?: number | null; estimatedCostUsd?: number | null; attemptedCalls?: number; completedCalls?: number; unaccountedCalls?: number };
  type Message = { id: string; role: 'user' | 'assistant' | 'tool'; content: string; status: string; source_refs: Array<{ kind: string; id: string; revision: number }>; usage: Usage | null };
  type ToolCard = { run_id: string; call_id: string; tool: string; status: string; result: { applied?: boolean; itemId?: string; typeId?: string; title?: string; beforeRevision?: number | null; afterRevision?: number; changedFields?: string[]; jobId?: string; batchId?: string; targetCount?: number; childCount?: number; status?: string; operation?: string; path?: string; from?: string; to?: string; total?: number; counts?: { folders: number; documents: number; canonical: number } } | null; error: string | null; job_status: string | null; job_error: string | null; image_result: { assetId?: string; applied?: boolean; url?: string; reason?: string } | null; image_usage: { total_tokens?: number; totalTokens?: number; cost?: number; costUsd?: number; cost_usd?: number; estimatedCostUsd?: number } | null };
  type BatchTarget = { item_id: string; status: string; expected_revision: number; committed_revision: number | null; result: { changedFields?: string[]; reason?: string } | null; error: string | null };
  type BatchChild = { id: string; ordinal: number; status: string; usage: Usage | null; error: string | null; started_at: string | null; finished_at: string | null; targets: BatchTarget[] };
  type Batch = { id: string; run_id: string; user_message_id: string; status: string; model: string; objective: string; budget?: { maxCostUsd: number }; usage: Usage; finalReport?: string | null; reportSources?: Array<{ kind: string; id: string; revision: number }>; children: BatchChild[] };
  type CostBreakdown = { userMessageId: string; assistant: Usage; subagents: Usage; images: { requests: number; completed: number; providerCostUsd: number | null; estimatedCostUsd: number | null } };
  type Question = { id: string; run_id: string; prompt: string; options: Array<{ id: string; label: string }>; allow_custom: boolean; status: string; response: { optionId?: string; label?: string; text?: string } | null; revision: number };
  type Approval = { id: string; run_id: string; kind: 'restore' | 'layout_clear'; request: { targetKind?: 'item' | 'type'; id: string; targetRevision?: number }; preview: { title?: string; currentRevision: number; targetRevision?: number; affectedDocuments?: number; impact?: { total: number; inherited: number; estimatedTokens: number }; compatible: boolean; conflicts: Array<string | { title: string; error: string }>; changes: Array<{ field: string; from: unknown; to: unknown }> }; status: string; revision: number };
  type Snapshot = { conversation: Conversation; messages: Message[]; run: { id: string; status: string; error: string | null; usage: Usage } | null; tools: ToolCard[]; questions: Question[]; approvals: Approval[]; batches: Batch[]; costBreakdowns?: CostBreakdown[] };

  let { projectId, gameId, authoringDirty = false, onClose, onOpenStoryEntry }: { projectId: string; gameId: string; authoringDirty?: boolean; onClose: () => void; onOpenStoryEntry?: (id: string) => void } = $props();
  let conversations = $state<Conversation[]>([]);
  let selectedId = $state('');
  let snapshot = $state<Snapshot | null>(null);
  let draft = $state('');
  let busy = $state(false);
  let error = $state('');
  let customAnswer = $state('');
  let closeButton: HTMLButtonElement;
  let returnFocus: HTMLElement | null = null;
  let loadVersion = 0;
  const scopeKey = $derived(`${projectId}:${gameId}`);
  const args = () => ({ projectId, ...(gameId ? { gameId } : {}) });
  const command = (name: string, data: Record<string, unknown>) => postEngineCommand(gameId || '__app__', name, data);

  onMount(() => {
    returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    closeButton.focus();
  });

  function close() {
    onClose();
    requestAnimationFrame(() => {
      const fallback = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="Open Assistant"], button[aria-label="Open story actions"]'))
        .find(button => button.getClientRects().length > 0);
      (returnFocus?.isConnected ? returnFocus : fallback)?.focus();
    });
  }

  async function load() {
    const version = ++loadVersion;
    const key = scopeKey;
    const scope = args();
    const storyId = gameId || '__app__';
    error = '';
    try {
      const rows = await postEngineCommand(storyId, 'assistant.conversation.list', scope) as Conversation[];
      if (version !== loadVersion || key !== scopeKey) return;
      conversations = rows;
      const id = rows.some(row => row.id === selectedId) ? selectedId : rows[0]?.id ?? '';
      selectedId = id;
      const value = id ? await postEngineCommand(storyId, 'assistant.conversation.read', { ...scope, conversationId: id }) as Snapshot : null;
      if (version === loadVersion && key === scopeKey) snapshot = value;
    } catch (cause) {
      if (version === loadVersion) error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  $effect(() => {
    if (!scopeKey) return;
    selectedId = '';
    snapshot = null;
    draft = '';
    error = '';
    busy = false;
    void load();
    return () => { loadVersion += 1; };
  });

  $effect(() => {
    if (snapshot?.run?.status !== 'running' && snapshot?.run?.status !== 'committing' && !snapshot?.tools?.some(tool => tool.job_status && ['queued', 'retry', 'running'].includes(tool.job_status)) && !snapshot?.batches?.some(batch => batch.status === 'running')) return;
    const id = snapshot.conversation.id;
    const key = scopeKey;
    const scope = args();
    const storyId = gameId || '__app__';
    const timer = setTimeout(() => {
      void postEngineCommand(storyId, 'assistant.conversation.read', { ...scope, conversationId: id })
        .then(value => { if (key === scopeKey && selectedId === id) snapshot = value as Snapshot; })
        .catch(cause => { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); });
    }, 2_000);
    return () => clearTimeout(timer);
  });

  async function create() {
    if (busy) return;
    busy = true; error = '';
    const key = scopeKey;
    try {
      const value = await command('assistant.conversation.create', args()) as Snapshot;
      if (key !== scopeKey) return;
      selectedId = value.conversation.id;
      snapshot = value;
      conversations = [value.conversation, ...conversations];
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }

  async function select(id: string) {
    selectedId = id; snapshot = null; error = '';
    const key = scopeKey;
    try {
      const value = await command('assistant.conversation.read', { ...args(), conversationId: id }) as Snapshot;
      if (key === scopeKey && selectedId === id) snapshot = value;
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
  }

  async function send() {
    const content = draft.trim();
    if (!content || busy || authoringDirty) return;
    const key = scopeKey;
    busy = true; error = '';
    try {
      let id = selectedId;
      if (!id) {
        const created = await command('assistant.conversation.create', args()) as Snapshot;
        if (key !== scopeKey) return;
        id = created.conversation.id;
        selectedId = id;
        snapshot = created;
        conversations = [created.conversation, ...conversations];
      }
      draft = '';
      const scope = args();
      const storyId = gameId || '__app__';
      const request = postEngineCommand(storyId, 'assistant.message.send', { ...scope, conversationId: id, clientMessageId: `assistant_user_${crypto.randomUUID()}`, content });
      setTimeout(() => { if (key === scopeKey && selectedId === id) void select(id); }, 500);
      const value = await request as Snapshot;
      if (key === scopeKey && selectedId === id) {
        snapshot = value;
        conversations = conversations.map(row => row.id === id ? value.conversation : row);
      }
    } catch (cause) {
      if (key === scopeKey) { draft = content; error = cause instanceof Error ? cause.message : String(cause); }
    } finally { busy = false; }
  }

  async function cancel() {
    const id = selectedId;
    const runId = snapshot?.run?.id;
    if (!id || !runId) return;
    const key = scopeKey;
    try {
      const value = await command('assistant.run.cancel', { ...args(), conversationId: id, runId }) as Snapshot;
      if (key === scopeKey && selectedId === id) snapshot = value;
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
  }

  async function cancelBatch(batchId: string) {
    const id = selectedId;
    if (!id) return;
    const key = scopeKey;
    try {
      const value = await command('assistant.batch.cancel', { ...args(), conversationId: id, batchId }) as Snapshot;
      if (key === scopeKey && selectedId === id) snapshot = value;
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
  }

  async function answer(question: Question, response: { optionId?: string; text?: string }) {
    if (busy || !selectedId) return;
    const key = scopeKey;
    const id = selectedId;
    busy = true; error = '';
    try {
      const pending = command('assistant.question.answer', { ...args(), conversationId: id, runId: question.run_id, questionId: question.id, expectedRevision: question.revision, response });
      setTimeout(() => { if (key === scopeKey && selectedId === id) void select(id); }, 500);
      const value = await pending as Snapshot;
      if (key === scopeKey && selectedId === id) { snapshot = value; customAnswer = ''; }
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }

  async function reviewApproval(approval: Approval, decision: 'approve' | 'decline') {
    if (busy || !selectedId) return;
    if (decision === 'approve' && authoringDirty) { error = 'Save or discard your editor changes before approving this change.'; return; }
    const key = scopeKey;
    const id = selectedId;
    busy = true; error = '';
    try {
      const pending = command('assistant.approval.review', { ...args(), conversationId: id, runId: approval.run_id, approvalId: approval.id, expectedRevision: approval.revision, decision });
      setTimeout(() => {
        if (key !== scopeKey || selectedId !== id) return;
        void command('assistant.conversation.read', { ...args(), conversationId: id })
          .then(value => { if (key === scopeKey && selectedId === id) snapshot = value as Snapshot; })
          .catch(() => {});
      }, 500);
      const value = await pending as Snapshot;
      if (key === scopeKey && selectedId === id) snapshot = value;
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }

  function sourceUrl(source: Message['source_refs'][number]) {
    if (source.kind !== 'content' && source.kind !== 'content_type') return null;
    const params = new URLSearchParams({ project: projectId, source: `${source.kind === 'content_type' ? 'content-type' : 'content'}:${source.id}@${source.revision}` });
    if (gameId) params.set('game', gameId);
    return `/?${params}`;
  }

  function costLabel(usage: Usage) {
    if (usage.attemptedCalls === 0) return 'no provider cost';
    if (usage.providerCostUsd != null && usage.estimatedCostUsd != null) return `provider-reported ${usage.providerCostUsd} USD · conservative estimate ${usage.estimatedCostUsd} USD`;
    if (usage.providerCostUsd != null) return `provider-reported ${usage.providerCostUsd} USD`;
    if (usage.estimatedCostUsd != null) return `conservative estimate ${usage.estimatedCostUsd} USD`;
    return 'cost unknown';
  }


  function batchCount(batch: Batch, status: string) {
    return batch.children.reduce((total, child) => total + child.targets.filter(target => target.status === status).length, 0);
  }
</script>

<div class="assistant-panel" role="dialog" aria-modal="false" aria-labelledby="assistant-title" tabindex="-1" onkeydown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
  <header><div><h2 id="assistant-title">Assistant</h2><p>{gameId ? `This game · ${gameId}` : `Shared project · ${projectId}`}</p></div><button bind:this={closeButton} onclick={close} aria-label="Close Assistant">Close</button></header>
  <div class="conversation-picker"><label for="assistant-conversation">Conversation</label><select id="assistant-conversation" value={selectedId} onchange={event => { if (event.currentTarget.value) void select(event.currentTarget.value); else { selectedId = ''; snapshot = null; } }} disabled={busy}><option value="">Choose conversation</option>{#each conversations as conversation}<option value={conversation.id}>{conversation.title}</option>{/each}</select><button onclick={create} disabled={busy}>New</button></div>
  <div class="messages" role="log" aria-label="Assistant messages">
    {#if !snapshot}<p>Select or start a conversation in this scope.</p>{/if}
    {#each snapshot?.messages ?? [] as message (message.id)}
      {#if !message.id.startsWith('assistant_batch_report_') || !snapshot?.batches?.some(batch => `assistant_batch_report_${batch.id}` === message.id)}
      <article class:user={message.role === 'user'}><strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>{#if message.status === 'failed'}<small role="alert">Invalidated reply</small>{/if}<p>{message.content}</p>
        {#if message.role === 'assistant' && message.usage}{@const calls = message.usage.attemptedCalls ?? message.usage.completedCalls ?? 1}<small>{message.usage.model ?? 'Model'} · {message.usage.totalTokens ?? 'unknown'} tokens · {calls} provider {calls === 1 ? 'call' : 'calls'} · {costLabel(message.usage)}</small>{/if}
        {#if message.role === 'assistant' && message.source_refs?.length}<details><summary>Context sources</summary>{#each message.source_refs as source}{@const url = sourceUrl(source)}{#if url}<a href={url} data-sveltekit-reload>{source.id} · revision {source.revision}</a>{:else if source.kind === 'story_entry' && onOpenStoryEntry}<button class="source-link" onclick={() => onOpenStoryEntry?.(source.id)}>Open story source {source.id} · version {source.revision}</button>{:else}<span>{source.id} · version {source.revision}</span>{/if}{/each}</details>{/if}
        {#if message.role === 'user'}{@const breakdown = snapshot?.costBreakdowns?.find(row => row.userMessageId === message.id)}
          {#if breakdown}<details><summary>Cost breakdown</summary>
            <small>Assistant · {breakdown.assistant.attemptedCalls ?? 0} provider calls · {breakdown.assistant.totalTokens ?? 'unknown'} tokens · {costLabel(breakdown.assistant)}</small>
            <small>Subagents · {breakdown.subagents.attemptedCalls ?? 0} provider calls · {breakdown.subagents.totalTokens ?? 'unknown'} tokens · {costLabel(breakdown.subagents)}</small>
            <small>Images · {breakdown.images.requests} requested · {breakdown.images.completed} completed · {breakdown.images.requests ? imageUsageCostLabel({ costUsd: breakdown.images.providerCostUsd, estimatedCostUsd: breakdown.images.estimatedCostUsd }) : 'no image cost'}</small>
          </details>{/if}
          {#each snapshot?.batches?.filter(batch => batch.user_message_id === message.id) ?? [] as batch (batch.id)}
          <section class="batch-card" aria-label="Assistant batch progress"><strong>Subagents · {batch.status}</strong><p>{batch.objective}</p>
            <small>{batchCount(batch, 'applied')} applied · {batchCount(batch, 'conflict')} conflicted · {batchCount(batch, 'failed')} failed · {batchCount(batch, 'skipped')} skipped · {batchCount(batch, 'cancelled')} cancelled · {batchCount(batch, 'pending') + batchCount(batch, 'running')} pending</small>
            <small>{batch.model} · {batch.usage.totalTokens ?? 'unknown'} tokens · {costLabel(batch.usage)}{#if batch.budget?.maxCostUsd != null}{' · cap $'}{batch.budget.maxCostUsd}{/if}</small>
            {#if batch.finalReport}<p><strong>Final report</strong> · {batch.finalReport}</p>{#if batch.reportSources?.length}<details><summary>Spot-check sources</summary>{#each batch.reportSources as source}{@const url = sourceUrl(source)}{#if url}<a href={url} data-sveltekit-reload>{source.id} · revision {source.revision}</a>{:else}<span>{source.id} · revision {source.revision}</span>{/if}{/each}</details>{/if}{/if}
            {#if batch.status === 'running' || batch.status === 'planned'}<button onclick={() => cancelBatch(batch.id)}>Stop batch</button>{/if}
            {#each batch.children as child (child.id)}<details><summary>Child {child.ordinal + 1} · {child.status} · {child.targets.filter(target => target.status === 'applied').length}/{child.targets.length} applied{#if child.targets.some(target => target.status === 'conflict')}{' · '}{child.targets.filter(target => target.status === 'conflict').length} conflicted{/if}{#if child.targets.some(target => target.status === 'skipped')}{' · '}{child.targets.filter(target => target.status === 'skipped').length} skipped{/if}</summary>
              <small>{child.usage?.totalTokens ?? 'unknown'} tokens · {child.usage ? costLabel(child.usage) : 'cost unknown'}{#if child.started_at} · started {new Date(child.started_at).toLocaleString()}{/if}{#if child.finished_at} · finished {new Date(child.finished_at).toLocaleString()}{/if}</small>
              {#if child.error}<p role="alert">{child.error}</p>{/if}
              {#each child.targets as target (target.item_id)}{@const url = sourceUrl({ kind: 'content', id: target.item_id, revision: target.committed_revision ?? target.expected_revision })}
                <div class="batch-target">{#if url}<a href={url} data-sveltekit-reload>{target.item_id}</a>{:else}<span>{target.item_id}</span>{/if} · {target.status}{#if target.committed_revision} · revision {target.committed_revision}{/if}{#if target.result?.changedFields?.length} · {target.result.changedFields.join(', ')}{/if}{#if target.result?.reason} · {target.result.reason}{/if}{#if target.error}<span role="alert"> · {target.error}</span>{/if}</div>
              {/each}
            </details>{/each}
          </section>
        {/each}{/if}
      </article>
      {/if}
    {/each}
    {#if snapshot?.tools?.length}<section aria-label="Assistant tool activity"><h3>Tool activity</h3>{#each snapshot.tools as tool (tool.run_id + tool.call_id)}<div class="tool-card"><strong>{tool.tool}</strong> · {tool.status}{#if tool.tool === 'folder' && tool.result}<p>{tool.result.applied ? 'Applied' : 'Reviewed'} folder {tool.result.operation ?? 'action'}{#if tool.result.path} · {tool.result.path}{:else if tool.result.from && tool.result.to} · {tool.result.from} → {tool.result.to}{/if}{#if tool.result.counts} · {tool.result.counts.folders} folders, {tool.result.counts.documents} documents, {tool.result.counts.canonical} canonical records{:else if tool.result.total != null} · {tool.result.total} paths{/if}</p>{/if}{#if tool.result?.applied && tool.tool !== 'folder'}<p>Applied {tool.result.title ?? tool.result.itemId ?? tool.result.typeId} · revision {tool.result.beforeRevision ?? 'new'} → {tool.result.afterRevision}{#if tool.result.changedFields?.length} · {tool.result.changedFields.join(', ')}{/if}</p>{#if tool.result.afterRevision && (tool.result.itemId || tool.result.typeId)}{@const url = sourceUrl({ kind: tool.result.typeId ? 'content_type' : 'content', id: (tool.result.typeId ?? tool.result.itemId)!, revision: tool.result.afterRevision })}{#if url}<a href={url} data-sveltekit-reload>Open {tool.result.typeId ? 'type' : 'document'}</a>{/if}{/if}{/if}
        {#if tool.tool === 'generateImage' && tool.result?.jobId}<p>Image job {tool.job_status ?? 'queued'} · {tool.result.jobId}</p>{#if tool.image_result?.url}<img src={tool.image_result.url} alt="Assistant artwork" class="generated-image" />{:else if tool.image_result?.assetId}<PrivateImagePreview assetId={tool.image_result.assetId} {projectId} {gameId} alt="Assistant artwork" />{/if}{#if tool.job_status === 'complete'}<small>{#if tool.image_usage?.total_tokens != null || tool.image_usage?.totalTokens != null}{tool.image_usage?.total_tokens ?? tool.image_usage?.totalTokens} image tokens · {/if}{imageUsageCostLabel(tool.image_usage)}</small>{/if}{#if tool.job_error}<p role="alert">{tool.job_error}</p>{/if}{/if}
        {#if tool.tool === 'subagent' && tool.result?.batchId}<p>Batch {tool.result.batchId} · {tool.result.status}{#if tool.result.targetCount != null} · {tool.result.targetCount} targets in {tool.result.childCount} children{/if}</p>{/if}
        {#if tool.error}<p role="alert">{tool.error}</p>{/if}</div>{/each}</section>{/if}
    {#each snapshot?.questions ?? [] as question (question.id)}
      <section class="tool-card" aria-label="Assistant question"><strong>{question.prompt}</strong>
        {#if question.status === 'pending'}<div class="question-options">{#each question.options as option}<button onclick={() => answer(question, { optionId: option.id })} disabled={busy}>{option.label}</button>{/each}</div>{#if question.allow_custom}<label for={`assistant-answer-${question.id}`}>Another answer</label><textarea id={`assistant-answer-${question.id}`} bind:value={customAnswer} rows="2" maxlength="1000"></textarea><button onclick={() => answer(question, { text: customAnswer.trim() })} disabled={busy || !customAnswer.trim()}>Submit answer</button>{/if}
        {:else if question.status === 'answered'}<p>Answered: {question.response?.label ?? question.response?.text ?? question.response?.optionId}</p>
        {:else if question.status === 'cancelled'}<p>Question cancelled.</p>{/if}
      </section>
    {/each}
    {#each snapshot?.approvals ?? [] as approval (approval.id)}
      <section class="tool-card" aria-label={approval.kind === 'layout_clear' ? 'Assistant layout clear review' : 'Assistant restore review'}><strong>{approval.kind === 'layout_clear' ? `Clear layout of ${approval.preview.title ?? 'type'} (${approval.request.id})` : `Restore ${approval.preview.title ?? approval.request.targetKind} (${approval.request.id}) to revision ${approval.request.targetRevision}`}</strong>
        <p>Current revision {approval.preview.currentRevision}; {approval.kind === 'layout_clear' ? `${approval.preview.impact?.total ?? 0} active documents checked` : `${approval.preview.affectedDocuments ?? 0} related documents checked`}. {approval.status === 'pending' ? 'No change has been applied.' : `Review ${approval.status}.`}</p>
        {#if approval.kind === 'layout_clear' && approval.preview.impact}<p>{approval.preview.impact.inherited} documents inherit this type’s context mode; estimated preload {approval.preview.impact.estimatedTokens} tokens.</p>{/if}
        {#each approval.preview.changes as change}<details><summary>{change.field}</summary><pre>Current: {JSON.stringify(change.from, null, 2)}
After approval: {JSON.stringify(change.to, null, 2)}</pre></details>{/each}
        {#each approval.preview.conflicts as conflict}<p role="alert">{typeof conflict === 'string' ? conflict : `${conflict.title}: ${conflict.error}`}</p>{/each}
        {#if approval.status === 'pending'}<div class="question-options"><button onclick={() => reviewApproval(approval, 'approve')} disabled={busy || authoringDirty || !approval.preview.compatible}>Approve {approval.kind === 'layout_clear' ? 'layout clear' : 'restore'} as new revision</button><button onclick={() => reviewApproval(approval, 'decline')} disabled={busy}>Decline</button></div>{/if}
      </section>
    {/each}
    {#if snapshot?.run?.status === 'running' || snapshot?.run?.status === 'committing'}<p role="status">Assistant is working… <button onclick={cancel}>Stop</button></p>{/if}
    {#if snapshot?.run?.status === 'awaiting_input'}<p role="status">Assistant is waiting for your {snapshot.approvals?.some(approval => approval.status === 'pending') ? 'approval review' : 'answer'}. <button onclick={cancel}>Stop</button></p>{/if}
    {#if snapshot?.run?.status === 'failed'}<p role="alert">{snapshot.run.error}</p>{/if}
    {#if snapshot?.run?.status === 'cancelled'}<p role="status">Assistant stopped.</p>{/if}
    {#if (snapshot?.run?.status === 'failed' || snapshot?.run?.status === 'cancelled') && snapshot.run.usage.attemptedCalls}<small>{snapshot.run.usage.completedCalls ?? 0} of {snapshot.run.usage.attemptedCalls} provider attempts have recorded usage · {snapshot.run.usage.totalTokens ?? 'unknown'} total tokens · {costLabel(snapshot.run.usage)}</small>{/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if authoringDirty}<p role="status">Save or discard your editor changes before sending an Assistant request or approving a restore.</p>{/if}
  <form onsubmit={event => { event.preventDefault(); void send(); }}><label for="assistant-draft">Message</label><textarea id="assistant-draft" bind:value={draft} rows="3" maxlength="8000" placeholder="Ask about this project's material or recent game events"></textarea><button disabled={busy || authoringDirty || !draft.trim() || snapshot?.run?.status === 'running' || snapshot?.run?.status === 'awaiting_input' || snapshot?.run?.status === 'committing'}>Send</button></form>
</div>

<style>
  .assistant-panel { position: fixed; z-index: 60; right: 0; top: 0; bottom: 0; width: min(440px, 100vw); display: flex; flex-direction: column; background: var(--bg-primary); border-left: 1px solid var(--border-primary); box-shadow: -16px 0 32px #0003; padding: 1rem; color: var(--text-primary); }
  header, .conversation-picker { display: flex; align-items: center; gap: .5rem; }
  header { justify-content: space-between; }
  h2 { margin: 0; font-family: var(--font-display); }
  header p { margin: .2rem 0; font-size: .72rem; color: var(--text-secondary); overflow-wrap: anywhere; }
  .conversation-picker { margin: 1rem 0; flex-wrap: wrap; }
  .conversation-picker select { flex: 1; min-width: 9rem; }
  .messages { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: .65rem; }
  article { border: 1px solid var(--border-primary); border-radius: .5rem; padding: .7rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  article.user { background: var(--bg-secondary); }
  article p { margin: .4rem 0; line-height: 1.45; }
  article small, details { color: var(--text-secondary); font-size: .75rem; }
  article details small { display: block; }
  .tool-card { margin: .4rem 0; border: 1px solid var(--border-primary); border-radius: .4rem; padding: .5rem; font-size: .8rem; overflow-wrap: anywhere; }
  .batch-card { display: grid; gap: .35rem; margin-top: .65rem; padding: .6rem; border: 1px solid var(--border-primary); border-radius: .4rem; white-space: normal; }
  .batch-card small { display: block; }
  .batch-card button { justify-self: start; }
  .batch-target { padding: .2rem 0; font-size: .75rem; overflow-wrap: anywhere; }
  .generated-image { display: block; max-width: 100%; max-height: 20rem; object-fit: contain; margin-top: .5rem; }
  .question-options { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
  details a, details span { display: block; overflow-wrap: anywhere; }
  details .source-link { display: block; max-width: 100%; padding: 0; border: 0; background: transparent; color: var(--text-accent); text-align: left; overflow-wrap: anywhere; }
  form { display: grid; gap: .5rem; margin-top: .8rem; }
  textarea, select, button { color: inherit; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: .35rem; padding: .5rem; }
  textarea { resize: vertical; max-height: 12rem; }
  button { cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
</style>
