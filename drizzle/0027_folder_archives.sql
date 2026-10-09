alter table content_folders add column archived_at timestamptz;
alter table content_folders add column archive_receipt jsonb;
alter table content_folders add constraint content_folders_archive_receipt_check check(archive_receipt is null or (archived_at is not null and jsonb_typeof(archive_receipt)='object'));
