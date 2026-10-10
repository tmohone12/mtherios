<script lang="ts">
  import { onMount } from 'svelte';
  import { Sparkles, X, Plus, ArrowUp, MessageCircle } from 'lucide-svelte';
  import { postEngineCommand } from '$lib/services/backendMemory';
  import ChatgptConnection from './ChatgptConnection.svelte';
  import type {AssistantConnection,AssistantConnectionState} from '$lib/contracts/assistantConnection';
  import PrivateImagePreview from './PrivateImagePreview.svelte';
  import { imageUsageCostLabel } from '$lib/utils/imageUsage';

  type Conversation = { id: string; title: string; project_id: string; game_id: string | null };
  type Usage = { model?: string | null; totalTokens?: number | null; providerCostUsd?: number | null; estimatedCostUsd?: number | null; attemptedCalls?: number; completedCalls?: number; unaccountedCalls?: number };
  type Source = { kind: string; id: string; revision: number | string; sourceRef?: string; sha256?: string; startLine?: number; endLine?: number; runId?: string };
  type Message = { id: string; role: 'user' | 'assistant' | 'tool'; content: string; status: string; source_refs: Source[]; usage: Usage | null };
  type ToolCard = { run_id: string; call_id: string; tool: string; status: string; result: { applied?: boolean; itemId?: string; typeId?: string; title?: string; beforeRevision?: number | null; afterRevision?: number; changedFields?: string[]; jobId?: string; batchId?: string; targetCount?: number; childCount?: number; status?: string; operation?: string; path?: string; from?: string; to?: string; total?: number; counts?: { folders: number; documents: number; canonical: number } } | null; error: string | null; job_status: string | null; job_error: string | null; image_result: { assetId?: string; applied?: boolean; url?: string; reason?: string } | null; image_usage: { total_tokens?: number; totalTokens?: number; cost?: number; costUsd?: number; cost_usd?: number; estimatedCostUsd?: number } | null };
  type BatchTarget = { item_id: string; status: string; expected_revision: number; committed_revision: number | null; result: { changedFields?: string[]; reason?: string } | null; error: string | null };
  type BatchChild = { id: string; ordinal: number; status: string; usage: Usage | null; error: string | null; started_at: string | null; finished_at: string | null; targets: BatchTarget[] };
  type Batch = { id: string; run_id: string; user_message_id: string; status: string; model: string; objective: string; budget?: { maxCostUsd: number }; usage: Usage; finalReport?: string | null; reportSources?: Array<{ kind: string; id: string; revision: number }>; children: BatchChild[] };
  type CostBreakdown = { userMessageId: string; assistant: Usage; subagents: Usage; images: { requests: number; completed: number; providerCostUsd: number | null; estimatedCostUsd: number | null } };
  type Question = { id: string; run_id: string; prompt: string; options: Array<{ id: string; label: string }>; allow_custom: boolean; status: string; response: { optionId?: string; label?: string; text?: string } | null; revision: number };
  type Approval = { id: string; run_id: string; kind: 'restore' | 'layout_clear' | 'story_edit'; result?: { undone?: boolean }; request: { targetKind?: 'item' | 'type'; id: string; targetRevision?: number }; preview: { title?: string; currentRevision: number | { metadataRevision: number; recordVersion: number; adapterVersion: number }; storyId?: string; storyTitle?: string; kind?: string; reason?: string; targetRevision?: number; affectedDocuments?: number; impact?: { total: number; inherited: number; estimatedTokens: number }; compatible: boolean; conflicts: Array<string | { title: string; error: string }>; changes: Array<{ field: string; from: unknown; to: unknown }> }; status: string; revision: number };
  type Snapshot = { conversation: Conversation; messages: Message[]; run: { id: string; status: string; error: string | null; usage: Usage; recoverable?: boolean; runtimeVersion?: string; requestReceipts?: Array<{ index: number; status: string; model: string; inputTokens: number; reservedOutputTokens: number; contextWindowTokens: number; finishReason?: string; requestHash?: string }> } | null; tools: ToolCard[]; questions: Question[]; approvals: Approval[]; batches: Batch[]; costBreakdowns?: CostBreakdown[] };

  let { projectId, gameId, selectedStoryTitle, authoringDirty = false, onClose, onOpenStoryEntry, onStoryChanged }: { projectId: string; gameId: string; selectedStoryTitle?: string; authoringDirty?: boolean; onClose: () => void; onOpenStoryEntry?: (id: string) => void; onStoryChanged?: () => Promise<unknown> } = $props();
  let connection=$state<AssistantConnection|null>(null),connectionReady=$state(false);
  const connectionLabel=$derived(connection?.kind==='chatgpt'?'ChatGPT':connection?.kind==='configured'?connection.provider:'Assistant');
  function connectionState(value:AssistantConnectionState){
    if(value.scope!==JSON.stringify({projectId,gameId}))return;
    const changed=JSON.stringify(connection)!==JSON.stringify(value.connection);
    connection=value.connection;connectionReady=value.ready;
    if(changed){selectedId='';snapshot=null;conversations=[];loadVersion++;if(connection)void load();}
  }
  let conversations = $state<Conversation[]>([]);
  let selectedId = $state('');
  let snapshot = $state<Snapshot | null>(null);
  let draft = $state('');
  let busy = $state(false);
  let modal = $state(false);
  let error = $state('');
  let customAnswer = $state('');
  let inspectedSource = $state<{ source: Source; text: string } | null>(null);
  let closeButton: HTMLButtonElement;
  let returnFocus: HTMLElement | null = null;
  let loadVersion = 0;
  const scopeKey = $derived(`${projectId}:${gameId}`);
  const pendingResponseId = $derived(snapshot?.questions?.find(question => question.status === 'pending')?.id ?? snapshot?.approvals?.find(approval => approval.status === 'pending')?.id);

  function focusPendingResponse() {
    if (!pendingResponseId) return;
    const target = document.getElementById(`assistant-response-${pendingResponseId}`);
    target?.scrollIntoView({ block: 'nearest' });
    target?.focus({ preventScroll: true });
  }
  const args = () => ({ projectId, ...(gameId ? { gameId } : {}) });
  const command = (name: string, data: Record<string, unknown>) => postEngineCommand(gameId || '__app__', name, ['assistant.conversation.create','assistant.message.send','assistant.run.resume','assistant.question.answer','assistant.approval.review'].includes(name)?{...data,connection}:data);

  onMount(() => {
    returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    closeButton.focus();
    const narrowLayout = window.matchMedia('(max-width: 1399px)');
    const updateLayout = () => { modal = narrowLayout.matches; };
    updateLayout();
    narrowLayout.addEventListener('change', updateLayout);
    return () => narrowLayout.removeEventListener('change', updateLayout);
  });

  function handlePanelKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab' || !modal) return;
    const panel = event.currentTarget as HTMLElement;
    const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(control => control.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

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
    inspectedSource = null;
    draft = '';
    error = '';
    busy = false;
    connection=null;connectionReady=false;
    return () => { loadVersion += 1; };
  });

  $effect(() => {
    if (snapshot?.run?.recoverable || (snapshot?.run?.status !== 'running' && snapshot?.run?.status !== 'committing' && !snapshot?.tools?.some(tool => tool.job_status && ['queued', 'retry', 'running'].includes(tool.job_status)) && !snapshot?.batches?.some(batch => batch.status === 'running'))) return;
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
    if (busy||!connectionReady) return;
    loadVersion += 1;
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
    loadVersion += 1;
    selectedId = id; snapshot = null; error = '';
    const key = scopeKey;
    try {
      const value = await command('assistant.conversation.read', { ...args(), conversationId: id }) as Snapshot;
      if (key === scopeKey && selectedId === id) snapshot = value;
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
  }

  async function send() {
    const content = draft.trim();
    if (!content || busy || authoringDirty || !connectionReady) return;
    loadVersion += 1;
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
      const request = postEngineCommand(storyId, 'assistant.message.send', { ...scope, conversationId: id, clientMessageId: `assistant_user_${crypto.randomUUID()}`, content,connection });
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

  async function resume() {
    const id = selectedId, runId = snapshot?.run?.id;
    if (!id || !runId) return;
    const key = scopeKey;
    busy = true; error = '';
    try {
      const value = await command('assistant.run.resume', { ...args(), conversationId: id, runId }) as Snapshot;
      if (key === scopeKey && selectedId === id) snapshot = value;
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
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
      if (key === scopeKey && selectedId === id) {
        snapshot = value;
        if (approval.kind === 'story_edit' && decision === 'approve') await onStoryChanged?.();
      }
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }

  async function undoStoryEdit(approval: Approval) {
    if (busy || authoringDirty || !selectedId) return;
    const key = scopeKey, id = selectedId;
    busy = true; error = '';
    try {
      const value = await command('assistant.storyEdit.undo', { ...args(), conversationId: id, approvalId: approval.id, expectedRevision: approval.revision }) as Snapshot;
      if (key === scopeKey && selectedId === id) { snapshot = value; await onStoryChanged?.(); }
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (key === scopeKey) busy = false; }
  }

  function sourceUrl(source: Message['source_refs'][number]) {
    if (source.kind !== 'content' && source.kind !== 'content_type') return null;
    const params = new URLSearchParams({ project: projectId, source: `${source.kind === 'content_type' ? 'content-type' : 'content'}:${source.id}@${source.revision}` });
    if (gameId) params.set('game', gameId);
    return `/?${params}`;
  }

  async function openSource(source: Source) {
    const key = scopeKey;
    try {
      const result = await command('source.file.read', { ...args(), runId: source.runId, sourceRef: source.sourceRef,
        startLine: source.startLine, lineCount: Number(source.endLine) - Number(source.startLine) + 1,
        expectedHash: source.sha256, expectedRevision: source.revision }) as { text: string };
      if (key === scopeKey) inspectedSource = { source, text: result.text };
    } catch (cause) { if (key === scopeKey) error = cause instanceof Error ? cause.message : String(cause); }
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

{#if modal}<button class="assistant-backdrop" onclick={close} aria-label="Close Assistant overlay" tabindex="-1"></button>{/if}
<div class="assistant-panel" role="dialog" aria-modal={modal} aria-labelledby="assistant-title" tabindex="-1" onkeydown={handlePanelKeydown}>
  <header class="assistant-header">
    <div class="assistant-heading"><span class="assistant-emblem"><Sparkles size={20} /></span><div><span class="eyebrow">Your creative companion</span><h2 id="assistant-title">Assistant</h2></div></div>
    <button class="icon-button" bind:this={closeButton} onclick={close} aria-label="Close Assistant"><X size={19} /></button>
  </header>
  <div class="assistant-scope"><span class="scope-dot"></span><span>{gameId ? 'This game' : 'Shared project'}</span><details><summary>Scope details</summary><p>Project: {projectId}{#if gameId}<br />Game: {gameId}{/if}</p></details></div>
  <ChatgptConnection {projectId} {gameId} onState={connectionState} />
  <p class="assistant-notice" role="status">{connectionReady?`Sending via ${connectionLabel} · ${connection?.model}`:'Sending is blocked until you confirm the Assistant connection.'}</p>
  <div class="conversation-picker"><label for="assistant-conversation">Conversation</label><div class="conversation-controls"><select id="assistant-conversation" value={selectedId} onchange={event => { if (event.currentTarget.value) void select(event.currentTarget.value); else { selectedId = ''; snapshot = null; } }} disabled={busy}><option value="">Choose conversation</option>{#each conversations as conversation}<option value={conversation.id}>{conversation.title}</option>{/each}</select><button class="new-conversation" onclick={create} disabled={busy||!connectionReady} aria-label="New conversation"><Plus size={16} /> New</button></div></div>
  {#if snapshot?.run || busy}
    <div class="run-status" class:needs-input={snapshot?.run?.recoverable || snapshot?.run?.status === 'awaiting_input'}>
      <div class="run-status-copy" role="status">
        <strong>{snapshot?.run?.recoverable ? 'Ready to resume' : snapshot?.run?.status === 'awaiting_input' ? 'Your input is needed' : snapshot?.run?.status === 'cancelled' ? 'Assistant stopped' : snapshot?.run?.status === 'failed' ? 'Run needs attention' : busy || snapshot?.run?.status === 'running' || snapshot?.run?.status === 'committing' ? 'Assistant is working' : 'Run complete'}</strong>
        <span>{snapshot?.run?.recoverable ? 'Continue from the saved activity below.' : snapshot?.run?.status === 'awaiting_input' ? 'Review the question or approval before continuing.' : snapshot?.run?.status === 'cancelled' ? 'You can send a new message when ready.' : snapshot?.run?.status === 'failed' ? 'The details are shown in the conversation.' : busy || snapshot?.run?.status === 'running' || snapshot?.run?.status === 'committing' ? 'Tool activity and replies appear in this conversation.' : 'Your conversation and source references are saved.'}</span>
      </div>
      <div class="run-actions">
        {#if snapshot?.run?.recoverable}<button onclick={resume} disabled={busy||!connectionReady}>Resume</button>{/if}
        {#if snapshot?.run?.status === 'awaiting_input' && pendingResponseId}<button onclick={focusPendingResponse}>View request</button>{/if}
        {#if snapshot?.run?.recoverable || snapshot?.run?.status === 'running' || snapshot?.run?.status === 'committing' || snapshot?.run?.status === 'awaiting_input'}<button class="stop-button" onclick={cancel}>Stop</button>{/if}
      </div>
    </div>
  {/if}
  <div class="messages" role="log" aria-label="Assistant messages">
    {#if !snapshot && selectedId}<p class="loading-message" role="status">Loading conversation…</p>
    {:else if !snapshot?.messages?.length}
      <section class="assistant-empty" aria-label="Start a conversation"><MessageCircle size={30} /><h3>A space to shape your world</h3><p>Explore {gameId ? 'recent events and story material' : 'your project material'}, develop an idea, or ask for a specific edit.</p><div class="starter-actions"><button disabled={busy} onclick={() => draft = gameId ? 'Summarize the recent events in this game, with sources.' : 'Help me develop an idea for this world.'}>{gameId ? 'Catch up on the story' : 'Develop an idea'}</button><button disabled={busy} onclick={() => draft = 'Help me review the project material for details that need clarification.'}>Review my material</button></div><small>Choose a starting point, then edit and send your message.</small></section>
    {/if}
    {#each snapshot?.messages ?? [] as message (message.id)}
      {#if !message.id.startsWith('assistant_batch_report_') || !snapshot?.batches?.some(batch => `assistant_batch_report_${batch.id}` === message.id)}
      <article class:user={message.role === 'user'}><strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>{#if message.status === 'failed'}<small role="alert">Invalidated reply</small>{/if}<p>{message.content}</p>
        {#if message.role === 'assistant' && message.usage}{@const calls = message.usage.attemptedCalls ?? message.usage.completedCalls ?? 1}<small>{message.usage.model ?? 'Model'} · {message.usage.totalTokens ?? 'unknown'} tokens · {calls} provider {calls === 1 ? 'call' : 'calls'} · {costLabel(message.usage)}</small>{/if}
        {#if message.role === 'assistant' && message.source_refs?.length}<details><summary>Context sources</summary>{#each message.source_refs as source}{@const url = sourceUrl(source)}{#if url}<a href={url} data-sveltekit-reload>{source.id} · revision {source.revision}</a>{:else if source.kind === 'file'}<button class="source-link" onclick={() => openSource(source)}>Open {source.id} · lines {source.startLine}–{source.endLine} · revision {source.revision}</button>{:else if source.kind === 'story_entry' && onOpenStoryEntry}<button class="source-link" onclick={() => onOpenStoryEntry?.(source.id)}>Open story source {source.id} · version {source.revision}</button>{:else}<span>{source.id} · version {source.revision}</span>{/if}{/each}</details>{/if}
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
    {#if snapshot?.tools?.length}<details class="activity-history"><summary>Tool activity <span class="activity-count">{snapshot.tools.length}</span></summary>{#each snapshot.tools as tool (tool.run_id + tool.call_id)}<div class="tool-card"><strong>{tool.tool}</strong> · {tool.status}{#if tool.tool === 'folder' && tool.result}<p>{tool.result.applied ? 'Applied' : 'Reviewed'} folder {tool.result.operation ?? 'action'}{#if tool.result.path} · {tool.result.path}{:else if tool.result.from && tool.result.to} · {tool.result.from} → {tool.result.to}{/if}{#if tool.result.counts} · {tool.result.counts.folders} folders, {tool.result.counts.documents} documents, {tool.result.counts.canonical} canonical records{:else if tool.result.total != null} · {tool.result.total} paths{/if}</p>{/if}{#if tool.result?.applied && tool.tool !== 'folder'}<p>Applied {tool.result.title ?? tool.result.itemId ?? tool.result.typeId} · revision {tool.result.beforeRevision ?? 'new'} → {tool.result.afterRevision}{#if tool.result.changedFields?.length} · {tool.result.changedFields.join(', ')}{/if}</p>{#if tool.result.afterRevision && (tool.result.itemId || tool.result.typeId)}{@const url = sourceUrl({ kind: tool.result.typeId ? 'content_type' : 'content', id: (tool.result.typeId ?? tool.result.itemId)!, revision: tool.result.afterRevision })}{#if url}<a href={url} data-sveltekit-reload>Open {tool.result.typeId ? 'type' : 'document'}</a>{/if}{/if}{/if}
        {#if tool.tool === 'generateImage' && tool.result?.jobId}<p>Image job {tool.job_status ?? 'queued'} · {tool.result.jobId}</p>{#if tool.image_result?.url}<img src={tool.image_result.url} alt="Assistant artwork" class="generated-image" />{:else if tool.image_result?.assetId}<PrivateImagePreview assetId={tool.image_result.assetId} {projectId} {gameId} alt="Assistant artwork" />{/if}{#if tool.job_status === 'complete'}<small>{#if tool.image_usage?.total_tokens != null || tool.image_usage?.totalTokens != null}{tool.image_usage?.total_tokens ?? tool.image_usage?.totalTokens} image tokens · {/if}{imageUsageCostLabel(tool.image_usage)}</small>{/if}{#if tool.job_error}<p role="alert">{tool.job_error}</p>{/if}{/if}
        {#if tool.tool === 'subagent' && tool.result?.batchId}<p>Batch {tool.result.batchId} · {tool.result.status}{#if tool.result.targetCount != null} · {tool.result.targetCount} targets in {tool.result.childCount} children{/if}</p>{/if}
        {#if tool.result}<details><summary>Inspect result and source ranges</summary><pre>{JSON.stringify(tool.result, null, 2)}</pre></details>{/if}
        {#if tool.error}<p role="alert">{tool.error}</p>{/if}</div>{/each}</details>{/if}
    {#if inspectedSource}<section aria-label="Source range"><strong>{inspectedSource.source.id} · lines {inspectedSource.source.startLine}–{inspectedSource.source.endLine}</strong><small>Revision {inspectedSource.source.revision} · {inspectedSource.source.sha256}</small><pre>{inspectedSource.text}</pre><button onclick={() => { inspectedSource = null; }}>Close source</button></section>{/if}
    {#if snapshot?.run?.requestReceipts?.length}<details><summary>Model requests · {snapshot.run.runtimeVersion}</summary>{#each snapshot.run.requestReceipts as receipt}<details><summary>{receipt.index}. {receipt.model} · {receipt.status} · {receipt.inputTokens} input / {receipt.reservedOutputTokens} output allowance{receipt.finishReason ? ` · ${receipt.finishReason}` : ''}</summary><pre>{JSON.stringify(receipt, null, 2)}</pre></details>{/each}</details>{/if}
    {#each snapshot?.questions ?? [] as question (question.id)}
      <section class="tool-card question-card" id={`assistant-response-${question.id}`} tabindex="-1" aria-label="Assistant question"><strong>{question.prompt}</strong>
        {#if question.status === 'pending'}<div class="question-options">{#each question.options as option}<button onclick={() => answer(question, { optionId: option.id })} disabled={busy}>{option.label}</button>{/each}</div>{#if question.allow_custom}<label for={`assistant-answer-${question.id}`}>Another answer</label><textarea id={`assistant-answer-${question.id}`} bind:value={customAnswer} rows="2" maxlength="1000"></textarea><button onclick={() => answer(question, { text: customAnswer.trim() })} disabled={busy || !customAnswer.trim()}>Submit answer</button>{/if}
        {:else if question.status === 'answered'}<p>Answered: {question.response?.label ?? question.response?.text ?? question.response?.optionId}</p>
        {:else if question.status === 'cancelled'}<p>Question cancelled.</p>{/if}
      </section>
    {/each}
    {#each snapshot?.approvals ?? [] as approval (approval.id)}
      <section class="tool-card question-card" id={`assistant-response-${approval.id}`} tabindex="-1" aria-label={approval.kind === 'story_edit' ? 'Assistant story edit review' : approval.kind === 'layout_clear' ? 'Assistant layout clear review' : 'Assistant restore review'}><strong>{approval.kind === 'story_edit' ? `Edit ${approval.preview.title ?? 'story entry'}` : approval.kind === 'layout_clear' ? `Clear layout of ${approval.preview.title ?? 'type'} (${approval.request.id})` : `Restore ${approval.preview.title ?? approval.request.targetKind} (${approval.request.id}) to revision ${approval.request.targetRevision}`}</strong>
        {#if approval.kind === 'story_edit'}<p>{approval.preview.kind} · {selectedStoryTitle ?? approval.preview.storyTitle ?? 'Selected story'}</p><p>{approval.preview.reason}</p>{/if}
        <p>Current revision {typeof approval.preview.currentRevision === 'number' ? approval.preview.currentRevision : `${approval.preview.currentRevision.recordVersion} / workspace ${approval.preview.currentRevision.metadataRevision}`}. {approval.status === 'pending' ? 'Review the proposed changes before applying.' : approval.result?.undone ? 'Undone as a new revision.' : `Review ${approval.status}.`}</p>
        {#if approval.kind === 'layout_clear' && approval.preview.impact}<p>{approval.preview.impact.inherited} documents inherit this type’s context mode; estimated preload {approval.preview.impact.estimatedTokens} tokens.</p>{/if}
        {#each approval.preview.changes as change}<details open={approval.kind === 'story_edit'}><summary>{change.field}</summary><pre>Current: {JSON.stringify(change.from, null, 2)}
After approval: {JSON.stringify(change.to, null, 2)}</pre></details>{/each}
        {#each approval.preview.conflicts as conflict}<p role="alert">{typeof conflict === 'string' ? conflict : `${conflict.title}: ${conflict.error}`}</p>{/each}
        {#if approval.status === 'pending'}<div class="question-options"><button onclick={() => reviewApproval(approval, 'approve')} disabled={busy || authoringDirty || !approval.preview.compatible}>{approval.kind === 'story_edit' ? 'Apply story edit' : `Approve ${approval.kind === 'layout_clear' ? 'layout clear' : 'restore'} as new revision`}</button><button onclick={() => reviewApproval(approval, 'decline')} disabled={busy}>{approval.kind === 'story_edit' ? 'Cancel edit' : 'Decline'}</button></div>{/if}
        {#if approval.kind === 'story_edit' && approval.status === 'approved' && !approval.result?.undone}<button onclick={() => undoStoryEdit(approval)} disabled={busy || authoringDirty}>Undo story edit</button><small>Undo restores only these fields while this entry remains unchanged. History retains both revisions.</small>{/if}
      </section>
    {/each}
    {#if snapshot?.run?.status === 'failed'}<p role="alert">{snapshot.run.error}</p>{/if}
    {#if (snapshot?.run?.status === 'failed' || snapshot?.run?.status === 'cancelled') && snapshot.run.usage.attemptedCalls}<small>{snapshot.run.usage.completedCalls ?? 0} of {snapshot.run.usage.attemptedCalls} provider attempts have recorded usage · {snapshot.run.usage.totalTokens ?? 'unknown'} total tokens · {costLabel(snapshot.run.usage)}</small>{/if}
  </div>
  {#if error}<p class="assistant-notice" role="alert">{error}</p>{/if}
  {#if authoringDirty}<p class="assistant-notice" role="status">Save or discard your editor changes before sending an Assistant request or applying or undoing a change.</p>{/if}
  <form class="assistant-composer" onsubmit={event => { event.preventDefault(); void send(); }}>
    <label for="assistant-draft">Ask your Assistant</label>
    <textarea id="assistant-draft" bind:value={draft} rows="3" maxlength="8000" placeholder="Explore your story or propose an edit to its characters, places, items or factions."></textarea>
    <div class="composer-footer"><small>Messages stay with {gameId ? 'this game' : 'this project'}.</small><button class="send-button" disabled={busy || !connectionReady || authoringDirty || !draft.trim() || snapshot?.run?.status === 'running' || snapshot?.run?.status === 'awaiting_input' || snapshot?.run?.status === 'committing'}>Send via {connectionLabel} <ArrowUp size={16} /></button></div>
  </form>
</div>

<style>
  .assistant-backdrop { position: fixed; inset: 0; z-index: 59; border: 0; border-radius: 0; background: #0006; }
  .assistant-panel { position: fixed; z-index: 60; right: 0; top: 0; bottom: 0; width: min(480px, 100vw); display: flex; flex-direction: column; min-height: 0; background: var(--bg-primary); border-left: 1px solid var(--border-primary); box-shadow: -20px 0 60px #0005; color: var(--text-primary); }
  .assistant-header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 24px 24px 16px; }
  .assistant-heading { display: flex; align-items: center; gap: .8rem; }
  .assistant-emblem { display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid var(--border-primary); border-radius: 13px; background: var(--bg-secondary); color: var(--text-accent); }
  .eyebrow { display: block; margin-bottom: .25rem; font-size: .62rem; color: var(--text-muted); letter-spacing: .1em; text-transform: uppercase; }
  h2 { margin: 0; font: 1.65rem/1.1 var(--font-display); }
  .assistant-scope { display: flex; align-items: baseline; flex-wrap: wrap; gap: .45rem; padding: 0 24px 15px; color: var(--text-secondary); font-size: .75rem; border-bottom: 1px solid var(--border-primary); }
  .scope-dot { width: 5px; height: 5px; align-self: center; border-radius: 50%; background: var(--text-accent); }
  .assistant-scope details { margin-left: auto; max-width: 100%; }
  .assistant-scope summary { color: var(--text-muted); font-size: .68rem; text-align: right; }
  .assistant-scope p { padding-top: .5rem; overflow-wrap: anywhere; font-size: .68rem; }
  .conversation-picker { display: grid; gap: .5rem; padding: 16px 24px; }
  .conversation-picker > label { font-size: .65rem; text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); }
  .conversation-controls { display: flex; gap: .5rem; min-width: 0; }
  .conversation-controls select { flex: 1; min-width: 0; text-overflow: ellipsis; }
  .new-conversation { display: flex; gap: .3rem; align-items: center; flex-shrink: 0; }
  .run-status { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: 12px 24px; border-block: 1px solid var(--border-primary); background: var(--bg-secondary); }
  .run-status-copy { min-width: 0; }
  .run-status-copy strong { display: block; font-size: .76rem; font-weight: 550; }
  .run-status-copy span { display: block; margin-top: .2rem; color: var(--text-secondary); font-size: .68rem; line-height: 1.5; }
  .needs-input { border-left: 3px solid var(--text-accent); padding-left: 21px; }
  .run-actions { display: flex; flex-wrap: wrap; gap: .35rem; flex-shrink: 0; max-width: 50%; }
  .run-actions:empty { display: none; }
  .run-actions button { min-height: 36px; font-size: .72rem; padding: .35rem .55rem; }
  .stop-button { color: var(--text-secondary); }
  .messages { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 1rem; padding: 22px 24px; scrollbar-gutter: stable; }
  .assistant-empty { display: flex; flex-direction: column; align-items: center; gap: 1rem; margin: auto 0; padding: 24px 4px; text-align: center; color: var(--text-muted); }
  .assistant-empty h3 { color: var(--text-primary); font: 1.5rem/1.25 var(--font-display); }
  .assistant-empty p { max-width: 330px; font-size: .82rem; line-height: 1.75; }
  .assistant-empty small { max-width: 290px; font-size: .68rem; line-height: 1.6; }
  .starter-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: .5rem; }
  .starter-actions button { color: var(--text-primary); font-size: .72rem; }
  .loading-message { padding: 2rem 0; color: var(--text-secondary); text-align: center; font-size: .8rem; }
  article { border-bottom: 1px solid var(--border-primary); padding: .25rem 0 1.2rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  article > strong { color: var(--text-accent); font-size: .65rem; letter-spacing: .08em; text-transform: uppercase; }
  article.user { background: var(--bg-secondary); padding: 1rem; border: 1px solid var(--border-primary); border-radius: .75rem; }
  article.user > strong { color: var(--text-muted); }
  article p { margin: .65rem 0; font-size: .87rem; line-height: 1.8; }
  article small, details { color: var(--text-secondary); font-size: .72rem; line-height: 1.65; }
  article details small { display: block; }
  .tool-card { margin: .6rem 0; border: 1px solid var(--border-primary); border-radius: .65rem; padding: .8rem; font-size: .78rem; line-height: 1.6; overflow-wrap: anywhere; background: var(--bg-secondary); }
  .question-card { border-color: color-mix(in srgb, var(--text-accent) 45%, var(--border-primary)); padding: 1rem; }
  .question-card > strong { font-size: .9rem; }
  .question-card > label { display: block; margin-top: .9rem; margin-bottom: .35rem; }
  .question-card > textarea { display: block; width: 100%; margin-bottom: .5rem; }
  .batch-card { display: grid; gap: .35rem; margin-top: .65rem; padding: .75rem; border: 1px solid var(--border-primary); border-radius: .5rem; white-space: normal; }
  .batch-card small { display: block; }
  .batch-card button { justify-self: start; }
  .batch-target { padding: .2rem 0; font-size: .75rem; overflow-wrap: anywhere; }
  .generated-image { display: block; max-width: 100%; max-height: 20rem; object-fit: contain; margin-top: .5rem; }
  .question-options { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
  .question-options button { text-align: left; }
  .activity-history { border: 1px solid var(--border-primary); border-radius: .65rem; padding: .7rem .9rem; }
  .activity-count { display: inline-block; margin-left: .35rem; padding: 0 .35rem; border-radius: .25rem; background: var(--bg-tertiary); font-size: .66rem; }
  details a, details span:not(.activity-count) { display: block; overflow-wrap: anywhere; }
  details .source-link { display: block; max-width: 100%; padding: .25rem 0; border: 0; background: transparent; color: var(--text-accent); text-align: left; overflow-wrap: anywhere; }
  summary { cursor: pointer; }
  .assistant-panel pre { max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .7rem; padding: .65rem; background: var(--bg-primary); border-radius: .4rem; }
  .assistant-notice { flex-shrink: 0; max-height: 20vh; overflow: auto; margin: 0; padding: .8rem 24px; border-top: 1px solid var(--border-primary); background: var(--bg-secondary); font-size: .76rem; line-height: 1.65; overflow-wrap: anywhere; }
  .assistant-composer { display: grid; gap: .6rem; padding: 17px 24px 20px; border-top: 1px solid var(--border-primary); background: var(--bg-secondary); }
  .assistant-composer > label { color: var(--text-secondary); font-size: .75rem; }
  .composer-footer { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
  .composer-footer small { color: var(--text-muted); font-size: .65rem; }
  textarea, select, button { color: inherit; background: var(--bg-primary); border: 1px solid var(--border-primary); border-radius: .5rem; padding: .6rem .7rem; font-family: inherit; font-size: .8rem; }
  textarea { min-height: 74px; resize: vertical; max-height: 22vh; line-height: 1.65; }
  textarea::placeholder { color: var(--text-muted); }
  button, select { min-height: 42px; }
  button { cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--text-accent); }
  button:disabled { opacity: .5; cursor: default; }
  .icon-button { display: grid; place-items: center; width: 40px; height: 40px; padding: 0; }
  .send-button { display: flex; align-items: center; justify-content: center; gap: .5rem; min-width: 86px; color: var(--bg-primary); background: var(--text-accent); border-color: transparent; font-weight: 600; }
  :where(button, select, textarea, summary, .question-card):focus-visible { outline: 2px solid var(--text-accent); outline-offset: 3px; }
  @media (max-width: 600px) {
    .assistant-header { padding: 18px 18px 14px; }
    .assistant-scope { padding-inline: 18px; }
    .conversation-picker { padding: 12px 18px; }
    .messages { padding: 18px; }
    .run-status { padding-inline: 18px; }
    .needs-input { padding-left: 15px; }
    .assistant-composer { padding: 14px 18px max(16px, env(safe-area-inset-bottom)); }
    .assistant-notice { padding-inline: 18px; }
    textarea, select { font-size: 16px; }
  }
  @media (max-height: 650px) {
    .assistant-header { padding-block: 12px; }
    .assistant-scope { padding-bottom: 10px; }
    .conversation-picker { padding-block: 10px; }
    .assistant-composer { padding-block: 10px; }
    .assistant-emblem { width: 36px; height: 36px; }
    textarea { min-height: 54px; }
  }
</style>
