alter table agent_interactions drop constraint agent_interactions_kind_check;
alter table agent_interactions add constraint agent_interactions_kind_check check (kind in ('question','roll'));