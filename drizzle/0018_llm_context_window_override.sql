ALTER TABLE llm_service_settings
ADD COLUMN IF NOT EXISTS context_window_tokens integer;
