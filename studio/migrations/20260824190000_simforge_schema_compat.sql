-- Canonicalize the per-install Studio schema without invalidating existing databases.
-- Historical migrations remain immutable because their filenames are schema_migrations keys.
--
-- simforge already contains the local model registry, so move each legacy object rather
-- than renaming the whole schema. PostgreSQL preserves table/index/constraint/trigger OIDs.
DO $$
DECLARE
  object RECORD;
  statement TEXT;
BEGIN
  FOR object IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'uniscenario'
       AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
     ORDER BY CASE c.relkind
       WHEN 'S' THEN 0 WHEN 'r' THEN 1 WHEN 'p' THEN 1 WHEN 'f' THEN 1
       WHEN 'v' THEN 2 WHEN 'm' THEN 2 ELSE 3 END,
       c.relname
  LOOP
    statement := CASE object.relkind
      WHEN 'S' THEN format('ALTER SEQUENCE uniscenario.%I SET SCHEMA simforge', object.relname)
      WHEN 'v' THEN format('ALTER VIEW uniscenario.%I SET SCHEMA simforge', object.relname)
      WHEN 'm' THEN format('ALTER MATERIALIZED VIEW uniscenario.%I SET SCHEMA simforge', object.relname)
      ELSE format('ALTER TABLE uniscenario.%I SET SCHEMA simforge', object.relname)
    END;
    EXECUTE statement;
  END LOOP;

  FOR object IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'uniscenario'
       AND p.prokind = 'f'
     ORDER BY p.proname, arguments
  LOOP
    EXECUTE format(
      'ALTER FUNCTION uniscenario.%I(%s) SET SCHEMA simforge',
      object.proname,
      object.arguments
    );
  END LOOP;
END
$$;

DROP SCHEMA uniscenario;

-- Deprecated compatibility schema. Simple one-table views are automatically updatable in
-- PostgreSQL/PGlite, so an older Studio process can continue both reading and writing while
-- all current code addresses the canonical simforge schema.
CREATE SCHEMA uniscenario;

DO $$
DECLARE
  relation RECORD;
BEGIN
  FOR relation IN
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'simforge'
       AND table_type IN ('BASE TABLE', 'VIEW')
     ORDER BY table_name
  LOOP
    EXECUTE format(
      'CREATE VIEW uniscenario.%I AS SELECT * FROM simforge.%I',
      relation.table_name,
      relation.table_name
    );
  END LOOP;
END
$$;

COMMENT ON SCHEMA uniscenario IS
  'Deprecated compatibility views for pre-SimForge Studio code; canonical objects live in simforge.';
