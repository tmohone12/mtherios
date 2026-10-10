import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db/client';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import type { AgentRole } from '$lib/contracts/agentTools';
import { sourceListArgsSchema, sourceSearchArgsSchema, sourceReadArgsSchema, sourceMountListSchema, sourceMountSaveSchema, sourceMountRemoveSchema, sourceRunReadSchema, type SourceMount } from '$lib/contracts/sourceFiles';
import { readContent } from './content';
import { readCanonicalWorkspace } from './canonicalContent';
import { validateContentFolder } from './contentValidation';
import { MutationError } from './mutationSafety';

export interface SourceAuthority { role: AgentRole; projectId: string; gameId: string | null; branchId?: string | null; povCharacter?: string | null }
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (code: string, message: string): never => { throw new MutationError(code, message); };
async function sourceFilesystem<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof MutationError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return fail('SOURCE_NOT_FOUND', 'This local source is no longer available.');
    if (code === 'EACCES' || code === 'EPERM') return fail('SOURCE_DENIED', 'This local source cannot be read.');
    return fail('SOURCE_IO_ERROR', 'The local source could not be read.');
  }
}
const maxFileBytes = 1024 * 1024;
const maxExcerptChars = 12000;
const deniedNames = new Set(['node_modules', 'data', 'logs', 'build', 'dist', 'target', 'venv', 'credentials', 'secrets', 'runtime', 'system32', 'windows', 'appdata', 'mythengine.config.json', 'mtherios.config.json']);
const supported = (name: string) => ['.txt', '.md', '.json'].includes(path.extname(name).toLowerCase());
const safeName = (name: string) => !name.startsWith('.') && !deniedNames.has(name.toLowerCase())
  && !/(?:^|[-_.])(secret|credentials?|passwords?|tokens?|api[-_]?keys?)(?:[-_.]|$)/i.test(name)
  && !/[\x00-\x1f:]/.test(name) && !/[. ]$/.test(name)
  && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);

/** Reject Windows path forms even on a non-Windows server/test host. */
export function validateSourcePath(value: string): string {
  if (/[\x00-\x1f:]/.test(value) || /^[\\/]/.test(value) || path.win32.isAbsolute(value) || path.isAbsolute(value)) fail('SOURCE_PATH_DENIED', 'Use a relative source path.');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(part => part === '..' || part === '.' || (part && !safeName(part)))) fail('SOURCE_PATH_DENIED', 'This source path is not allowed.');
  return parts.filter(Boolean).join('/');
}
const contains = (root: string, target: string) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
function runtimeRoots() {
  const config = getMtheriosAppConfig();
  return [config.dataRoot, config.vaultRoot].map(root => path.resolve(root));
}
function assertOutsideRuntime(target: string) {
  if (runtimeRoots().some(root => contains(root, target))) fail('SOURCE_PATH_DENIED', 'Runtime data and projections must be read through canonical source tools.');
}

export async function validateSourceMountRoot(value: string): Promise<string> {
  if (!path.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f]/.test(value)
    || (path.sep === '\\' && /:/.test(value.slice(2)))) fail('SOURCE_PATH_DENIED', 'Select an absolute local folder path. Network paths and streams are not allowed.');
  const resolved = await realpath(value);
  assertOutsideRuntime(resolved);
  if (resolved === path.parse(resolved).root || /^[\\/]{2}/.test(resolved)) fail('SOURCE_PATH_DENIED', 'Select a specific local source folder.');
  const segments = resolved.slice(path.parse(resolved).root.length).split(path.sep);
  if (segments.some(segment => !safeName(segment))) fail('SOURCE_PATH_DENIED', 'Secret and runtime folders cannot be mounted.');
  if (!(await stat(resolved)).isDirectory()) fail('SOURCE_PATH_DENIED', 'The selected source must be a folder.');
  return resolved;
}

export async function resolveMountedSource(mount: SourceMount, relativePath: string): Promise<string> {
  const relative = validateSourcePath(relativePath);
  const root = await realpath(mount.root_path);
  if (root !== mount.root_path) fail('SOURCE_PATH_DENIED', 'The mounted folder changed. Register it again.');
  let current = root;
  // Reject links as well as checking final containment; a junction must never grant another folder.
  for (const segment of relative.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) fail('SOURCE_PATH_DENIED', 'Linked source paths are not allowed.');
  }
  const resolved = await realpath(current);
  if (!contains(root, resolved)) fail('SOURCE_PATH_DENIED', 'The source is outside this mount.');
  assertOutsideRuntime(resolved);
  return resolved;
}

async function projectScope(db: Db | Tx, projectId: string, gameId?: string | null, lock = false) {
  const [project] = await db.execute(sql`select id from shelves where id=${projectId} ${lock ? sql`for update` : sql``}`);
  if (!project) fail('SCOPE_DENIED', 'Project not found.');
  if (gameId) {
    const [game] = await db.execute(sql`select id from stories where id=${gameId} and shelf_id=${projectId}`);
    if (!game) fail('SCOPE_DENIED', 'The game does not belong to this project.');
  }
}
function assertRole(authority: SourceAuthority) {
  if (!['gm', 'assistant', 'research'].includes(authority.role)) fail('SOURCE_DENIED', 'This role cannot explore source folders.');
}
async function mountFor(authority: SourceAuthority, id: string | undefined): Promise<SourceMount> {
  if (!id) fail('SOURCE_REQUIRED', 'List mounts and supply a mountId.');
  const [mount] = await getDb().execute(sql`select * from source_mounts where project_id=${authority.projectId} and id=${id}`);
  if (!mount || !(mount.roles as string[]).includes(authority.role)) fail('SCOPE_DENIED', 'Source mount is not available in this scope.');
  return mount as unknown as SourceMount;
}
export async function listSourceMounts(input: unknown) {
  const request = sourceMountListSchema.parse(input);
  await projectScope(getDb(), request.projectId);
  return { mounts: await getDb().execute(sql`select id,project_id,name,root_path,roles,revision from source_mounts where project_id=${request.projectId} order by name,id`) };
}
export async function saveSourceMount(input: unknown) {
  const request = sourceMountSaveSchema.parse(input);
  const root = await sourceFilesystem(() => validateSourceMountRoot(request.path));
  return getDb().transaction(async tx => {
    await projectScope(tx, request.projectId, null, true);
    const [current] = request.id ? await tx.execute(sql`select id,revision from source_mounts where id=${request.id} and project_id=${request.projectId} for update`) : [];
    if (request.id && !current) fail('SCOPE_DENIED', 'Source mount not found.');
    if (Number(current?.revision ?? 0) !== request.expectedRevision) fail('REVISION_CONFLICT', 'The source mount changed. Reload before saving.');
    const [duplicate] = await tx.execute(sql`select id from source_mounts where project_id=${request.projectId} and lower(root_path)=lower(${root}) and id<>${request.id ?? ''}`);
    if (duplicate) fail('SOURCE_EXISTS', 'This folder is already registered for the project.');
    const id = request.id ?? randomUUID();
    const roles = JSON.stringify([...new Set(request.roles)]);
    const [mount] = current
      ? await tx.execute(sql`update source_mounts set name=${request.name},root_path=${root},roles=${roles}::jsonb,revision=revision+1,updated_at=now() where id=${id} returning id,project_id,name,root_path,roles,revision`)
      : await tx.execute(sql`insert into source_mounts(id,project_id,name,root_path,roles) values(${id},${request.projectId},${request.name},${root},${roles}::jsonb) returning id,project_id,name,root_path,roles,revision`);
    return { mount };
  });
}
export async function removeSourceMount(input: unknown) {
  const request = sourceMountRemoveSchema.parse(input);
  return getDb().transaction(async tx => {
    await projectScope(tx, request.projectId, null, true);
    const [current] = await tx.execute(sql`select revision from source_mounts where id=${request.id} and project_id=${request.projectId} for update`);
    if (!current) fail('SCOPE_DENIED', 'Source mount not found.');
    if (Number(current.revision) !== request.expectedRevision) fail('REVISION_CONFLICT', 'The source mount changed. Reload before removing it.');
    await tx.execute(sql`delete from source_mounts where id=${request.id} and project_id=${request.projectId}`);
    return { removed: true, id: request.id };
  });
}
export function sourceMountsCommand(command: string, args: unknown) {
  if (command === 'source.mounts.list') return listSourceMounts(args);
  if (command === 'source.mounts.save') return saveSourceMount(args);
  if (command === 'source.mounts.remove') return removeSourceMount(args);
  return fail('UNKNOWN_COMMAND', 'Unknown source mount command.');
}

const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor<T extends z.ZodType>(value: string | undefined, schema: T): z.infer<T> | null {
  if (!value) return null;
  try { return schema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { return fail('SOURCE_CURSOR_INVALID', 'Invalid source cursor. Restart the list or search.'); }
}
const pageCursorSchema = z.object({ fingerprint: z.string(), offset: z.number().int().min(0).max(100000) }).strict();
function pageOffset(cursor: string | undefined, fingerprint: string) {
  const page = decodeCursor(cursor, pageCursorSchema);
  if (page && page.fingerprint !== fingerprint) fail('SOURCE_CURSOR_STALE', 'The source or query changed. Restart this list.');
  return page?.offset ?? 0;
}
const mountRef = (mountId: string, relative: string) => `mount:${mountId}:${encodeURIComponent(relative)}`;

async function directoryEntries(mount: SourceMount, relative: string) {
  const resolved = await resolveMountedSource(mount, relative);
  const before = await stat(resolved);
  if (!before.isDirectory()) fail('SOURCE_NOT_DIRECTORY', 'The selected source is not a folder.');
  const entries: Array<{ name: string; directory: boolean }> = [];
  const directory = await opendir(resolved);
  const protectedRoots = runtimeRoots();
  let seen = 0;
  for await (const entry of directory) {
    if (++seen > 2048) fail('SOURCE_DIRECTORY_LIMIT', 'This folder has too many entries. Select a smaller source folder.');
    if (!safeName(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && (!entry.isFile() || !supported(entry.name)))) continue;
    if (protectedRoots.some(root => contains(root, path.join(resolved, entry.name)))) continue;
    // A directory handle may outlive a replaced path. Verify each returned name against
    // the authorized tree, and derive its kind from that current child rather than the handle.
    const child = await resolveMountedSource(mount, [relative, entry.name].filter(Boolean).join('/'));
    const current = await lstat(child);
    if (current.isDirectory() || (current.isFile() && supported(entry.name))) entries.push({ name: entry.name, directory: current.isDirectory() });
  }
  const verified = await resolveMountedSource(mount, relative), after = await stat(verified);
  if (verified !== resolved || before.dev !== after.dev || before.ino !== after.ino) fail('SOURCE_CHANGED', 'The source folder changed during the list. Try again.');
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
export async function listMountedSources(mount: SourceMount, input: unknown) {
  const request = sourceListArgsSchema.parse(input);
  const relative = validateSourcePath(request.path);
  const entries = await directoryEntries(mount, relative);
  const fingerprint = hash(JSON.stringify([mount.id, mount.revision, relative, entries]));
  const offset = pageOffset(request.cursor, fingerprint);
  const selected = entries.slice(offset, offset + request.limit);
  return { items: selected.map(entry => {
    const relativePath = [relative, entry.name].filter(Boolean).join('/');
    return { name: entry.name, path: relativePath, kind: entry.directory ? 'directory' : 'file', sourceRef: entry.directory ? null : mountRef(mount.id, relativePath), mountId: mount.id, mountRevision: mount.revision, readOnly: true };
  }), nextCursor: offset + selected.length < entries.length ? encodeCursor({ fingerprint, offset: offset + selected.length }) : null, truncated: false };
}

async function mountedText(mount: SourceMount, relative: string) {
  if (!supported(relative)) fail('SOURCE_UNSUPPORTED', 'Source reads support text, Markdown and JSON files.');
  const resolved = await resolveMountedSource(mount, relative);
  const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    const authorized = await lstat(await resolveMountedSource(mount, relative));
    if (authorized.dev !== before.dev || authorized.ino !== before.ino) fail('SOURCE_CHANGED', 'The source path changed before the read. Try again.');
    if (!before.isFile()) fail('SOURCE_UNSUPPORTED', 'This source is not a regular file.');
    if (before.size > maxFileBytes) fail('SOURCE_TOO_LARGE', 'This source exceeds the 1 MiB text limit. Import or split it into smaller documents.');
    // A bounded buffer prevents an expanding file from turning readFile into an unbounded allocation.
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > maxFileBytes) fail('SOURCE_TOO_LARGE', 'This source exceeds the 1 MiB text limit.');
    const after = await file.stat();
    const verified = await resolveMountedSource(mount, relative), current = await lstat(verified);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || verified !== resolved
      || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs) fail('SOURCE_CHANGED', 'The source changed during the read. Try again.');
    const bytes = buffer.subarray(0, bytesRead);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return fail('SOURCE_UNSUPPORTED', 'This source is not UTF-8 text.'); }
    if (text.includes('\0')) fail('SOURCE_UNSUPPORTED', 'Binary sources are not supported.');
    if (/"[^"\n]*(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key)"\s*:\s*"[^"\s]+"|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/i.test(text)) fail('SOURCE_DENIED', 'This file contains credentials and cannot be used as an agent source.');
    return { text, sha256: hash(bytes), revision: `${mount.revision}:${hash(bytes)}`, byteSize: bytesRead };
  } finally { await file.close(); }
}

export function sourceTextRange<T extends Record<string, unknown>>(text: string, input: { sourceRef: string; startLine: number; lineCount: number }, metadata: T) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (input.startLine > lines.length) fail('SOURCE_RANGE_INVALID', 'The requested line is past the end of this source.');
  let selected: string[] = [];
  let chars = 0;
  for (const line of lines.slice(input.startLine - 1, input.startLine - 1 + input.lineCount)) {
    if (line.length > maxExcerptChars) fail('SOURCE_LINE_TOO_LARGE', 'This source has a line larger than the excerpt limit. Import it as formatted authored content.');
    if (chars + line.length + (selected.length ? 1 : 0) > maxExcerptChars) break;
    selected.push(line); chars += line.length + (selected.length > 1 ? 1 : 0);
  }
  const endLine = input.startLine + selected.length - 1;
  const nextLine = endLine < lines.length ? endLine + 1 : null;
  return { ...metadata, sourceRef: input.sourceRef, text: selected.join('\n'), startLine: input.startLine, endLine, totalLines: lines.length,
    truncated: nextLine !== null, nextRead: nextLine ? { sourceRef: input.sourceRef, startLine: nextLine, lineCount: input.lineCount, expectedHash: metadata.sha256, expectedRevision: metadata.revision } : null };
}
export async function readMountedSource(mount: SourceMount, relative: string, input: unknown) {
  const request = sourceReadArgsSchema.parse(input);
  const read = await mountedText(mount, validateSourcePath(relative));
  assertSourceVersion(request, read);
  return sourceTextRange(read.text, request, { kind: 'mounted', path: relative, mountId: mount.id, mountRevision: mount.revision, sha256: read.sha256, revision: read.revision, byteSize: read.byteSize, visibility: 'gm', readOnly: true });
}
function assertSourceVersion(request: { expectedHash?: string; expectedRevision?: string }, value: { sha256: string; revision: string }) {
  if ((request.expectedHash && request.expectedHash !== value.sha256) || (request.expectedRevision && request.expectedRevision !== value.revision)) fail('SOURCE_CHANGED', 'This source changed. Search or read its current revision before continuing.');
}

const searchCursorSchema = z.object({ fingerprint: z.string(), stack: z.array(z.object({ path: z.string().max(1000), index: z.number().int().min(0).max(2048), snapshot: z.string().optional() }).strict()).max(100), line: z.number().int().min(0).max(1000000), fileHash: z.string().optional() }).strict();
export async function searchMountedSources(mount: SourceMount, input: unknown) {
  const request = sourceSearchArgsSchema.parse(input);
  const rootPath = validateSourcePath(request.path);
  const fingerprint = hash(JSON.stringify([mount.id, mount.revision, rootPath, request.query]));
  const prior = decodeCursor(request.cursor, searchCursorSchema);
  if (prior && prior.fingerprint !== fingerprint) fail('SOURCE_CURSOR_STALE', 'The source or search changed. Start the search again.');
  const state: z.infer<typeof searchCursorSchema> = prior ?? { fingerprint, stack: [{ path: rootPath, index: 0 }], line: 0 };
  // Cursor paths are untrusted: they may narrow the selected tree but cannot widen it.
  for (const frame of state.stack) {
    frame.path = validateSourcePath(frame.path);
    if (rootPath && frame.path !== rootPath && !frame.path.startsWith(rootPath + '/')) fail('SOURCE_CURSOR_INVALID', 'The cursor is outside this search folder.');
  }
  const matches: Array<Record<string, unknown>> = [];
  const directories = new Map<string, Awaited<ReturnType<typeof directoryEntries>>>();
  let scanned = 0, bytesScanned = 0, unsupported = 0;
  while (state.stack.length && matches.length < request.limit && scanned < 100 && bytesScanned < 2 * maxFileBytes) {
    const frame = state.stack.at(-1)!;
    let entries = directories.get(frame.path);
    if (!entries) { entries = await directoryEntries(mount, frame.path); directories.set(frame.path, entries); }
    const snapshot = hash(JSON.stringify(entries));
    if (frame.snapshot && frame.snapshot !== snapshot) fail('SOURCE_CURSOR_STALE', 'A source directory changed during search. Restart the search.');
    frame.snapshot = snapshot;
    const entry = entries[frame.index];
    if (!entry) { state.stack.pop(); state.line = 0; continue; }
    const relative = [frame.path, entry.name].filter(Boolean).join('/');
    if (entry.directory) {
      frame.index++; scanned++;
      if (state.stack.length >= 40) fail('SOURCE_DEPTH_LIMIT', 'Select a source folder closer to these files.');
      state.stack.push({ path: relative, index: 0 }); continue;
    }
    scanned++;
    let read: Awaited<ReturnType<typeof mountedText>>;
    try { read = await mountedText(mount, relative); }
    catch (error) {
      if (!(error instanceof MutationError)) throw error;
      if (!['SOURCE_TOO_LARGE', 'SOURCE_UNSUPPORTED', 'SOURCE_DENIED', 'SOURCE_PATH_DENIED'].includes(error.code)) throw error;
      unsupported++; frame.index++; state.line = 0; continue;
    }
    bytesScanned += read.byteSize;
    if (state.line && state.fileHash !== read.sha256) fail('SOURCE_CURSOR_STALE', 'This source changed during search. Restart the search.');
    const lines = read.text.replace(/\r\n/g, '\n').split('\n');
    let line = state.line;
    for (; line < lines.length && matches.length < request.limit; line++) {
      const index = lines[line].toLowerCase().indexOf(request.query.toLowerCase());
      if (index < 0) continue;
      matches.push({ sourceRef: mountRef(mount.id, relative), path: relative, mountId: mount.id, revision: read.revision, sha256: read.sha256,
        startLine: line + 1, endLine: line + 1, text: lines[line].slice(Math.max(0, index - 80), index + request.query.length + 200), snippetTruncated: lines[line].length > 280 + request.query.length, visibility: 'gm' });
    }
    if (line < lines.length) { state.line = line; state.fileHash = read.sha256; break; }
    frame.index++; state.line = 0; delete state.fileHash;
  }
  for (const [directory, entries] of directories) {
    if (hash(JSON.stringify(await directoryEntries(mount, directory))) !== hash(JSON.stringify(entries))) fail('SOURCE_CURSOR_STALE', 'A source directory changed during search. Restart the search.');
  }
  return { items: matches, nextCursor: state.stack.length ? encodeCursor(state) : null, truncated: state.stack.length > 0, scanned, skippedUnsupported: unsupported };
}

function scopedRecord(authority: SourceAuthority, row: { project_id?: unknown; game_id?: unknown; branch_id?: unknown; pov_character?: unknown; visibility?: unknown; deleted_at?: unknown; hidden?: unknown; source_deleted?: unknown }) {
  if (row.project_id !== authority.projectId || (row.game_id !== null && row.game_id !== authority.gameId) || row.deleted_at || row.hidden || row.source_deleted
    || (row.branch_id != null && row.branch_id !== (authority.branchId ?? null))
    || (row.pov_character != null && String(row.pov_character).trim().toLowerCase() !== authority.povCharacter?.trim().toLowerCase())
    || (authority.role === 'research' && !['public', 'player_known'].includes(String(row.visibility)))) fail('SCOPE_DENIED', 'Source is not available in this scope.');
}
const logicalText = (row: Record<string, unknown>) => `# ${row.title ?? row.name ?? ''}\n${row.description ?? ''}\n${JSON.stringify(row.data ?? {}, null, 2)}`;
function logicalEntry(row: Record<string, unknown>, sourceKind: 'content' | 'canonical') {
  const sourceRef = sourceKind === 'content' ? `content:${row.id}` : `canonical:${row.kind}:${row.record_id}`;
  return { sourceRef, name: row.title, path: [row.folder, `${row.slug}.${row.extension ?? 'json'}`].filter(Boolean).join('/'),
    kind: 'file', revision: sourceKind === 'canonical' ? `${row.revision}:${row.source_revision ?? 0}` : `${row.revision}:${row.type_revision ?? 0}`, visibility: row.visibility ?? 'gm',
    ...(sourceKind === 'canonical' ? { canonicalKind: row.kind } : {}),
    ...(row.data != null && sourceKind === 'content' ? { sha256: hash(logicalText(row)) } : {}) };
}
async function logicalSources(authority: SourceAuthority, request: ReturnType<typeof sourceListArgsSchema.parse> | ReturnType<typeof sourceSearchArgsSchema.parse>) {
  validateContentFolder(request.path);
  const kind = request.sourceKind === 'canonical' ? 'canonical' : 'content';
  if (kind === 'canonical' && !authority.gameId) return { items: [], nextCursor: null, truncated: false };
  const query = 'query' in request ? request.query : '';
  const fingerprint = hash(JSON.stringify([authority, kind, request.path, query]));
  const offset = pageOffset(request.cursor, fingerprint);
  const pov = authority.povCharacter?.trim().toLowerCase() ?? null;
  const canonicalVisibility = sql`case when c.kind='factions' then case when fe.visibility='secret' then 'secret' else coalesce(f.metadata->>'visibility','gm') end else coalesce(e.visibility,'secret') end`;
  const rowData = kind === 'content' ? sql`i.data` : sql`case when c.kind='factions' then jsonb_build_object('goals',f.goals,'resources',f.resources,'members',f.member_entity_ids,'metadata',f.metadata - 'originalMetadata' - 'entityResolver' - 'activationPlan') else jsonb_build_object('state',e.state,'status',e.status,'metadata',e.metadata - 'originalMetadata' - 'entityResolver' - 'activationPlan') end`;
  const catalog = kind === 'content'
    ? sql`select i.id,i.title,i.description,i.folder,i.slug,i.visibility,i.revision,t.revision as type_revision,t.extension,${query ? rowData : sql`null::jsonb`} as data
      from content_items i join content_types t on t.id=i.type_id and t.project_id=i.project_id
      where i.project_id=${authority.projectId} and (i.game_id is null or i.game_id=${authority.gameId}) and i.deleted_at is null
      and i.visibility in ${authority.role === 'research' ? sql`('public')` : sql`('public','gm')`}
      and (i.branch_id is null or i.branch_id=${authority.branchId ?? null}) and (i.pov_character is null or lower(i.pov_character)=${pov})
      and (${request.path}='' or i.folder=${request.path} or starts_with(i.folder,${request.path + '/'}))
      ${query ? sql`and strpos(lower(i.title || ' ' || i.description || ' ' || i.data::text),lower(${query}))>0` : sql``}`
    : sql`select c.id,c.kind,c.record_id,coalesce(e.name,f.name,c.record_id) as title,coalesce(e.description,f.metadata->>'description','') as description,c.folder,c.slug,c.revision,
      coalesce(t.revision,0) as type_revision,coalesce(e.server_version,f.server_version,0) as source_revision,${canonicalVisibility} as visibility,${query ? rowData : sql`null::jsonb`} as data
      from canonical_content c left join canonical_type_settings t on t.project_id=c.project_id and t.kind=c.kind
      left join entities e on e.id=c.record_id and e.story_id=c.game_id and c.kind<>'factions'
      left join factions f on f.id=c.record_id and f.story_id=c.game_id and c.kind='factions'
      left join entities fe on fe.id=f.entity_id and fe.story_id=f.story_id
      where c.project_id=${authority.projectId} and c.game_id=${authority.gameId} and not c.hidden and not c.source_deleted and (e.id is not null or f.id is not null)
      ${authority.role === 'research' ? sql`and ${canonicalVisibility} in ('public','player_known')` : sql``}
      and (c.branch_id is null or c.branch_id=${authority.branchId ?? null}) and (c.pov_character is null or lower(c.pov_character)=${pov})
      and (${request.path}='' or c.folder=${request.path} or starts_with(c.folder,${request.path + '/'}))
      ${query ? sql`and strpos(lower(coalesce(e.name,f.name,'') || ' ' || coalesce(e.description,f.metadata->>'description','') || ' ' || ${rowData}::text),lower(${query}))>0` : sql``}`;
  const rows = query ? await getDb().execute(sql`${catalog} order by folder,title,id limit ${request.limit + 1} offset ${offset}`)
    : (await getDb().execute(sql`with sources as (${catalog}), children as (
        select to_jsonb(s) as entry from sources s where s.folder=${request.path}
        union all select distinct jsonb_build_object('directory',true,'title',split_part(case when ${request.path}='' then s.folder else substring(s.folder from length(${request.path})+2) end,'/',1),
          'folder',case when ${request.path}='' then '' else ${request.path + '/'} end || split_part(case when ${request.path}='' then s.folder else substring(s.folder from length(${request.path})+2) end,'/',1))
          from sources s where s.folder<>${request.path}
      ) select entry from children order by entry->>'directory' desc nulls last,entry->>'folder',entry->>'title',entry->>'id' limit ${request.limit + 1} offset ${offset}`))
      .map(row => row.entry as Record<string, unknown>);
  const items = rows.slice(0, request.limit).map(row => {
    if (row.directory) return { kind: 'directory', path: row.folder, name: row.title, readOnly: true };
    const entry = logicalEntry(row, kind);
    if (!query) return entry;
    const text = logicalText(row), index = text.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, index - 80), end = index + query.length + 200;
    return { ...entry, text: text.slice(start, end), startLine: text.slice(0, start).split('\n').length, endLine: text.slice(0, end).split('\n').length, snippetTruncated: start > 0 || end < text.length };
  });
  return { items, nextCursor: rows.length > request.limit ? encodeCursor({ fingerprint, offset: offset + request.limit }) : null, truncated: rows.length > request.limit };
}

export async function listSourceFiles(authority: SourceAuthority, input: unknown) {
  assertRole(authority); const request = sourceListArgsSchema.parse(input);
  await projectScope(getDb(), authority.projectId, authority.gameId);
  if (request.sourceKind === 'mounts') {
    const rows = await getDb().execute(sql`select id,name,revision from source_mounts where project_id=${authority.projectId} and roles ? ${authority.role} order by name,id`);
    const fingerprint = hash(JSON.stringify([authority.projectId, authority.role, rows]));
    const offset = pageOffset(request.cursor, fingerprint);
    return { items: rows.slice(offset, offset + request.limit).map(row => ({ mountId: row.id, name: row.name, revision: row.revision, kind: 'mount', readOnly: true })), nextCursor: offset + request.limit < rows.length ? encodeCursor({ fingerprint, offset: offset + request.limit }) : null };
  }
  if (request.sourceKind === 'mounted') { const mount = await mountFor(authority, request.mountId); return sourceFilesystem(() => listMountedSources(mount, request)); }
  return logicalSources(authority, request);
}
export async function searchSourceFiles(authority: SourceAuthority, input: unknown) {
  assertRole(authority); const request = sourceSearchArgsSchema.parse(input);
  await projectScope(getDb(), authority.projectId, authority.gameId);
  if (request.sourceKind === 'mounted') { const mount = await mountFor(authority, request.mountId); return sourceFilesystem(() => searchMountedSources(mount, request)); }
  return logicalSources(authority, request);
}
export async function readSourceFile(authority: SourceAuthority, input: unknown) {
  assertRole(authority); const request = sourceReadArgsSchema.parse(input);
  await projectScope(getDb(), authority.projectId, authority.gameId);
  const mounted = request.sourceRef.match(/^mount:([^:]+):(.+)$/);
  if (mounted) {
    let relative: string;
    try { relative = decodeURIComponent(mounted[2]); } catch { return fail('SOURCE_PATH_DENIED', 'Invalid source path encoding.'); }
    const mount = await mountFor(authority, mounted[1]);
    return { ...await sourceFilesystem(() => readMountedSource(mount, relative, request)), sourceScope: { branchId: authority.branchId ?? null, povCharacter: authority.povCharacter ?? null } };
  }
  const content = request.sourceRef.match(/^content:(.+)$/);
  let row: Record<string, unknown>, entry: ReturnType<typeof logicalEntry>;
  if (content) {
    const item = (await readContent({ projectId: authority.projectId, ...(authority.gameId ? { gameId: authority.gameId } : {}), ids: [content[1]] })).items[0];
    scopedRecord(authority, item);
    row = item as unknown as Record<string, unknown>;
    entry = logicalEntry(row, 'content');
  } else {
    const canonical = request.sourceRef.match(/^canonical:(characters|locations|items|factions):(.+)$/);
    if (!canonical || !authority.gameId) return fail('SCOPE_DENIED', 'Source is not available in this scope.');
    const result = await readCanonicalWorkspace({ projectId: authority.projectId, gameId: authority.gameId, kind: canonical[1], id: canonical[2] });
    if (!('record' in result)) return fail('SCOPE_DENIED', 'Source is not available in this scope.');
    const metadata = result.record.metadata as Record<string, unknown> | null;
    let visibility = result.record.visibility ?? 'secret';
    if (canonical[1] === 'factions') {
      const [linked] = result.record.entity_id ? await getDb().execute(sql`select visibility from entities where id=${String(result.record.entity_id)} and story_id=${authority.gameId}`) : [];
      visibility = linked?.visibility === 'secret' ? 'secret' : metadata?.visibility ?? 'gm';
    }
    scopedRecord(authority, { ...result.envelope, visibility });
    const data = { ...result.record, metadata: metadata ? Object.fromEntries(Object.entries(metadata).filter(([key]) => !['originalMetadata', 'entityResolver', 'activationPlan'].includes(key))) : {} };
    row = { ...result.envelope, title: result.record.name, description: result.record.description ?? metadata?.description ?? '', data, type_revision: 0, source_revision: result.revision.recordVersion, visibility };
    entry = logicalEntry(row, 'canonical');
  }
  const text = logicalText(row), sha256 = hash(text);
  assertSourceVersion(request, { sha256, revision: entry.revision });
  return sourceTextRange(text, request, { ...entry, sha256, readOnly: true, sourceScope: { branchId: authority.branchId ?? null, povCharacter: authority.povCharacter ?? null } });
}

/** Source inspection follows a completed run receipt; the UI cannot choose another role or scope. */
export async function readRunSourceFile(input: unknown) {
  const request = sourceRunReadSchema.parse(input);
  const receipts = await getDb().execute(sql`
    select 'gm'::text as role,r.project_id,r.game_id,c.result from agent_runs r join agent_tool_calls c on c.run_id=r.id
    where r.id=${request.runId} and r.project_id=${request.projectId} and r.game_id is not distinct from ${request.gameId ?? null}
      and c.tool='read' and c.status='completed' and c.result->>'sourceRef'=${request.sourceRef}
      and c.result->>'visibility' in ('public','player_known')
    union all
    select 'assistant'::text as role,v.project_id,v.game_id,c.result from assistant_runs r
    join assistant_conversations v on v.id=r.conversation_id join assistant_tool_calls c on c.run_id=r.id
    where r.id=${request.runId} and v.project_id=${request.projectId} and v.game_id is not distinct from ${request.gameId ?? null}
      and c.tool='read' and c.status='completed' and c.result->>'sourceRef'=${request.sourceRef}`);
  const receiptSchema = z.object({ sourceRef: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), sourceScope: z.object({ branchId: z.string().nullable(), povCharacter: z.string().nullable() }).strict() });
  const candidates = receipts.map(row => ({ row, result: receiptSchema.safeParse(row.result) })).filter(value => value.result.success);
  const candidate = candidates.find(value => {
    const receipt = value.result.data!;
    const startLine = request.startLine ?? receipt.startLine;
    const lastLine = startLine + (request.lineCount ?? Math.min(200, receipt.endLine - startLine + 1)) - 1;
    return startLine >= receipt.startLine && startLine <= receipt.endLine && lastLine <= receipt.endLine
      && (!request.expectedHash || request.expectedHash === receipt.sha256) && (!request.expectedRevision || request.expectedRevision === receipt.revision);
  });
  if (!candidate?.result.success) return fail('SCOPE_DENIED', 'This source range was not read by the selected run.');
  const receipt = candidate.result.data;
  const startLine = request.startLine ?? receipt.startLine;
  return readSourceFile({ role: candidate.row.role as 'gm' | 'assistant', projectId: String(candidate.row.project_id), gameId: candidate.row.game_id === null ? null : String(candidate.row.game_id), ...receipt.sourceScope },
    { sourceRef: receipt.sourceRef, startLine, lineCount: request.lineCount ?? Math.min(200, receipt.endLine - startLine + 1), expectedHash: receipt.sha256, expectedRevision: receipt.revision });
}
