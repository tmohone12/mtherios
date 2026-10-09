-- Existing ambiguous Research-off choices stay off. New projects inherit shipped defaults.
-- Preserve explicit versioned documents and all unrelated settings.
update shelves
set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('agentTools', jsonb_build_object(
  'schemaVersion', 1, 'revision', 1, 'overrides', jsonb_build_object(
    'gmResearch', coalesce((select enabled from llm_service_settings where service_id = 'activeRecall'), false)
  )
)), server_version = server_version + 1, updated_at = now()
where not (coalesce(settings, '{}'::jsonb) ? 'agentTools');

update stories
set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('agentTools', jsonb_build_object(
  'schemaVersion', 1, 'revision', 1, 'overrides', jsonb_build_object(
    'gmResearch', coalesce((select enabled from llm_service_settings where service_id = 'activeRecall'), false)
  ) || case when settings ? 'imageGenerationMode' then jsonb_build_object('gmImages', settings->>'imageGenerationMode' <> 'none') else '{}'::jsonb end
)), server_version = server_version + 1, updated_at = now()
where not (coalesce(settings, '{}'::jsonb) ? 'agentTools');
