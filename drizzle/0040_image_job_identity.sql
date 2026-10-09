CREATE UNIQUE INDEX assets_origin_job_unique ON assets(origin_job_id) WHERE origin_job_id IS NOT NULL;
