alter table assistant_approvals drop constraint assistant_approvals_kind_check;
alter table assistant_approvals add constraint assistant_approvals_kind_check
  check (kind in ('restore', 'layout_clear', 'story_edit'));
