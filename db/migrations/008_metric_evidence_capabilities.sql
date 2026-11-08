-- Existing releases without this evidence chain require a separately reviewed backfill.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM efra_ingest.snapshot_game) OR EXISTS (SELECT 1 FROM efra_ingest.canonical_observation) THEN
    RAISE EXCEPTION 'Unattested releases require a separate evidence backfill';
  END IF;
END;
$$;

CREATE ROLE efra_ingest_evidence_attestor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA efra_ingest TO efra_ingest_evidence_attestor;
ALTER TABLE efra_ingest.authenticated_principal DROP CONSTRAINT authenticated_principal_capability_check;
ALTER TABLE efra_ingest.authenticated_principal ADD CONSTRAINT authenticated_principal_capability_check
  CHECK (capability IN ('IMPORTER','REVIEWER','PUBLISHER','PROJECTOR','READER','EVIDENCE_ATTESTOR'));

CREATE OR REPLACE FUNCTION efra_ingest.authenticated_subject(required_capability text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  subject text;
  group_role name;
BEGIN
  group_role := CASE required_capability
    WHEN 'IMPORTER' THEN 'efra_ingest_importer' WHEN 'REVIEWER' THEN 'efra_ingest_reviewer'
    WHEN 'PUBLISHER' THEN 'efra_ingest_publisher' WHEN 'PROJECTOR' THEN 'efra_ingest_projector'
    WHEN 'READER' THEN 'efra_ingest_reader' WHEN 'EVIDENCE_ATTESTOR' THEN 'efra_ingest_evidence_attestor' END;
  SELECT p.subject_id INTO subject FROM efra_ingest.authenticated_principal p
  JOIN pg_roles r ON r.oid = p.login_oid AND r.rolname = p.login_role AND r.rolcanlogin
  WHERE p.login_role = session_user AND p.capability = required_capability AND p.active
    AND pg_has_role(session_user, group_role, 'MEMBER');
  IF subject IS NULL THEN
    RAISE EXCEPTION 'No active EFRA principal for %', required_capability USING ERRCODE = '42501';
  END IF;
  RETURN subject;
END;
$$;

CREATE TABLE efra_ingest.source_capability_evidence (
  source_id uuid NOT NULL REFERENCES efra_ingest.synthetic_source,
  mapping_version text NOT NULL CHECK (btrim(mapping_version) <> ''),
  schema_version text NOT NULL CHECK (btrim(schema_version) <> ''),
  capability text NOT NULL CHECK (capability IN ('BOX_SCORE_CANDIDATE','PLAY_BY_PLAY','ASSIGNMENT_CHARTING','MODEL_REFERENCE','PLAY_BY_PLAY_AND_MODEL')),
  protocol_sha256 text NOT NULL CHECK (protocol_sha256 ~ '^[a-f0-9]{64}$'),
  attested_by text NOT NULL,
  attestor_login name NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_id, mapping_version, schema_version, capability)
);
CREATE TABLE efra_ingest.position_metric_evidence (
  stage_id bigint NOT NULL REFERENCES efra_ingest.staged_game,
  position text NOT NULL,
  field text NOT NULL,
  input jsonb NOT NULL,
  artifacts jsonb NOT NULL,
  attested_by text NOT NULL,
  attestor_login name NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (stage_id, field),
  FOREIGN KEY (position, field) REFERENCES efra_ingest.metric_registry
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.source_capability_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.position_metric_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
GRANT SELECT ON efra_ingest.metric_registry, efra_ingest.staged_game, efra_ingest.import_batch, efra_ingest.source_revision,
  efra_ingest.source_capability_evidence, efra_ingest.position_metric_evidence TO efra_ingest_evidence_attestor;
GRANT SELECT ON efra_ingest.source_capability_evidence, efra_ingest.position_metric_evidence TO efra_ingest_reviewer;

CREATE FUNCTION efra_ingest.attest_source_capability(source uuid, mapping text, schema_id text, capability_key text, protocol_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor text := efra_ingest.authenticated_subject('EVIDENCE_ATTESTOR');
BEGIN
  INSERT INTO efra_ingest.source_capability_evidence
    (source_id, mapping_version, schema_version, capability, protocol_sha256, attested_by, attestor_login)
  VALUES (source, mapping, schema_id, capability_key, protocol_hash, actor, session_user);
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.attest_source_capability(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.attest_source_capability(uuid,text,text,text,text) TO efra_ingest_evidence_attestor;

CREATE FUNCTION efra_ingest.require_metric_convention_capability() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM efra_ingest.metric_registry r JOIN efra_ingest.source_capability_evidence c
      ON c.capability = r.source_capability
    WHERE r.position = NEW.position AND r.field = NEW.field AND r.unit = NEW.unit AND r.storage = 'GAME'
      AND (c.source_id, c.mapping_version, c.schema_version) = (NEW.source_id, NEW.mapping_version, NEW.schema_version)
  ) THEN RAISE EXCEPTION 'Field convention lacks an attested registry capability or matching unit' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_capability BEFORE INSERT ON efra_ingest.metric_convention
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.require_metric_convention_capability();

CREATE FUNCTION efra_ingest.attest_position_metric(request_stage bigint, request_field text, evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor text := efra_ingest.authenticated_subject('EVIDENCE_ATTESTOR');
  staged record;
  expected_kinds text[];
  kinds text[];
BEGIN
  SELECT g.game_id, g.player_id, g.position, m.source_capability,
    efra_ingest.position_game_observation(g.position, g.game->'stats', request_field) AS observation
  INTO staged
  FROM efra_ingest.staged_game g
  JOIN efra_ingest.import_batch b ON b.id = g.batch_id
  JOIN efra_ingest.source_revision rev ON rev.id = b.revision_id
  JOIN efra.data_sources s ON s.code = rev.source_id
  JOIN efra_ingest.metric_registry m ON m.position = g.position AND m.field = request_field AND m.storage = 'GAME'
  JOIN efra_ingest.source_capability_evidence c ON
    (c.source_id, c.mapping_version, c.schema_version, c.capability) = (s.id, b.mapping_version, b.schema_version, m.source_capability)
  WHERE g.id = request_stage;
  IF NOT FOUND OR coalesce(staged.observation->>'status', '') NOT IN ('OBSERVED','VERIFIED_ZERO') THEN
    RAISE EXCEPTION 'Missing registry capability or numeric staged metric' USING ERRCODE = '23514';
  END IF;
  expected_kinds := CASE staged.source_capability
    WHEN 'BOX_SCORE_CANDIDATE' THEN ARRAY['BOX_SCORE']
    WHEN 'PLAY_BY_PLAY_AND_MODEL' THEN ARRAY['MODEL_REFERENCE','PLAY_BY_PLAY']
    ELSE ARRAY[staged.source_capability] END;
  IF jsonb_typeof(evidence) IS DISTINCT FROM 'array' OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(evidence) AS artifact
    WHERE jsonb_typeof(artifact) <> 'object'
      OR coalesce(artifact->>'sha256', '') !~ '^[a-f0-9]{64}$'
      OR btrim(coalesce(artifact->>'reference', '')) = ''
      OR artifact->>'gameId' IS DISTINCT FROM staged.game_id
      OR artifact->>'playerId' IS DISTINCT FROM staged.player_id
      OR artifact->>'position' IS DISTINCT FROM staged.position
      OR artifact->>'field' IS DISTINCT FROM request_field
  ) THEN RAISE EXCEPTION 'Evidence must identify the exact player, game, position and field' USING ERRCODE = '23514'; END IF;
  SELECT array_agg(artifact->>'kind' ORDER BY (artifact->>'kind') COLLATE "C") INTO kinds FROM jsonb_array_elements(evidence) AS artifact;
  IF kinds IS DISTINCT FROM expected_kinds THEN
    RAISE EXCEPTION 'Evidence kind does not satisfy registry capability' USING ERRCODE = '23514';
  END IF;
  INSERT INTO efra_ingest.position_metric_evidence (stage_id, position, field, input, artifacts, attested_by, attestor_login)
    VALUES (request_stage, staged.position, request_field, staged.observation, evidence, actor, session_user);
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.attest_position_metric(bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.attest_position_metric(bigint,text,jsonb) TO efra_ingest_evidence_attestor;

CREATE FUNCTION efra_ingest.has_metric_evidence(stage bigint, field_key text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM efra_ingest.position_metric_evidence e
    JOIN efra_ingest.staged_game g ON g.id = e.stage_id AND g.position = e.position
    JOIN efra_ingest.metric_registry m ON (m.position, m.field) = (e.position, e.field)
    JOIN efra_ingest.import_batch b ON b.id = g.batch_id
    JOIN efra_ingest.source_revision rev ON rev.id = b.revision_id
    JOIN efra.data_sources src ON src.code = rev.source_id
    JOIN efra_ingest.source_capability_evidence c ON
      (c.source_id, c.mapping_version, c.schema_version, c.capability) = (src.id, b.mapping_version, b.schema_version, m.source_capability)
    JOIN efra_ingest.metric_convention mc ON (mc.source_id, mc.mapping_version, mc.schema_version, mc.position, mc.field)
      = (src.id, b.mapping_version, b.schema_version, e.position, e.field)
    WHERE e.stage_id = stage AND e.field = field_key AND mc.unit = m.unit
      AND mc.convention_version = e.input#>>'{source,conventionVersion}'
      AND mc.feature_version = CASE WHEN g.position <> 'QB' THEN g.game#>>'{stats,definitionVersion}'
        WHEN m.field LIKE 'advancedPassing.%' THEN g.game#>>'{stats,advancedPassing,definitionVersion}'
        WHEN m.field LIKE 'situation.%' THEN g.game#>>'{stats,situationDefinitionVersion}' ELSE m.definition_version END
      AND e.input = efra_ingest.position_game_observation(g.position, g.game->'stats', field_key)
      AND e.input#>>'{source,origin}' = 'SYNTHETIC' AND e.input#>>'{source,officiality}' = 'SYNTHETIC'
      AND e.input#>>'{source,verification}' = 'VERIFIED'
      AND e.input#>>'{source,sourceId}' = rev.source_id AND e.input#>>'{source,revisionId}' = rev.source_revision
  );
$$;
REVOKE ALL ON FUNCTION efra_ingest.has_metric_evidence(bigint,text) FROM PUBLIC;

CREATE FUNCTION efra_ingest.require_snapshot_metric_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM efra_ingest.staged_game g JOIN efra_ingest.metric_registry m ON m.position = g.position AND m.storage = 'GAME'
    JOIN efra_ingest.snapshot s ON s.id = NEW.snapshot_id
    WHERE g.id = NEW.stage_id
      AND efra_ingest.position_game_observation(g.position, g.game->'stats', m.field)->>'status' IN ('OBSERVED','VERIFIED_ZERO')
      AND (NOT efra_ingest.has_metric_evidence(g.id, m.field)
        OR NOT EXISTS (SELECT 1 FROM efra_ingest.position_metric_evidence e
          WHERE e.stage_id = g.id AND e.field = m.field AND e.attested_at <= s.as_of))
  ) THEN RAISE EXCEPTION 'Snapshot metric lacks independently attested evidence' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.require_snapshot_metric_evidence() FROM PUBLIC;
CREATE TRIGGER require_metric_evidence BEFORE INSERT ON efra_ingest.snapshot_game
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.require_snapshot_metric_evidence();

CREATE FUNCTION efra_ingest.require_canonical_metric_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM efra_ingest.metric_registry m
    WHERE m.position = NEW.position AND m.code = NEW.metric_code AND efra_ingest.has_metric_evidence(NEW.stage_id, m.field)) THEN
    RAISE EXCEPTION 'Canonical metric lacks independently attested evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.require_canonical_metric_evidence() FROM PUBLIC;
CREATE TRIGGER require_metric_evidence BEFORE INSERT ON efra_ingest.canonical_observation
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.require_canonical_metric_evidence();
