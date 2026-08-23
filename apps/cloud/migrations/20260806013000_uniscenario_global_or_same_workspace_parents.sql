-- Migration 20260806013000: fence the three nullable-workspace parent references to
-- global-or-same-workspace
--
-- Rollback: DROP TRIGGER uniscenario_map_versions_asset_catalog_scope_fence ON
--           uniscenario.map_versions; the matching
--           uniscenario_execution_packages_asset_catalog_scope_fence ON
--           uniscenario.execution_packages; and
--           uniscenario_render_jobs_render_profile_scope_fence ON uniscenario.render_jobs; then the
--           two owner-immutability fences uniscenario_asset_catalog_versions_owner_fence and
--           uniscenario_render_profiles_owner_fence; then
--           DROP FUNCTION uniscenario.enforce_global_or_same_workspace_parent() and
--           uniscenario.enforce_workspace_owner_immutable(). Dropping the triggers before the
--           functions is required. Reverting REOPENS the cross-tenant write path below, so it is a
--           containment regression, not a neutral undo. No column or index is touched, so nothing
--           else depends on the order.
--
-- WHAT THIS CLOSES. 20260806010000 and 20260806011000 made 44 uniscenario foreign keys composite so
-- a workspace can no longer reference another workspace's row. Three references had to be left
-- single-column because their PARENT's workspace_id is NULLABLE, where NULL means a platform-global
-- row shared by every workspace:
--
--   uniscenario.map_versions.asset_catalog_version_id       -> asset_catalog_versions
--   uniscenario.execution_packages.asset_catalog_version_id -> asset_catalog_versions
--   uniscenario.render_jobs.render_profile_id               -> render_profiles
--
-- A composite (id, workspace_id) key can never match a NULL workspace_id, so composing these would
-- make global rows unreferenceable and break the sharing they exist for. But leaving them bare means
-- they are the only tenancy-unconstrained references left in the schema: a workspace-A row may today
-- point at a workspace-B NON-GLOBAL parent, which is neither global sharing nor same-workspace
-- ownership. That is the gap this closes. The rule enforced is exactly:
--
--     the parent is global (workspace_id IS NULL), OR the parent's workspace equals the child's.
--
-- 20260804012000 already stated this rule in a comment on asset_catalog_versions -- "a
-- workspace-scoped catalog may only be referenced by rows in that workspace; application writes
-- enforce that ownership boundary" -- so the invariant is not new. Only its enforcement is. An
-- invariant enforced by "application writes" is enforced by every current AND future call site
-- remembering to, which is what the rest of this campaign has been removing.
--
-- WHY A TRIGGER FENCE AND NOT A DECLARATIVE CONSTRAINT. A row-level CHECK cannot read another table,
-- so the rule is not expressible as a CHECK. The fully declarative alternative does exist and was
-- worked out before this was written: give each parent a generated `workspace_scope TEXT GENERATED
-- ALWAYS AS (COALESCE(workspace_id, '*')) STORED` with UNIQUE (id, workspace_scope), give each child
-- a scope column with CHECK (scope = workspace_id OR scope = '*'), and reference
-- parent(id, workspace_scope) with MATCH FULL so a NULL scope cannot bypass it. That is airtight and
-- unbypassable, and it was rejected for this migration for one concrete reason: because
-- asset_catalog_version_id is NOT NULL on both children, MATCH FULL forces the scope column to be
-- supplied on every insert, so the migration alone would break every existing INSERT until each
-- write site is changed in the same deploy. It cannot land as a schema-only change. If that
-- coordinated change is ever made, this fence should be replaced by it -- the fence is the
-- pragmatic form, not the ideal one.
--
-- A trigger fence is what this schema's conventions already carry: carla_jobs carries
-- carla_jobs_worker_requirements_v2_insert_fence and trg_carla_render_credit_admission_insert, both
-- guarding invariants on a control-plane table, and both raising ERRCODE 23514 with a CONSTRAINT
-- name so callers see a constraint violation rather than a bare exception. This follows that shape.
-- Unlike those two it fences UPDATE as well as INSERT, because moving either the pointer or the
-- child's workspace_id can break the rule just as easily as creating the row.
--
-- MEASURED EXPOSURE ON DEV BEFORE WRITING: 17 resolved references across the two
-- asset_catalog_versions edges, all same-workspace, ZERO cross-workspace and zero via a global
-- parent. The render_profiles edge has no rows at all -- uniscenario.render_profiles is empty -- and
-- no global row exists in either parent table yet, so the global path is real intent but not yet
-- exercised. There is nothing to clean up, and the validation block below will refuse to install the
-- fence if that ever stops being true.
--
-- THE ONE GENUINELY UNGUARDED WRITE PATH is render_jobs.render_profile_id. The other two are
-- derived: execution_packages inherits asset_catalog_version_id from a locked map_version row, and
-- map_versions is written only by scripts/seed-uniscenario-dev-maps.mjs today. But
-- app/lib/uniscenario/control-plane-store.ts inserts render_profile_id as a bare bind parameter
-- straight from caller input -- the surrounding INSERT ... SELECT validates the revision and the
-- execution package by joining on workspace_id, and validates render_profile_id not at all. It is
-- unexploitable only because render_profiles is currently empty. That is a latent hole, not a safe
-- one, and it is the reason this migration is worth its weight.
--
-- Note the asset_catalog_versions READ path already encodes this rule -- control-plane-store.ts
-- joins with `AND (acv.workspace_id IS NULL OR acv.workspace_id = j.workspace_id)`. That means a
-- cross-tenant catalog reference today fails CLOSED at dispatch: the render job is accepted and then
-- silently never dispatches, because the join drops it. Failing closed is better than leaking, but a
-- write that is accepted and then permanently unprocessable is its own defect, and this fence turns
-- it into an immediate, legible rejection at the point of the mistake.

BEGIN;

-- Refuse to install the fence over data that already violates it, matching how the composite
-- foreign keys in 20260806010000/011000 refuse to validate against a cross-tenant row. Without this
-- the fence would silently permit every pre-existing violation and only guard new writes.
DO $$
DECLARE
  offending BIGINT;
BEGIN
  SELECT count(*) INTO offending FROM (
    SELECT 1 FROM uniscenario.map_versions c
      JOIN uniscenario.asset_catalog_versions p ON p.id = c.asset_catalog_version_id
     WHERE p.workspace_id IS NOT NULL AND p.workspace_id <> c.workspace_id
    UNION ALL
    SELECT 1 FROM uniscenario.execution_packages c
      JOIN uniscenario.asset_catalog_versions p ON p.id = c.asset_catalog_version_id
     WHERE p.workspace_id IS NOT NULL AND p.workspace_id <> c.workspace_id
    UNION ALL
    SELECT 1 FROM uniscenario.render_jobs c
      JOIN uniscenario.render_profiles p ON p.id = c.render_profile_id
     WHERE p.workspace_id IS NOT NULL AND p.workspace_id <> c.workspace_id
  ) violations;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'refusing to install the global-or-same-workspace fence: % existing row(s) already reference a non-global parent owned by another workspace; resolve them first',
      offending;
  END IF;
END $$;

-- One function serves all three edges. The child column name, parent table, and constraint name
-- come from the trigger arguments, and the pointer value is read out of NEW through to_jsonb so the
-- function does not need to know any column names at compile time.
CREATE OR REPLACE FUNCTION uniscenario.enforce_global_or_same_workspace_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  child_column TEXT := TG_ARGV[0];
  parent_table TEXT := TG_ARGV[1];
  constraint_name TEXT := TG_ARGV[2];
  parent_id TEXT := to_jsonb(NEW) ->> child_column;
  parent_workspace TEXT;
  parent_found BOOLEAN := FALSE;
BEGIN
  -- A null pointer references nothing, so there is no ownership to check. render_profile_id is
  -- nullable; the two asset_catalog_version_id columns are NOT NULL and simply never take this path.
  IF parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT workspace_id, TRUE FROM uniscenario.%I WHERE id = $1',
    parent_table
  ) INTO parent_workspace, parent_found USING parent_id;

  -- A missing parent is the foreign key's job to reject, not this fence's. Staying silent here keeps
  -- the error the caller sees attributable to the constraint that actually failed.
  IF NOT parent_found THEN
    RETURN NEW;
  END IF;

  -- NULL parent workspace means a platform-global row, which every workspace may reference.
  IF parent_workspace IS NOT NULL AND parent_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = constraint_name,
      MESSAGE = format(
        '%s.%s references a uniscenario.%s owned by another workspace; the parent must be global or owned by this workspace',
        TG_TABLE_NAME, child_column, parent_table
      );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uniscenario_map_versions_asset_catalog_scope_fence ON uniscenario.map_versions;
CREATE TRIGGER uniscenario_map_versions_asset_catalog_scope_fence
BEFORE INSERT OR UPDATE OF asset_catalog_version_id, workspace_id ON uniscenario.map_versions
FOR EACH ROW
EXECUTE FUNCTION uniscenario.enforce_global_or_same_workspace_parent(
  'asset_catalog_version_id', 'asset_catalog_versions',
  'uniscenario_map_versions_asset_catalog_scope_fence'
);

DROP TRIGGER IF EXISTS uniscenario_execution_packages_asset_catalog_scope_fence ON uniscenario.execution_packages;
CREATE TRIGGER uniscenario_execution_packages_asset_catalog_scope_fence
BEFORE INSERT OR UPDATE OF asset_catalog_version_id, workspace_id ON uniscenario.execution_packages
FOR EACH ROW
EXECUTE FUNCTION uniscenario.enforce_global_or_same_workspace_parent(
  'asset_catalog_version_id', 'asset_catalog_versions',
  'uniscenario_execution_packages_asset_catalog_scope_fence'
);

DROP TRIGGER IF EXISTS uniscenario_render_jobs_render_profile_scope_fence ON uniscenario.render_jobs;
CREATE TRIGGER uniscenario_render_jobs_render_profile_scope_fence
BEFORE INSERT OR UPDATE OF render_profile_id, workspace_id ON uniscenario.render_jobs
FOR EACH ROW
EXECUTE FUNCTION uniscenario.enforce_global_or_same_workspace_parent(
  'render_profile_id', 'render_profiles',
  'uniscenario_render_jobs_render_profile_scope_fence'
);

-- THE PARENT SIDE. Fencing only the children leaves the invariant reachable from the other
-- direction: a parent created global, referenced by many workspaces, could later be UPDATEd to
-- workspace-scoped and every one of those references would become cross-tenant without any child
-- row changing. The child fences cannot see that happen. Rather than re-validate every referencing
-- row on parent update, workspace ownership is made immutable: a catalog version or render profile
-- does not change owner, and 20260804012000 already treats these rows as immutable provenance.
-- Deleting and recreating is the supported way to change ownership, and RESTRICT/CASCADE on the
-- existing foreign keys already governs whether that is allowed.
CREATE OR REPLACE FUNCTION uniscenario.enforce_workspace_owner_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = TG_ARGV[0],
      MESSAGE = format(
        'uniscenario.%s.workspace_id is immutable: changing it would silently make existing references cross-tenant',
        TG_TABLE_NAME
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uniscenario_asset_catalog_versions_owner_fence ON uniscenario.asset_catalog_versions;
CREATE TRIGGER uniscenario_asset_catalog_versions_owner_fence
BEFORE UPDATE OF workspace_id ON uniscenario.asset_catalog_versions
FOR EACH ROW
EXECUTE FUNCTION uniscenario.enforce_workspace_owner_immutable(
  'uniscenario_asset_catalog_versions_owner_fence'
);

DROP TRIGGER IF EXISTS uniscenario_render_profiles_owner_fence ON uniscenario.render_profiles;
CREATE TRIGGER uniscenario_render_profiles_owner_fence
BEFORE UPDATE OF workspace_id ON uniscenario.render_profiles
FOR EACH ROW
EXECUTE FUNCTION uniscenario.enforce_workspace_owner_immutable(
  'uniscenario_render_profiles_owner_fence'
);

COMMIT;
