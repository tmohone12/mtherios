ALTER TABLE IF EXISTS memory_nodes
	ALTER COLUMN embedding TYPE vector
	USING embedding::vector;
