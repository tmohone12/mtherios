<script lang="ts">
  import type { SourceMount } from '$lib/contracts/sourceFiles';

  let { projectId }: { projectId: string } = $props();
  let mounts = $state<SourceMount[]>([]);
  let name = $state('');
  let folderPath = $state('');
  let gm = $state(true);
  let assistant = $state(true);
  let research = $state(false);
  let busy = $state(false);
  let message = $state('');
  let requestNumber = 0;

  async function command(command: string, args: Record<string, unknown>) {
    const response = await fetch('/api/engine/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storyId: '__app__', command, args }) });
    const body = await response.json();
    if (!response.ok || body.status !== 'succeeded') throw new Error(body.error ?? 'Source folder settings failed.');
    return body.result;
  }
  async function load() {
    const request = ++requestNumber, selectedProject = projectId;
    busy = true; message = ''; mounts = [];
    try {
      const result = await command('source.mounts.list', { projectId: selectedProject });
      if (request === requestNumber) mounts = result.mounts;
    } catch (error) { if (request === requestNumber) message = String(error); }
    finally { if (request === requestNumber) busy = false; }
  }
  $effect(() => { if (projectId) void load(); });

  async function add() {
    const selectedProject = projectId, request = requestNumber;
    busy = true; message = '';
    try {
      const roles = [gm ? 'gm' : null, assistant ? 'assistant' : null, research ? 'research' : null].filter(Boolean);
      const result = await command('source.mounts.save', { projectId: selectedProject, expectedRevision: 0, name, path: folderPath, roles });
      if (request === requestNumber) { mounts = [...mounts, result.mount]; name = ''; folderPath = ''; message = 'Read-only source folder registered.'; }
    } catch (error) { if (request === requestNumber) message = String(error); }
    finally { if (request === requestNumber) busy = false; }
  }
  async function remove(mount: SourceMount) {
    const selectedProject = projectId, request = requestNumber;
    busy = true; message = '';
    try {
      await command('source.mounts.remove', { projectId: selectedProject, id: mount.id, expectedRevision: mount.revision });
      if (request === requestNumber) { mounts = mounts.filter(value => value.id !== mount.id); message = 'Source folder access removed.'; }
    } catch (error) { if (request === requestNumber) message = String(error); }
    finally { if (request === requestNumber) busy = false; }
  }
</script>

<section aria-label="Agent source folders">
  <h4>Local source folders</h4>
  <p>Choose local folders the GM or Assistant may browse, search and read. Text, Markdown and JSON are supported. Access is read-only and saved for this project on this server.</p>
  {#each mounts as mount (mount.id)}
    <div class="mount"><div><strong>{mount.name}</strong><small>{mount.root_path}</small><small>{mount.roles.join(', ')} · revision {mount.revision}</small></div><button onclick={() => remove(mount)} disabled={busy} aria-label={`Remove access to ${mount.name}`}>Remove access</button></div>
  {/each}
  <label>Source folder name<input bind:value={name} maxlength="100" disabled={busy} placeholder="Campaign references" /></label>
  <label>Absolute folder path on this server<input bind:value={folderPath} maxlength="2000" disabled={busy} placeholder="E:\Campaign references" /></label>
  <fieldset disabled={busy}><legend>Allow access for</legend><label><input type="checkbox" bind:checked={gm} /> GM</label><label><input type="checkbox" bind:checked={assistant} /> Assistant</label><label><input type="checkbox" bind:checked={research} /> Research</label></fieldset>
  <div class="actions"><button onclick={add} disabled={busy || !name.trim() || !folderPath.trim() || !(gm || assistant || research)}>Register source folder</button><button onclick={load} disabled={busy}>Reload folders</button></div>
  <p role="status">{busy ? 'Loading source folders…' : message}</p>
</section>

<style>
  section { display: grid; gap: .75rem; padding-top: 1rem; border-top: 1px solid var(--border-color); }
  h4 { font-size: 1rem; } p, small { color: var(--text-secondary); }
  small { display: block; overflow-wrap: anywhere; } label { display: grid; gap: .4rem; }
  input, button { padding: .5rem; border: 1px solid var(--border-color); border-radius: .35rem; background: var(--bg-secondary); color: inherit; }
  .mount, .actions, fieldset { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
  .mount { justify-content: space-between; } fieldset label { display: flex; align-items: center; }
  input:disabled, button:disabled { opacity: .5; }
</style>
