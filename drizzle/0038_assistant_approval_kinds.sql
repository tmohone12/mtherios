alter table assistant_restore_approvals rename to assistant_approvals;
alter table assistant_approvals add column kind text not null default 'restore'
  check (kind in ('restore', 'layout_clear'));
alter index assistant_restore_approvals_one_pending_run rename to assistant_approvals_one_pending_run;
