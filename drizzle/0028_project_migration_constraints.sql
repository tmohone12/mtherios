-- Keep ownership constraints enforced at commit during an explicit atomic project move.
alter table content_items alter constraint content_items_type_project_fk deferrable initially immediate;
alter table content_items alter constraint content_items_game_project_fk deferrable initially immediate;
alter table canonical_content alter constraint canonical_content_game_project_fk deferrable initially immediate;
alter table content_folders alter constraint content_folders_project_id_game_id_fkey deferrable initially immediate;
alter table backend_jobs alter constraint backend_jobs_game_project_fk deferrable initially immediate;
