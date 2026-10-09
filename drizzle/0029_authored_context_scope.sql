alter table content_items add column branch_id text, add column pov_character text;
alter table canonical_content add column branch_id text, add column pov_character text;
alter table content_items add constraint content_items_pov_character_check check (pov_character is null or length(trim(pov_character)) between 1 and 200);
alter table canonical_content add constraint canonical_content_pov_character_check check (pov_character is null or length(trim(pov_character)) between 1 and 200);
create index content_items_context_scope_idx on content_items(project_id,game_id,branch_id,pov_character) where deleted_at is null;
create index canonical_content_context_scope_idx on canonical_content(project_id,game_id,branch_id,pov_character) where not hidden and not source_deleted;
