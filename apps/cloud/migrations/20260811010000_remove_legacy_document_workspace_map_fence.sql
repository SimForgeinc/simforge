-- Migration 20260811010000: remove the legacy workspace fence from document maps.
--
-- Published maps are platform-global. `map_versions.workspace_id` records the
-- immutable publication owner; it is provenance, not an authoring boundary.
-- Migration 20260807010000 replaced the standard document/map foreign key with
-- an id-only reference, but an older explicitly named composite constraint can
-- coexist with it on databases that passed through the tenant-scoped migration.
-- That leftover constraint rejects scenario creation whenever the document and
-- globally published map have different workspace ids.

BEGIN;

ALTER TABLE uniscenario.documents
  DROP CONSTRAINT IF EXISTS uniscenario_documents_workspace_map_fk;

COMMIT;
