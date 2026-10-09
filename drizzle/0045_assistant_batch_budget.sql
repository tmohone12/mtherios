alter table assistant_batches add column budget jsonb not null default '{}'::jsonb;
alter table assistant_batches add constraint assistant_batches_budget_object_check check (jsonb_typeof(budget)='object');
