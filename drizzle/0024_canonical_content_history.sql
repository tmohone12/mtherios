-- Presentation metadata only. Current domain payloads remain in entities/factions.
create table canonical_content (
  id text primary key default gen_random_uuid()::text,
  project_id text not null references shelves(id) on delete cascade,
  game_id text not null, kind text not null check(kind in ('characters','locations','items','factions')),
  record_id text not null, folder text not null default '', slug text not null,
  gm_context_mode text check(gm_context_mode in ('pinned','partial','searchable')),
  hidden boolean not null default false, source_deleted boolean not null default false,
  revision integer not null default 1 check(revision > 0), adapter_version integer not null default 1 check(adapter_version = 1),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint canonical_content_game_project_fk foreign key(project_id,game_id) references stories(shelf_id,id) on delete cascade,
  constraint canonical_content_target_unique unique(game_id,kind,record_id),
  constraint canonical_content_path_unique unique(game_id,kind,folder,slug)
);
create table canonical_content_history (
  content_id text not null references canonical_content(id) on delete cascade,
  revision integer not null, snapshot jsonb not null, actor jsonb not null, reason text not null,
  created_at timestamptz not null default now(), primary key(content_id,revision)
);

create function mythengine_capture_canonical_content(payload jsonb, adapter text, removed boolean, reason text) returns void language plpgsql as $$
declare project text; envelope canonical_content;
begin
  select shelf_id into project from stories where id = payload->>'story_id';
  -- A campaign deletion owns its records and catalog/history cascade.
  if project is null then return; end if;
  insert into canonical_content(project_id,game_id,kind,record_id,slug,source_deleted)
  values(project,payload->>'story_id',adapter,payload->>'id','record-' || md5(payload->>'id'),removed)
  on conflict(game_id,kind,record_id) do update set
    revision=canonical_content.revision+1, source_deleted=excluded.source_deleted, updated_at=now()
  returning * into envelope;
  insert into canonical_content_history(content_id,revision,snapshot,actor,reason)
  values(envelope.id,envelope.revision,jsonb_build_object('envelope',to_jsonb(envelope),'record',payload),
    coalesce(nullif(current_setting('mythengine.content_actor',true),'')::jsonb,'{"role":"backend_writer","id":"unattributed"}'::jsonb),reason);
end $$;

create function mythengine_canonical_content_trigger() returns trigger language plpgsql as $$
declare before_kind text; after_kind text;
begin
  if TG_OP <> 'INSERT' then
    if TG_TABLE_NAME='factions' then before_kind := 'factions';
    else before_kind := case OLD.type when 'character' then 'characters' when 'location' then 'locations' when 'item' then 'items' end; end if;
  end if;
  if TG_OP <> 'DELETE' then
    if TG_TABLE_NAME='factions' then after_kind := 'factions';
    else after_kind := case NEW.type when 'character' then 'characters' when 'location' then 'locations' when 'item' then 'items' end; end if;
  end if;
  if TG_OP='UPDATE' and (OLD.id <> NEW.id or OLD.story_id <> NEW.story_id) then
    raise exception 'Canonical identity and game ownership cannot change in place';
  end if;
  if before_kind is not null and (TG_OP='DELETE' or before_kind is distinct from after_kind) then
    perform mythengine_capture_canonical_content(to_jsonb(OLD),before_kind,true,'Canonical source removed or retyped');
  end if;
  if after_kind is not null then
    perform mythengine_capture_canonical_content(to_jsonb(NEW),after_kind,false,
      case when TG_OP='INSERT' then 'Canonical creation baseline' else 'Canonical source update' end);
  end if;
  return null;
end $$;

create trigger entities_content_history after insert or update or delete on entities for each row execute function mythengine_canonical_content_trigger();
create trigger factions_content_history after insert or update or delete on factions for each row execute function mythengine_canonical_content_trigger();

-- Existing data receives one truthful cutover baseline, not invented past versions.
select mythengine_capture_canonical_content(to_jsonb(e),case e.type when 'character' then 'characters' when 'location' then 'locations' when 'item' then 'items' end,false,'Migration baseline') from entities e where e.type in ('character','location','item');
select mythengine_capture_canonical_content(to_jsonb(f),'factions',false,'Migration baseline') from factions f;
