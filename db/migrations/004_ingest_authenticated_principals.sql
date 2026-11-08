CREATE ROLE efra_ingest_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE efra_ingest_projector NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA efra_ingest TO efra_ingest_publisher, efra_ingest_projector;

CREATE TABLE efra_ingest.authenticated_principal (
  login_role name PRIMARY KEY,
  login_oid oid NOT NULL UNIQUE,
  subject_id text NOT NULL UNIQUE CHECK (btrim(subject_id) <> ''),
  capability text NOT NULL CHECK (capability IN ('IMPORTER', 'REVIEWER', 'PUBLISHER', 'PROJECTOR', 'READER')),
  active boolean NOT NULL DEFAULT true
);

CREATE FUNCTION efra_ingest.authenticated_subject(required_capability text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  subject text;
  group_role name;
BEGIN
  group_role := CASE required_capability
    WHEN 'IMPORTER' THEN 'efra_ingest_importer' WHEN 'REVIEWER' THEN 'efra_ingest_reviewer'
    WHEN 'PUBLISHER' THEN 'efra_ingest_publisher' WHEN 'PROJECTOR' THEN 'efra_ingest_projector'
    WHEN 'READER' THEN 'efra_ingest_reader' END;
  SELECT p.subject_id INTO subject FROM efra_ingest.authenticated_principal AS p
  JOIN pg_roles r ON r.oid = p.login_oid AND r.rolname = p.login_role AND r.rolcanlogin
  WHERE p.login_role = session_user AND p.capability = required_capability AND p.active
    AND pg_has_role(session_user, group_role, 'MEMBER');
  IF subject IS NULL THEN
    RAISE EXCEPTION 'No active EFRA principal for %', required_capability USING ERRCODE = '42501';
  END IF;
  RETURN subject;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.authenticated_subject(text) FROM PUBLIC;

CREATE FUNCTION efra_ingest.check_importer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM efra_ingest.authenticated_subject('IMPORTER');
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.check_importer() FROM PUBLIC;
CREATE TRIGGER check_importer BEFORE INSERT ON efra_ingest.source_revision
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.check_importer();
CREATE TRIGGER check_importer BEFORE INSERT ON efra_ingest.import_batch
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.check_importer();
CREATE TRIGGER check_importer BEFORE INSERT ON efra_ingest.staged_game
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.check_importer();
CREATE TRIGGER check_importer BEFORE INSERT ON efra_ingest.quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.check_importer();

ALTER FUNCTION efra_ingest.resolve_import_identities(text, text, text, jsonb) RENAME TO resolve_import_identities_internal;
REVOKE EXECUTE ON FUNCTION efra_ingest.resolve_import_identities_internal(text, text, text, jsonb) FROM efra_ingest_importer;
CREATE FUNCTION efra_ingest.resolve_import_identities(
  provider_code text, league_key text, season_key text, candidates jsonb
) RETURNS TABLE (competition_id uuid, season_id uuid, resolved jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM efra_ingest.authenticated_subject('IMPORTER');
  RETURN QUERY SELECT * FROM efra_ingest.resolve_import_identities_internal(provider_code, league_key, season_key, candidates);
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.resolve_import_identities(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.resolve_import_identities(text, text, text, jsonb) TO efra_ingest_importer;

ALTER TABLE efra_ingest.review ADD COLUMN reviewer_login name;
ALTER TABLE efra_ingest.snapshot ADD COLUMN released_by text, ADD COLUMN release_login name,
  ADD CONSTRAINT release_identity_pair CHECK ((released_by IS NULL) = (release_login IS NULL));

CREATE OR REPLACE FUNCTION efra_ingest.record_review_time() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  NEW.reviewer_id := efra_ingest.authenticated_subject('REVIEWER');
  NEW.reviewer_login := session_user;
  NEW.reviewed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION efra_ingest.record_snapshot_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  NEW.released_by := efra_ingest.authenticated_subject('PUBLISHER');
  NEW.release_login := session_user;
  NEW.created_xid := pg_current_xact_id();
  RETURN NEW;
END;
$$;

REVOKE INSERT (stage_id, stage_status, decision, reviewer_id, reason) ON efra_ingest.review FROM efra_ingest_reviewer;
REVOKE INSERT (id, competition_id, season_id, schema_version, as_of) ON efra_ingest.snapshot FROM efra_ingest_reviewer;
REVOKE INSERT (snapshot_id, stage_id, game_id, player_id, position) ON efra_ingest.snapshot_game FROM efra_ingest_reviewer;

CREATE FUNCTION efra_ingest.record_authenticated_review(request_stage bigint, request_decision text, request_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor text := efra_ingest.authenticated_subject('REVIEWER');
  existing efra_ingest.review%ROWTYPE;
BEGIN
  INSERT INTO efra_ingest.review (stage_id, stage_status, decision, reviewer_id, reason)
  SELECT id, status, request_decision, actor, request_reason FROM efra_ingest.staged_game WHERE id = request_stage
  ON CONFLICT (stage_id) DO NOTHING;
  IF FOUND THEN RETURN 'REVIEWED'; END IF;
  SELECT * INTO existing FROM efra_ingest.review WHERE stage_id = request_stage;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown staging row' USING ERRCODE = '23503'; END IF;
  IF existing.reviewer_id = actor AND existing.reviewer_login = session_user
    AND existing.decision = request_decision AND existing.reason = request_reason THEN RETURN 'ALREADY_REVIEWED'; END IF;
  RETURN 'REVIEW_CONFLICT';
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.record_authenticated_review(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.record_authenticated_review(bigint, text, text) TO efra_ingest_reviewer;

CREATE FUNCTION efra_ingest.release_snapshot(
  request_id text, competition text, season text, schema_version text, cutoff timestamptz, members bigint[]
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  n bigint;
  existing efra_ingest.snapshot%ROWTYPE;
BEGIN
  PERFORM efra_ingest.authenticated_subject('PUBLISHER');
  IF cardinality(members) IS NULL OR cardinality(members) = 0
    OR cardinality(members) <> (SELECT count(DISTINCT x) FROM unnest(members) AS x)
    OR cutoff IS NULL OR NOT isfinite(cutoff) OR cutoff > clock_timestamp() THEN
    RAISE EXCEPTION 'Invalid snapshot members or cutoff' USING ERRCODE = '23514';
  END IF;
  INSERT INTO efra_ingest.snapshot (id, competition_id, season_id, schema_version, as_of)
  VALUES (request_id, competition, season, schema_version, cutoff) ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO existing FROM efra_ingest.snapshot WHERE id = request_id;
    IF (existing.competition_id, existing.season_id, existing.schema_version, existing.as_of)
        = (competition, season, schema_version, cutoff)
      AND ARRAY(SELECT stage_id FROM efra_ingest.snapshot_game WHERE snapshot_id = request_id ORDER BY stage_id)
        = ARRAY(SELECT unnest(members) ORDER BY 1) THEN RETURN 'ALREADY_CREATED'; END IF;
    RETURN 'SNAPSHOT_CONFLICT';
  END IF;
  INSERT INTO efra_ingest.snapshot_game (snapshot_id, stage_id, game_id, player_id, position)
  SELECT request_id, g.id, g.game_id, g.player_id, g.position FROM efra_ingest.staged_game AS g
  JOIN efra_ingest.review AS r ON r.stage_id = g.id AND r.reviewer_login IS NOT NULL
  WHERE g.id = ANY(members) ORDER BY g.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(members) THEN
    RAISE EXCEPTION 'Snapshot contains unknown or unauthenticated reviews' USING ERRCODE = '23514';
  END IF;
  RETURN 'CREATED';
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.release_snapshot(text, text, text, text, timestamptz, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.release_snapshot(text, text, text, text, timestamptz, bigint[]) TO efra_ingest_publisher;

CREATE FUNCTION efra_ingest.authorize_snapshot_read() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT efra_ingest.authenticated_subject('READER') IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION efra_ingest.authorize_snapshot_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.authorize_snapshot_read() TO efra_ingest_reader;
ALTER VIEW efra_ingest.approved_snapshot_export RENAME TO approved_snapshot_export_internal;
REVOKE SELECT ON efra_ingest.approved_snapshot_export_internal FROM efra_ingest_reader;
CREATE VIEW efra_ingest.approved_snapshot_export WITH (security_barrier = true) AS
SELECT e.* FROM efra_ingest.approved_snapshot_export_internal e
JOIN efra_ingest.snapshot s ON s.id = e."snapshotId"
WHERE s.release_login IS NOT NULL AND efra_ingest.authorize_snapshot_read();
GRANT SELECT ON efra_ingest.approved_snapshot_export TO efra_ingest_reader;
