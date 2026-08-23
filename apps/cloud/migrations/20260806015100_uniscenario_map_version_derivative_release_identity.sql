-- PostgreSQL truncated the foundation constraint name at 63 bytes. The prior
-- source-linkage migration used the untruncated spelling, so drop the actual
-- historical constraint here. Source XODR identity must not prevent immutable
-- derivative releases for the same source map.

BEGIN;

ALTER TABLE uniscenario.map_versions
  DROP CONSTRAINT IF EXISTS map_versions_workspace_id_xodr_sha256_coordinate_system_sha_key;

COMMIT;
