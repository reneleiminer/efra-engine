CREATE TABLE efra_ingest.metric_registry (
  position text NOT NULL,
  field text NOT NULL,
  code text NOT NULL UNIQUE,
  unit text NOT NULL,
  domain text NOT NULL CHECK (domain IN ('COUNT','SIGNED_INTEGER','SIGNED_DECIMAL','NONNEGATIVE_DECIMAL')),
  tiers text[] NOT NULL CHECK (cardinality(tiers) > 0),
  roles text[] NOT NULL CHECK (cardinality(roles) > 0),
  source_capability text NOT NULL,
  storage text NOT NULL CHECK (storage IN ('GAME','RATING_POLICY')),
  definition_version text NOT NULL,
  PRIMARY KEY (position, field)
);
CREATE TABLE efra_ingest.metric_rule (
  position text NOT NULL,
  upper_field text NOT NULL,
  fields text[] NOT NULL CHECK (cardinality(fields) > 0),
  kind text NOT NULL CHECK (kind IN ('SUM_AT_MOST','ZERO_IF_ZERO')),
  PRIMARY KEY (position, upper_field, fields, kind),
  FOREIGN KEY (position, upper_field) REFERENCES efra_ingest.metric_registry (position, field)
);

-- A grant is a review of one normalized metric mapping, not an inference from a box-score header.
CREATE TABLE efra_ingest.metric_convention (
  source_id uuid NOT NULL REFERENCES efra_ingest.synthetic_source,
  mapping_version text NOT NULL CHECK (btrim(mapping_version) <> ''),
  schema_version text NOT NULL CHECK (btrim(schema_version) <> ''),
  position text NOT NULL,
  field text NOT NULL,
  convention_version text NOT NULL CHECK (btrim(convention_version) <> ''),
  feature_version text NOT NULL CHECK (btrim(feature_version) <> ''),
  unit text NOT NULL,
  approved_by text NOT NULL CHECK (btrim(approved_by) <> ''),
  PRIMARY KEY (source_id, mapping_version, schema_version, position, field, convention_version, feature_version),
  FOREIGN KEY (position, field) REFERENCES efra_ingest.metric_registry (position, field)
);

CREATE TABLE efra_ingest.position_projection (
  snapshot_id text PRIMARY KEY REFERENCES efra_ingest.snapshot,
  projection_version text NOT NULL CHECK (projection_version = 'efra-all-positions-v1'),
  registry_version text NOT NULL CHECK (registry_version = 'efra-position-metrics-v1'),
  projected_by text NOT NULL,
  projector_login name NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE efra_ingest.position_fact (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision_id bigint NOT NULL REFERENCES efra_ingest.source_revision,
  predecessor_revision_id bigint REFERENCES efra_ingest.source_revision,
  stage_id bigint NOT NULL REFERENCES efra_ingest.staged_game,
  game_id uuid NOT NULL REFERENCES efra.games,
  player_id uuid NOT NULL REFERENCES efra.players,
  team_id uuid NOT NULL REFERENCES efra.teams,
  position text NOT NULL,
  field text NOT NULL,
  mapping_version text NOT NULL,
  schema_version text NOT NULL,
  feature_version text,
  status text NOT NULL CHECK (status IN ('OBSERVED','VERIFIED_ZERO','MISSING','NOT_APPLICABLE')),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object' AND input->>'status' IS NOT NULL AND input->>'status' = status),
  canonical_id uuid UNIQUE REFERENCES efra_ingest.canonical_observation (canonical_id),
  last_numeric_id uuid REFERENCES efra_ingest.canonical_observation (canonical_id),
  FOREIGN KEY (position, field) REFERENCES efra_ingest.metric_registry (position, field),
  CHECK ((status IN ('OBSERVED','VERIFIED_ZERO')) = (canonical_id IS NOT NULL)),
  CHECK (canonical_id IS NULL OR last_numeric_id IS NOT DISTINCT FROM canonical_id),
  UNIQUE (revision_id, game_id, player_id, position, field),
  UNIQUE (predecessor_revision_id, game_id, player_id, position, field)
);
CREATE INDEX position_fact_identity_idx ON efra_ingest.position_fact (game_id, player_id, position, field);
CREATE TABLE efra_ingest.position_projection_item (
  snapshot_id text NOT NULL REFERENCES efra_ingest.position_projection,
  stage_id bigint NOT NULL REFERENCES efra_ingest.staged_game,
  fact_id bigint NOT NULL REFERENCES efra_ingest.position_fact,
  PRIMARY KEY (snapshot_id, stage_id, fact_id)
);

CREATE TABLE efra_ingest.quarantine_conflict (
  batch_id bigint NOT NULL,
  decision_ordinal integer NOT NULL,
  conflicts jsonb NOT NULL CHECK (jsonb_typeof(conflicts) = 'array' AND jsonb_array_length(conflicts) > 0
    AND NOT jsonb_path_exists(conflicts, '$.**.origin ? (@ != "SYNTHETIC")')),
  PRIMARY KEY (batch_id, decision_ordinal),
  FOREIGN KEY (batch_id, decision_ordinal) REFERENCES efra_ingest.quarantine
);
CREATE TRIGGER check_batch BEFORE INSERT ON efra_ingest.quarantine_conflict
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.check_batch_member();
CREATE TRIGGER check_importer BEFORE INSERT ON efra_ingest.quarantine_conflict
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.check_importer();
GRANT INSERT ON efra_ingest.quarantine_conflict TO efra_ingest_importer;
GRANT SELECT ON efra_ingest.quarantine_conflict TO efra_ingest_reviewer;

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.metric_registry
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.metric_rule
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.metric_convention
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.position_projection
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.position_fact
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.position_projection_item
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.quarantine_conflict
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();

CREATE FUNCTION efra_ingest.position_game_observation(position_key text, stats jsonb, field_key text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(
    CASE WHEN position_key = 'QB' THEN stats #> string_to_array(field_key, '.')
      ELSE stats->'observations'->field_key END,
    '{"status":"MISSING"}'::jsonb
  );
$$;

CREATE FUNCTION efra_ingest.check_position_metric_rules(position_key text, stats jsonb) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  rule efra_ingest.metric_rule%ROWTYPE;
  upper_value numeric;
  metric_total numeric;
  available_count integer;
  any_nonzero boolean;
BEGIN
  FOR rule IN SELECT * FROM efra_ingest.metric_rule r WHERE r.position = position_key LOOP
    upper_value := (efra_ingest.position_game_observation(position_key, stats, rule.upper_field)->>'value')::numeric;
    IF upper_value IS NULL THEN CONTINUE; END IF;
    SELECT sum(v), count(v), bool_or(v <> 0) INTO metric_total, available_count, any_nonzero
    FROM (SELECT (efra_ingest.position_game_observation(position_key, stats, f)->>'value')::numeric AS v
          FROM unnest(rule.fields) AS f) AS numbers;
    IF (upper_value = 0 AND any_nonzero)
      OR (rule.kind = 'SUM_AT_MOST' AND available_count = cardinality(rule.fields) AND metric_total > upper_value) THEN
      RAISE EXCEPTION 'Metric relationship failed for %/%', position_key, rule.upper_field USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.position_game_observation(text,jsonb,text),
  efra_ingest.check_position_metric_rules(text,jsonb) FROM PUBLIC;

CREATE FUNCTION efra_ingest.project_position_snapshot(request_id text, requested_version text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor text := efra_ingest.authenticated_subject('PROJECTOR');
  candidate record;
  metric efra_ingest.metric_registry%ROWTYPE;
  existing efra_ingest.position_fact%ROWTYPE;
  previous efra_ingest.position_fact%ROWTYPE;
  input_value jsonb;
  state text;
  feature text;
  observed numeric;
  canonical uuid;
  last_numeric uuid;
  canonical_batch uuid;
  fact_id bigint;
  predecessor bigint;
  covered integer := 0;
  metric_count integer;
BEGIN
  IF requested_version IS DISTINCT FROM 'efra-all-positions-v1' THEN
    RAISE EXCEPTION 'Unknown position projection version' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(716184, 1);
  IF EXISTS (SELECT 1 FROM efra_ingest.position_projection p WHERE p.snapshot_id = request_id) THEN
    RETURN 'ALREADY_PROJECTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM efra_ingest.snapshot s WHERE s.id = request_id
    AND s.release_login IS NOT NULL AND s.origin = 'SYNTHETIC') THEN
    RAISE EXCEPTION 'Snapshot is missing authenticated synthetic release' USING ERRCODE = '23514';
  END IF;
  LOCK TABLE efra.stat_observations IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO efra_ingest.position_projection (snapshot_id, projection_version, registry_version, projected_by, projector_login)
  VALUES (request_id, requested_version, 'efra-position-metrics-v1', actor, session_user);

  FOR candidate IN
    SELECT g.id AS stage_id, g.game_id::uuid AS game_id, g.player_id::uuid AS player_id, g.position,
      g.game->'stats' AS stats, g.game#>>'{usage,status}' AS usage_status, g.game#>'{usage,source}' AS usage_source,
      (g.game->>'teamId')::uuid AS team_id, (g.game->>'opponentId')::uuid AS opponent_id,
      b.id AS staging_batch_id, b.mapping_version, b.schema_version, b.retrieved_at, r.id AS revision_id,
      r.source_id AS source_code, r.source_revision, r.payload_sha256, r.season_id::uuid AS season_id, src.id AS source_id,
      prior.id AS prior_revision_id
    FROM efra_ingest.snapshot_game m
    JOIN efra_ingest.staged_game g ON g.id = m.stage_id
    JOIN efra_ingest.import_batch b ON b.id = g.batch_id
    JOIN efra_ingest.source_revision r ON r.id = b.revision_id
    JOIN efra.data_sources src ON src.code = r.source_id
    JOIN efra_ingest.synthetic_source allowed ON allowed.source_id = src.id
    LEFT JOIN efra_ingest.source_revision prior ON
      (prior.source_id, prior.competition_id, prior.season_id, prior.source_revision)
      = (r.source_id, r.competition_id, r.season_id, r.supersedes_source_revision)
    WHERE m.snapshot_id = request_id ORDER BY g.id
  LOOP
    covered := covered + 1;
    metric_count := 0;
    IF NOT efra_ingest.valid_game_identity(candidate.game_id, candidate.player_id, candidate.team_id,
      candidate.opponent_id, candidate.season_id, candidate.position, candidate.usage_status) THEN
      RAISE EXCEPTION 'Canonical position identity is no longer valid' USING ERRCODE = '23514';
    END IF;
    IF candidate.usage_source->>'origin' IS DISTINCT FROM 'SYNTHETIC'
      OR candidate.usage_source->>'officiality' IS DISTINCT FROM 'SYNTHETIC'
      OR candidate.usage_source->>'verification' IS DISTINCT FROM 'VERIFIED'
      OR candidate.usage_source->>'sourceId' IS DISTINCT FROM candidate.source_code
      OR candidate.usage_source->>'revisionId' IS DISTINCT FROM candidate.source_revision
      OR NOT EXISTS (SELECT 1 FROM efra_ingest.metric_convention c
        WHERE (c.source_id, c.mapping_version, c.schema_version, c.position, c.convention_version)
          = (candidate.source_id, candidate.mapping_version, candidate.schema_version, candidate.position,
             candidate.usage_source->>'conventionVersion')) THEN
      RAISE EXCEPTION 'Unapproved position participation provenance' USING ERRCODE = '23514';
    END IF;
    IF candidate.position <> 'QB' AND EXISTS (
      SELECT 1 FROM jsonb_object_keys(candidate.stats->'observations') AS key
      WHERE NOT EXISTS (SELECT 1 FROM efra_ingest.metric_registry r
        WHERE r.position = candidate.position AND r.field = key AND r.storage = 'GAME')
    ) THEN
      RAISE EXCEPTION 'Unregistered position metric' USING ERRCODE = '23514';
    END IF;
    FOR metric IN SELECT * FROM efra_ingest.metric_registry r
      WHERE r.position = candidate.position AND r.storage = 'GAME' ORDER BY r.field
    LOOP
      metric_count := metric_count + 1;
      input_value := efra_ingest.position_game_observation(candidate.position, candidate.stats, metric.field);
      state := input_value->>'status';
      IF candidate.position = 'QB' AND candidate.usage_status = 'PLAYED' AND 'CORE' = ANY(metric.tiers)
        AND coalesce(state, '') NOT IN ('OBSERVED', 'VERIFIED_ZERO') THEN
        RAISE EXCEPTION 'QB passing core is incomplete' USING ERRCODE = '23514';
      END IF;
      feature := CASE
        WHEN candidate.position <> 'QB' THEN candidate.stats->>'definitionVersion'
        WHEN metric.field LIKE 'advancedPassing.%' THEN candidate.stats#>>'{advancedPassing,definitionVersion}'
        WHEN metric.field LIKE 'situation.%' THEN candidate.stats->>'situationDefinitionVersion'
        ELSE metric.definition_version END;
      IF candidate.position <> 'QB' AND feature IS DISTINCT FROM metric.definition_version THEN
        RAISE EXCEPTION 'Feature definition mismatch for %/%', candidate.position, metric.field USING ERRCODE = '23514';
      END IF;
      observed := NULL;
      IF state IN ('OBSERVED', 'VERIFIED_ZERO') THEN
        IF jsonb_typeof(input_value->'value') IS DISTINCT FROM 'number'
          OR input_value#>>'{source,origin}' IS DISTINCT FROM 'SYNTHETIC'
          OR input_value#>>'{source,officiality}' IS DISTINCT FROM 'SYNTHETIC'
          OR input_value#>>'{source,verification}' IS DISTINCT FROM 'VERIFIED'
          OR input_value#>>'{source,sourceId}' IS DISTINCT FROM candidate.source_code
          OR input_value#>>'{source,revisionId}' IS DISTINCT FROM candidate.source_revision
          OR NOT EXISTS (
            SELECT 1 FROM efra_ingest.metric_convention c
            WHERE (c.source_id, c.mapping_version, c.schema_version, c.position, c.field, c.convention_version, c.feature_version, c.unit)
              = (candidate.source_id, candidate.mapping_version, candidate.schema_version, candidate.position, metric.field,
                 input_value#>>'{source,conventionVersion}', feature, metric.unit)
          ) THEN
          RAISE EXCEPTION 'Metric provenance, feature or unit is unapproved for %/%', candidate.position, metric.field USING ERRCODE = '23514';
        END IF;
        observed := (input_value->>'value')::numeric;
        IF abs(observed) > 9007199254740991
          OR (metric.domain IN ('COUNT','SIGNED_INTEGER') AND observed <> trunc(observed))
          OR (metric.domain IN ('COUNT','NONNEGATIVE_DECIMAL') AND observed < 0)
          OR (observed = 0) <> (state = 'VERIFIED_ZERO')
          OR (candidate.usage_status = 'DID_NOT_PLAY' AND observed <> 0) THEN
          RAISE EXCEPTION 'Invalid numeric domain for %/%', candidate.position, metric.field USING ERRCODE = '23514';
        END IF;
      ELSIF state IS NULL OR state NOT IN ('MISSING', 'NOT_APPLICABLE') OR input_value ? 'value'
        OR input_value ? 'source' OR input_value ? 'sources' THEN
        RAISE EXCEPTION 'Conflicted or malformed metric cannot be projected' USING ERRCODE = '23514';
      END IF;

      SELECT f.* INTO existing FROM efra_ingest.position_fact f
      WHERE (f.revision_id, f.game_id, f.player_id, f.position, f.field)
        = (candidate.revision_id, candidate.game_id, candidate.player_id, candidate.position, metric.field);
      IF FOUND THEN
        IF (existing.input, existing.team_id, existing.mapping_version, existing.schema_version, existing.feature_version) IS DISTINCT FROM
          (input_value, candidate.team_id, candidate.mapping_version, candidate.schema_version, feature) THEN
          RAISE EXCEPTION 'Conflicting position replay' USING ERRCODE = '23514';
        END IF;
        fact_id := existing.id;
      ELSE
        IF EXISTS (
          SELECT 1 FROM efra_ingest.position_fact f JOIN efra_ingest.source_revision r ON r.id = f.revision_id
          WHERE (f.game_id, f.player_id, f.position, f.field) = (candidate.game_id, candidate.player_id, candidate.position, metric.field)
            AND r.source_id <> candidate.source_code
        ) OR EXISTS (
          SELECT 1 FROM efra.stat_observations o
          LEFT JOIN efra_ingest.canonical_observation co ON co.canonical_id = o.id
          LEFT JOIN efra_ingest.source_revision r ON r.id = co.revision_id
          WHERE (o.game_id, o.player_id, o.position_code, o.metric_code)
            = (candidate.game_id, candidate.player_id, candidate.position, metric.code)
            AND (co.canonical_id IS NULL OR r.source_id <> candidate.source_code)
        ) THEN
          RAISE EXCEPTION 'Conflicting canonical source requires reconciliation' USING ERRCODE = '23514';
        END IF;
        canonical := NULL;
        last_numeric := NULL;
        predecessor := NULL;
        SELECT f.* INTO previous FROM efra_ingest.position_fact f
        WHERE (f.revision_id, f.game_id, f.player_id, f.position, f.field)
          = (candidate.prior_revision_id, candidate.game_id, candidate.player_id, candidate.position, metric.field);
        IF FOUND THEN
          predecessor := previous.revision_id;
          last_numeric := previous.last_numeric_id;
        ELSE
          SELECT co.revision_id, co.canonical_id INTO predecessor, last_numeric FROM efra_ingest.canonical_observation co
          WHERE (co.revision_id, co.game_id, co.player_id, co.position, co.metric_code)
            = (candidate.prior_revision_id, candidate.game_id, candidate.player_id, candidate.position, metric.code);
        END IF;
        SELECT co.canonical_id INTO canonical FROM efra_ingest.canonical_observation co
        WHERE (co.revision_id, co.game_id, co.player_id, co.position, co.metric_code)
          = (candidate.revision_id, candidate.game_id, candidate.player_id, candidate.position, metric.code);
        IF canonical IS NOT NULL THEN
          IF observed IS NULL OR NOT EXISTS (
            SELECT 1 FROM efra.stat_observations o JOIN efra_ingest.canonical_observation co ON co.canonical_id = o.id
            JOIN efra_ingest.staged_game g ON g.id = co.stage_id JOIN efra_ingest.import_batch b ON b.id = g.batch_id
            WHERE o.id = canonical AND g.id = candidate.stage_id AND o.value = observed AND o.team_id = candidate.team_id AND o.exposure_unit = metric.unit
              AND (b.mapping_version, b.schema_version) = (candidate.mapping_version, candidate.schema_version)
          ) THEN RAISE EXCEPTION 'Conflicting legacy projection' USING ERRCODE = '23514'; END IF;
        ELSE
          IF predecessor IS NULL AND (
            EXISTS (SELECT 1 FROM efra_ingest.position_fact f WHERE (f.game_id, f.player_id, f.position, f.field)
              = (candidate.game_id, candidate.player_id, candidate.position, metric.field))
            OR EXISTS (SELECT 1 FROM efra_ingest.canonical_observation co WHERE (co.game_id, co.player_id, co.position, co.metric_code)
              = (candidate.game_id, candidate.player_id, candidate.position, metric.code))
          ) THEN RAISE EXCEPTION 'Position correction requires the exact projected predecessor' USING ERRCODE = '23514'; END IF;
          IF predecessor IS NOT NULL AND EXISTS (
            SELECT 1 FROM efra_ingest.canonical_observation co WHERE co.supersedes_id = last_numeric
          ) THEN RAISE EXCEPTION 'Canonical predecessor already superseded' USING ERRCODE = '23514'; END IF;
          IF observed IS NOT NULL THEN
            SELECT cb.canonical_batch_id INTO canonical_batch FROM efra_ingest.canonical_batch cb
            WHERE cb.staging_batch_id = candidate.staging_batch_id;
            IF NOT FOUND THEN
              INSERT INTO efra.import_batches (source_id, started_at, completed_at, status, raw_sha256, notes)
              VALUES (candidate.source_id, candidate.retrieved_at, clock_timestamp(), 'validated', candidate.payload_sha256, 'EFRA synthetic position projection')
              RETURNING id INTO canonical_batch;
              INSERT INTO efra_ingest.canonical_batch VALUES (candidate.staging_batch_id, canonical_batch);
            END IF;
            INSERT INTO efra.stat_observations (
              import_batch_id, player_id, game_id, season_id, team_id, position_code, metric_code, value, exposure_unit, data_status, supersedes_id
            ) VALUES (
              canonical_batch, candidate.player_id, candidate.game_id, candidate.season_id, candidate.team_id,
              candidate.position, metric.code, observed, metric.unit, 'verified', last_numeric
            ) RETURNING id INTO canonical;
            INSERT INTO efra_ingest.canonical_observation VALUES (
              candidate.revision_id, candidate.stage_id, candidate.game_id, candidate.player_id, candidate.position,
              metric.code, canonical, last_numeric
            );
          END IF;
        END IF;
        INSERT INTO efra_ingest.position_fact (
          revision_id, predecessor_revision_id, stage_id, game_id, player_id, team_id, position, field, mapping_version,
          schema_version, feature_version, status, input, canonical_id, last_numeric_id
        ) VALUES (
          candidate.revision_id, predecessor, candidate.stage_id, candidate.game_id, candidate.player_id, candidate.team_id,
          candidate.position, metric.field, candidate.mapping_version, candidate.schema_version, feature, state,
          input_value, canonical, coalesce(canonical, last_numeric)
        ) RETURNING id INTO fact_id;
      END IF;
      INSERT INTO efra_ingest.position_projection_item VALUES (request_id, candidate.stage_id, fact_id);
    END LOOP;
    IF metric_count = 0 THEN RAISE EXCEPTION 'Position has no registered metrics' USING ERRCODE = '23514'; END IF;
    PERFORM efra_ingest.check_position_metric_rules(candidate.position, candidate.stats);
  END LOOP;
  IF covered <> (SELECT count(*) FROM efra_ingest.snapshot_game WHERE snapshot_id = request_id) THEN
    RAISE EXCEPTION 'Position projection did not cover the entire snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN 'PROJECTED';
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.project_position_snapshot(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.project_position_snapshot(text,text) TO efra_ingest_projector;

-- The former path cannot introduce a numeric successor behind the status-aware chain.
ALTER FUNCTION efra_ingest.project_snapshot(text,text) RENAME TO project_snapshot_legacy;
REVOKE EXECUTE ON FUNCTION efra_ingest.project_snapshot_legacy(text,text) FROM efra_ingest_projector;
CREATE FUNCTION efra_ingest.project_snapshot(request_id text, requested_version text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM efra_ingest.authenticated_subject('PROJECTOR');
  PERFORM pg_advisory_xact_lock(716184, 1);
  IF NOT EXISTS (SELECT 1 FROM efra_ingest.projection_run r WHERE r.snapshot_id = request_id AND r.projection_version = requested_version)
    AND EXISTS (
      SELECT 1 FROM efra_ingest.snapshot_game m JOIN efra_ingest.position_fact f ON
        (m.game_id, m.player_id, m.position) = (f.game_id::text, f.player_id::text, f.position)
      WHERE m.snapshot_id = request_id
    ) THEN RAISE EXCEPTION 'Position history requires the status-aware projection' USING ERRCODE = '23514'; END IF;
  RETURN efra_ingest.project_snapshot_legacy(request_id, requested_version);
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.project_snapshot(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.project_snapshot(text,text) TO efra_ingest_projector;

CREATE FUNCTION efra_ingest.read_position_projection(request_id text)
RETURNS TABLE (projection_version text, registry_version text, facts jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM efra_ingest.authenticated_subject('READER');
  RETURN QUERY SELECT p.projection_version, p.registry_version, jsonb_agg(jsonb_build_object(
    'stageId', i.stage_id::text, 'field', f.field,
    'unit', CASE WHEN f.canonical_id IS NULL THEN r.unit ELSE o.exposure_unit END,
    'observation', CASE WHEN f.canonical_id IS NULL THEN f.input ELSE jsonb_set(f.input, '{value}', to_jsonb(o.value), false) END,
    'observationId', f.canonical_id
  ) ORDER BY i.stage_id, f.field COLLATE "C")
  FROM efra_ingest.position_projection p JOIN efra_ingest.position_projection_item i ON i.snapshot_id = p.snapshot_id
  JOIN efra_ingest.position_fact f ON f.id = i.fact_id
  JOIN efra_ingest.metric_registry r ON (r.position, r.field) = (f.position, f.field)
  LEFT JOIN efra.stat_observations o ON o.id = f.canonical_id
  WHERE p.snapshot_id = request_id GROUP BY p.snapshot_id;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.read_position_projection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.read_position_projection(text) TO efra_ingest_reader;
