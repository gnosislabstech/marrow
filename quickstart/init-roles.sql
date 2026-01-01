-- quickstart/init-roles.sql — PostgREST role scaffolding.
--
-- Mounted into /docker-entrypoint-initdb.d so it runs at db FIRST BOOT — the
-- roles then exist before PostgREST tries to connect (otherwise rest can't auth
-- as `authenticator` and crashes at `up`). Roles are cluster-level, so they
-- survive the schema drop/recreate that seed.ts does; the schema-level grants
-- live in seed.ts for that reason.
--
-- NONE of this ships to a real deploy — it only wires PostgREST's
-- authenticator → anon / service_role switching for the disposable local stack.

DO $$ BEGIN
  -- The role PostgREST logs in as; owns no data, only SET ROLEs to the others.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN PASSWORD 'postgres' NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  -- service_role bypasses RLS, mirroring Supabase's service key (the engine's path).
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT anon, service_role TO authenticator;
