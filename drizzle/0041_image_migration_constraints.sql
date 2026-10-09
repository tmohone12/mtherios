ALTER TABLE assets DROP CONSTRAINT assets_game_project_fk;
ALTER TABLE assets ADD CONSTRAINT assets_game_project_fk
  FOREIGN KEY (project_id, game_id) REFERENCES stories(shelf_id, id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE content_items DROP CONSTRAINT content_items_cover_asset_project_fk;
ALTER TABLE content_items ADD CONSTRAINT content_items_cover_asset_project_fk
  FOREIGN KEY (project_id, cover_asset_id) REFERENCES assets(project_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
