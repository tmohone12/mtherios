alter table assistant_conversations add column if not exists chatgpt_owner_hash text;
alter table assistant_conversations add column if not exists chatgpt_account_key text;
alter table assistant_conversations add constraint assistant_chatgpt_scope_pair check ((chatgpt_owner_hash is null) = (chatgpt_account_key is null));
