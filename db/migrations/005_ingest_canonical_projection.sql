CREATE TABLE efra_ingest.canonical_batch (
  staging_batch_id bigint PRIMARY KEY REFERENCES efra_ingest.import_batch,
  canonical_batch_id uuid NOT NULL UNIQUE REFERENCES efra.import_batches
);

CREATE TABLE efra_ingest.canonical_observation (
  revision_id bigint NOT NULL REFERENCES efra_ingest.source_revision,
  stage_id bigint NOT NULL REFERENCES efra_ingest.staged_game,
  game_id uuid NOT NULL REFERENCES efra.games,
  player_id uuid NOT NULL REFERENCES efra.players,
  position text NOT NULL,
  metric_code text NOT NULL,
  canonical_id uuid NOT NULL UNIQUE REFERENCES efra.stat_observations,
  supersedes_id uuid UNIQUE REFERENCES efra_ingest.canonical_observation (canonical_id),
  PRIMARY KEY (revision_id, game_id, player_id, position, metric_code)
);
CREATE INDEX canonical_observation_stage_idx ON efra_ingest.canonical_observation (stage_id);
CREATE INDEX canonical_observation_metric_idx ON efra_ingest.canonical_observation (game_id, player_id, position, metric_code);

CREATE TABLE efra_ingest.projection_run (
  snapshot_id text NOT NULL REFERENCES efra_ingest.snapshot,
  projection_version text NOT NULL CHECK (projection_version = 'efra-qb-passing-v1'),
  projected_by text NOT NULL,
  projector_login name NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (snapshot_id, projection_version)
);

CREATE TABLE efra_ingest.projection_item (
  snapshot_id text NOT NULL,
  projection_version text NOT NULL,
  canonical_id uuid NOT NULL REFERENCES efra_ingest.canonical_observation (canonical_id),
  stage_id bigint NOT NULL REFERENCES efra_ingest.staged_game,
  PRIMARY KEY (snapshot_id, projection_version, canonical_id),
  FOREIGN KEY (snapshot_id, projection_version) REFERENCES efra_ingest.projection_run
);
CREATE INDEX projection_item_canonical_idx ON efra_ingest.projection_item (canonical_id);
CREATE INDEX projection_item_stage_idx ON efra_ingest.projection_item (stage_id);

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.canonical_batch
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.canonical_observation
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.projection_run
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.projection_item
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();

CREATE FUNCTION efra_ingest.protect_projected_observation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM efra_ingest.canonical_observation c
      WHERE (c.game_id, c.player_id, c.position, c.metric_code) = (NEW.game_id, NEW.player_id, NEW.position_code, NEW.metric_code)) THEN
      PERFORM efra_ingest.authenticated_subject('PROJECTOR');
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM efra_ingest.canonical_observation WHERE canonical_id = OLD.id) THEN
    RAISE EXCEPTION 'Projected observations are append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.protect_projected_observation() FROM PUBLIC;
CREATE TRIGGER protect_projected_observation BEFORE INSERT OR UPDATE OR DELETE ON efra.stat_observations
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.protect_projected_observation();

CREATE FUNCTION efra_ingest.project_snapshot(request_id text, requested_version text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor text := efra_ingest.authenticated_subject('PROJECTOR');
  candidate record;
  metric record;
  value_json jsonb;
  observed numeric;
  existing record;
  canonical_batch_id uuid;
  new_observation uuid;
  previous_observation uuid;
  passing jsonb;
BEGIN
  IF requested_version IS DISTINCT FROM 'efra-qb-passing-v1' THEN
    RAISE EXCEPTION 'Unknown canonical projection version' USING ERRCODE = '23514';
  END IF;
  -- The pilot serializes projections across snapshots, including overlapping members and correction chains.
  PERFORM pg_advisory_xact_lock(716184, 1);
  IF EXISTS (SELECT 1 FROM efra_ingest.projection_run p WHERE p.snapshot_id = request_id AND p.projection_version = requested_version) THEN
    RETURN 'ALREADY_PROJECTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM efra_ingest.snapshot s WHERE s.id = request_id AND s.release_login IS NOT NULL AND s.origin = 'SYNTHETIC') THEN
    RAISE EXCEPTION 'Snapshot is missing an authenticated release' USING ERRCODE = '23514';
  END IF;
  LOCK TABLE efra.stat_observations IN SHARE ROW EXCLUSIVE MODE;
  INSERT INTO efra_ingest.projection_run (snapshot_id, projection_version, projected_by, projector_login)
    VALUES (request_id, requested_version, actor, session_user);

  FOR candidate IN
    SELECT g.id AS stage_id, g.game_id::uuid AS game_id, g.player_id::uuid AS player_id, g.position,
      g.game, (g.game->>'teamId')::uuid AS team_id, (g.game->>'opponentId')::uuid AS opponent_id,
      b.id AS staging_batch_id, b.mapping_version, b.retrieved_at, r.id AS revision_id, r.source_id AS source_code,
      r.source_revision, r.supersedes_source_revision, r.payload_sha256, r.season_id::uuid AS season_id,
      s.id AS source_id
    FROM efra_ingest.snapshot_game m
    JOIN efra_ingest.staged_game g ON g.id = m.stage_id
    JOIN efra_ingest.import_batch b ON b.id = g.batch_id
    JOIN efra_ingest.source_revision r ON r.id = b.revision_id
    JOIN efra.data_sources s ON s.code = r.source_id
    JOIN efra_ingest.synthetic_source permitted ON permitted.source_id = s.id
    WHERE m.snapshot_id = request_id ORDER BY g.id
  LOOP
    IF candidate.position <> 'QB' OR candidate.game#>>'{usage,status}' IS DISTINCT FROM 'PLAYED'
      OR NOT efra_ingest.valid_game_identity(candidate.game_id, candidate.player_id, candidate.team_id,
        candidate.opponent_id, candidate.season_id, candidate.position, 'PLAYED') THEN
      RAISE EXCEPTION 'Projection requires an eligible QB appearance' USING ERRCODE = '23514';
    END IF;
    SELECT cb.canonical_batch_id INTO canonical_batch_id FROM efra_ingest.canonical_batch cb
      WHERE cb.staging_batch_id = candidate.staging_batch_id;
    IF NOT FOUND THEN
      INSERT INTO efra.import_batches (source_id, started_at, completed_at, status, raw_sha256, notes)
      VALUES (candidate.source_id, candidate.retrieved_at, clock_timestamp(), 'validated', candidate.payload_sha256, 'EFRA synthetic projection')
      RETURNING id INTO canonical_batch_id;
      INSERT INTO efra_ingest.canonical_batch VALUES (candidate.staging_batch_id, canonical_batch_id);
    END IF;
    passing := candidate.game#>'{stats,passing}';

    FOR metric IN SELECT * FROM (VALUES
      ('attempts', 'passing_attempts', 'attempts'),
      ('completions', 'passing_completions', 'completions'),
      ('yards', 'passing_yards', 'yards'),
      ('touchdowns', 'passing_touchdowns', 'touchdowns'),
      ('interceptions', 'passing_interceptions', 'interceptions')
    ) AS v(field_name, metric_code, unit) LOOP
      value_json := passing->metric.field_name;
      IF jsonb_typeof(value_json->'value') IS DISTINCT FROM 'number'
        OR coalesce(value_json->>'status', '') NOT IN ('OBSERVED', 'VERIFIED_ZERO')
        OR value_json#>>'{source,origin}' IS DISTINCT FROM 'SYNTHETIC'
        OR value_json#>>'{source,verification}' IS DISTINCT FROM 'VERIFIED'
        OR value_json#>>'{source,sourceId}' IS DISTINCT FROM candidate.source_code
        OR value_json#>>'{source,revisionId}' IS DISTINCT FROM candidate.source_revision THEN
        RAISE EXCEPTION 'Incomplete or unverified canonical metric %', metric.metric_code USING ERRCODE = '23514';
      END IF;
      observed := (value_json->>'value')::numeric;
      IF observed <> trunc(observed) OR abs(observed) > 9007199254740991
        OR (metric.field_name <> 'yards' AND observed < 0)
        OR ((observed = 0) <> (value_json->>'status' = 'VERIFIED_ZERO')) THEN
        RAISE EXCEPTION 'Invalid canonical metric %', metric.metric_code USING ERRCODE = '23514';
      END IF;

      SELECT co.canonical_id, prior_batch.mapping_version, o.value, o.team_id INTO existing
      FROM efra_ingest.canonical_observation co JOIN efra.stat_observations o ON o.id = co.canonical_id
      JOIN efra_ingest.staged_game prior_game ON prior_game.id = co.stage_id
      JOIN efra_ingest.import_batch prior_batch ON prior_batch.id = prior_game.batch_id
      WHERE (co.revision_id, co.game_id, co.player_id, co.position, co.metric_code)
        = (candidate.revision_id, candidate.game_id, candidate.player_id, candidate.position, metric.metric_code);
      IF FOUND THEN
        IF (existing.value, existing.team_id, existing.mapping_version) IS DISTINCT FROM
           (observed, candidate.team_id, candidate.mapping_version) THEN
          RAISE EXCEPTION 'Conflicting canonical replay' USING ERRCODE = '23514';
        END IF;
        new_observation := existing.canonical_id;
      ELSE
        IF EXISTS (
          SELECT 1 FROM efra.stat_observations o
          WHERE (o.game_id, o.player_id, o.position_code, o.metric_code)
            = (candidate.game_id, candidate.player_id, candidate.position, metric.metric_code)
            AND NOT EXISTS (SELECT 1 FROM efra_ingest.canonical_observation co WHERE co.canonical_id = o.id)
        ) THEN
          RAISE EXCEPTION 'Existing unmanaged canonical observation requires reconciliation' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM efra_ingest.canonical_observation co JOIN efra_ingest.source_revision r ON r.id = co.revision_id
          WHERE (co.game_id, co.player_id, co.position, co.metric_code)
            = (candidate.game_id, candidate.player_id, candidate.position, metric.metric_code)
            AND r.source_id <> candidate.source_code
        ) THEN
          RAISE EXCEPTION 'Conflicting canonical source requires reconciliation' USING ERRCODE = '23514';
        END IF;
        previous_observation := NULL;
        IF candidate.supersedes_source_revision IS NOT NULL THEN
          SELECT co.canonical_id INTO previous_observation FROM efra_ingest.canonical_observation co
          JOIN efra_ingest.source_revision r ON r.id = co.revision_id
          WHERE (r.source_id, r.season_id, r.source_revision, co.game_id, co.player_id, co.position, co.metric_code)
            = (candidate.source_code, candidate.season_id::text, candidate.supersedes_source_revision,
               candidate.game_id, candidate.player_id, candidate.position, metric.metric_code);
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Correction has no projected predecessor' USING ERRCODE = '23514';
          END IF;
        ELSIF EXISTS (
          SELECT 1 FROM efra_ingest.canonical_observation co JOIN efra_ingest.source_revision r ON r.id = co.revision_id
          WHERE (r.source_id, co.game_id, co.player_id, co.position, co.metric_code)
            = (candidate.source_code, candidate.game_id, candidate.player_id, candidate.position, metric.metric_code)
        ) THEN
          RAISE EXCEPTION 'Correction requires an explicit predecessor' USING ERRCODE = '23514';
        END IF;
        INSERT INTO efra.stat_observations (
          import_batch_id, player_id, game_id, season_id, team_id, position_code, metric_code, value, exposure_unit, data_status, supersedes_id
        ) VALUES (
          canonical_batch_id, candidate.player_id, candidate.game_id, candidate.season_id, candidate.team_id,
          candidate.position, metric.metric_code, observed, metric.unit, 'verified', previous_observation
        ) RETURNING id INTO new_observation;
        INSERT INTO efra_ingest.canonical_observation
          VALUES (candidate.revision_id, candidate.stage_id, candidate.game_id, candidate.player_id, candidate.position,
            metric.metric_code, new_observation, previous_observation);
      END IF;
      INSERT INTO efra_ingest.projection_item VALUES (request_id, requested_version, new_observation, candidate.stage_id);
    END LOOP;
    IF (passing#>>'{completions,value}')::numeric + (passing#>>'{interceptions,value}')::numeric > (passing#>>'{attempts,value}')::numeric
      OR (passing#>>'{touchdowns,value}')::numeric > (passing#>>'{completions,value}')::numeric
      OR ((passing#>>'{completions,value}')::numeric = 0 AND (passing#>>'{yards,value}')::numeric <> 0) THEN
      RAISE EXCEPTION 'Inconsistent canonical passing totals' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM efra_ingest.projection_item p WHERE p.snapshot_id = request_id AND p.projection_version = requested_version)
    <> 5 * (SELECT count(*) FROM efra_ingest.snapshot_game WHERE snapshot_id = request_id) THEN
    RAISE EXCEPTION 'Projection did not cover the entire released snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN 'PROJECTED';
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.project_snapshot(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.project_snapshot(text, text) TO efra_ingest_projector;

CREATE FUNCTION efra_ingest.read_rating_projection(request_id text, requested_version text)
RETURNS TABLE (snapshot_id text, schema_version text, cutoff timestamptz, observation_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM efra_ingest.authenticated_subject('READER');
  RETURN QUERY SELECT s.id, s.schema_version, s.as_of, array_agg(i.canonical_id ORDER BY i.canonical_id)
  FROM efra_ingest.snapshot s JOIN efra_ingest.projection_item i ON i.snapshot_id = s.id
  WHERE s.id = request_id AND i.projection_version = requested_version GROUP BY s.id;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.read_rating_projection(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_ingest.read_rating_projection(text, text) TO efra_ingest_reader;
