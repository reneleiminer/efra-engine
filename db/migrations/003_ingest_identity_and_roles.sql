CREATE TABLE efra_ingest.synthetic_source (
  source_id uuid PRIMARY KEY REFERENCES efra.data_sources(id)
);

-- The existing external_ids discriminator does not include seasons.
CREATE TABLE efra_ingest.season_alias (
  source_id uuid NOT NULL REFERENCES efra_ingest.synthetic_source,
  competition_id uuid NOT NULL REFERENCES efra.competitions(id),
  external_key text NOT NULL CHECK (btrim(external_key) <> ''),
  season_id uuid NOT NULL REFERENCES efra.seasons(id),
  PRIMARY KEY (source_id, competition_id, external_key)
);
CREATE INDEX season_alias_competition_idx ON efra_ingest.season_alias (competition_id);
CREATE INDEX season_alias_season_idx ON efra_ingest.season_alias (season_id);

CREATE FUNCTION efra_ingest.valid_game_identity(
  game_uuid uuid, player_uuid uuid, team_uuid uuid, opponent_uuid uuid, season_uuid uuid, position_key text, usage_key text
) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM efra.games AS g
    JOIN efra.players AS p ON p.id = player_uuid
    WHERE g.id = game_uuid AND g.season_id = season_uuid AND g.status = 'final'
      AND ((g.home_team_id = team_uuid AND g.away_team_id = opponent_uuid)
        OR (g.away_team_id = team_uuid AND g.home_team_id = opponent_uuid))
      AND (
        (usage_key = 'PLAYED' AND EXISTS (
          SELECT 1 FROM efra.player_appearances AS a
          WHERE a.game_id = g.id AND a.player_id = p.id AND a.position_code = position_key AND a.team_id = team_uuid
            AND a.exposure_quality = 'verified' AND a.snaps > 0
        ) AND NOT EXISTS (
          SELECT 1 FROM efra.player_appearances AS a
          WHERE a.game_id = g.id AND a.player_id = p.id AND a.position_code = position_key AND a.team_id <> team_uuid
        ))
        OR (usage_key = 'DID_NOT_PLAY' AND NOT EXISTS (
          SELECT 1 FROM efra.player_appearances AS a
          WHERE a.game_id = g.id AND a.player_id = p.id AND a.position_code = position_key
        ))
      )
  );
$$;
REVOKE ALL ON FUNCTION efra_ingest.valid_game_identity(uuid, uuid, uuid, uuid, uuid, text, text) FROM PUBLIC;

CREATE FUNCTION efra_ingest.resolve_import_identities(
  provider_code text, league_key text, season_key text, candidates jsonb
) RETURNS TABLE (competition_id uuid, season_id uuid, resolved jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH scope AS (
    SELECT src.id AS source_id, c.id AS competition_id, s.id AS season_id
    FROM efra.data_sources AS src
    JOIN efra_ingest.synthetic_source AS permitted ON permitted.source_id = src.id
    JOIN efra.external_ids AS lc ON lc.source_id = src.id AND lc.entity_type = 'competition' AND lc.external_key = league_key
    JOIN efra.competitions AS c ON c.id = lc.entity_id
    JOIN efra_ingest.season_alias AS sa ON sa.source_id = src.id AND sa.competition_id = c.id AND sa.external_key = season_key
    JOIN efra.seasons AS s ON s.id = sa.season_id AND s.competition_id = c.id
    WHERE src.code = provider_code AND src.code LIKE 'sim-%'
  )
  SELECT scope.competition_id, scope.season_id, COALESCE(matches.resolved, '[]'::jsonb)
  FROM scope
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'ordinal', x.ordinal, 'gameId', ga.entity_id, 'playerId', pa.entity_id,
      'teamId', ta.entity_id, 'opponentId', oa.entity_id
    ) ORDER BY x.ordinal) AS resolved
    FROM jsonb_to_recordset(candidates) AS x(
      ordinal integer, game_key text, player_key text, team_key text, opponent_key text, position text, usage text
    )
    JOIN efra.external_ids AS ga ON ga.source_id = scope.source_id AND ga.entity_type = 'game' AND ga.external_key = x.game_key
    JOIN efra.external_ids AS pa ON pa.source_id = scope.source_id AND pa.entity_type = 'player' AND pa.external_key = x.player_key
    JOIN efra.external_ids AS ta ON ta.source_id = scope.source_id AND ta.entity_type = 'team' AND ta.external_key = x.team_key
    JOIN efra.external_ids AS oa ON oa.source_id = scope.source_id AND oa.entity_type = 'team' AND oa.external_key = x.opponent_key
    WHERE efra_ingest.valid_game_identity(ga.entity_id, pa.entity_id, ta.entity_id, oa.entity_id,
      scope.season_id, x.position, x.usage)
  ) AS matches;
$$;
REVOKE ALL ON FUNCTION efra_ingest.resolve_import_identities(text, text, text, jsonb) FROM PUBLIC;

ALTER TABLE efra_ingest.import_batch ADD COLUMN created_xid xid8 NOT NULL DEFAULT pg_current_xact_id();

CREATE FUNCTION efra_ingest.check_revision_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM efra.data_sources AS src
    JOIN efra_ingest.synthetic_source AS permitted ON permitted.source_id = src.id
    JOIN efra_ingest.season_alias AS sa ON sa.source_id = src.id
    JOIN efra.seasons AS s ON s.id = sa.season_id AND s.competition_id = sa.competition_id
    WHERE src.code = NEW.source_id AND src.code LIKE 'sim-%'
      AND s.id::text = NEW.season_id AND s.competition_id::text = NEW.competition_id
  ) THEN
    RAISE EXCEPTION 'Import revision is outside the registered synthetic scope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION efra_ingest.check_batch_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  canonical_season text;
BEGIN
  SELECT r.season_id INTO canonical_season
  FROM efra_ingest.import_batch AS b JOIN efra_ingest.source_revision AS r ON r.id = b.revision_id
  WHERE b.id = NEW.batch_id AND b.created_xid = pg_current_xact_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch members must be written in the creation transaction' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'staged_game' THEN
    IF NEW.game->>'seasonId' IS DISTINCT FROM canonical_season
      OR NOT efra_ingest.valid_game_identity(
        NEW.game_id::uuid, NEW.player_id::uuid, (NEW.game->>'teamId')::uuid, (NEW.game->>'opponentId')::uuid,
        canonical_season::uuid, NEW.position, NEW.game#>>'{usage,status}'
      ) THEN
      RAISE EXCEPTION 'Staged game has inconsistent canonical identity or participation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.check_revision_scope(), efra_ingest.check_batch_member() FROM PUBLIC;
CREATE TRIGGER check_scope BEFORE INSERT ON efra_ingest.source_revision
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.check_revision_scope();
CREATE TRIGGER check_batch BEFORE INSERT ON efra_ingest.staged_game
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.check_batch_member();
CREATE TRIGGER check_batch BEFORE INSERT ON efra_ingest.quarantine
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.check_batch_member();

CREATE VIEW efra_ingest.approved_snapshot_export WITH (security_barrier = true) AS
SELECT s.id AS "snapshotId", s.competition_id AS "competitionId", s.season_id AS "seasonId",
       s.schema_version AS "schemaVersion", s.as_of AS "asOf",
       jsonb_agg(jsonb_build_object(
         'stageId', g.id::text, 'sourceRecordId', g.source_record_id, 'sourceId', v.source_id,
         'sourceRevision', v.source_revision, 'supersedesSourceRevision', v.supersedes_source_revision,
         'payloadSha256', v.payload_sha256, 'mappingVersion', b.mapping_version, 'batchKey', b.batch_key,
         'retrievedAt', to_char(b.retrieved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'reviewedAt', to_char(r.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         'reviewerId', r.reviewer_id, 'reviewReason', r.reason, 'game', g.game
       ) ORDER BY g.game_id COLLATE "C", g.player_id COLLATE "C", g.position COLLATE "C") AS games
FROM efra_ingest.snapshot AS s
JOIN efra_ingest.snapshot_game AS m ON m.snapshot_id = s.id
JOIN efra_ingest.staged_game AS g ON g.id = m.stage_id
JOIN efra_ingest.review AS r ON r.stage_id = g.id
JOIN efra_ingest.import_batch AS b ON b.id = g.batch_id
JOIN efra_ingest.source_revision AS v ON v.id = b.revision_id
GROUP BY s.id;

CREATE ROLE efra_ingest_importer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE efra_ingest_reviewer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE efra_ingest_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA efra_ingest TO efra_ingest_importer, efra_ingest_reviewer, efra_ingest_reader;
GRANT EXECUTE ON FUNCTION efra_ingest.resolve_import_identities(text, text, text, jsonb) TO efra_ingest_importer;
GRANT SELECT, INSERT ON efra_ingest.source_revision TO efra_ingest_importer;
GRANT SELECT ON efra_ingest.import_batch TO efra_ingest_importer;
GRANT INSERT (revision_id, mapping_version, schema_version, batch_key, plan_sha256, retrieved_at)
  ON efra_ingest.import_batch TO efra_ingest_importer;
GRANT INSERT ON efra_ingest.staged_game, efra_ingest.quarantine TO efra_ingest_importer;
GRANT SELECT ON efra_ingest.source_revision, efra_ingest.import_batch, efra_ingest.staged_game,
  efra_ingest.quarantine, efra_ingest.review, efra_ingest.snapshot, efra_ingest.snapshot_game TO efra_ingest_reviewer;
GRANT INSERT (stage_id, stage_status, decision, reviewer_id, reason) ON efra_ingest.review TO efra_ingest_reviewer;
GRANT INSERT (id, competition_id, season_id, schema_version, as_of) ON efra_ingest.snapshot TO efra_ingest_reviewer;
GRANT INSERT (snapshot_id, stage_id, game_id, player_id, position) ON efra_ingest.snapshot_game TO efra_ingest_reviewer;
GRANT SELECT ON efra_ingest.approved_snapshot_export TO efra_ingest_reader;
