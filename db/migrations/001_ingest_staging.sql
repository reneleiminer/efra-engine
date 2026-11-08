CREATE SCHEMA efra_ingest;
REVOKE ALL ON SCHEMA efra_ingest FROM PUBLIC;

CREATE TABLE efra_ingest.source_revision (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL CHECK (btrim(source_id) <> ''),
  competition_id text NOT NULL CHECK (btrim(competition_id) <> ''),
  season_id text NOT NULL CHECK (btrim(season_id) <> ''),
  source_revision text NOT NULL CHECK (btrim(source_revision) <> ''),
  supersedes_source_revision text CHECK (supersedes_source_revision IS DISTINCT FROM source_revision),
  origin text NOT NULL CHECK (origin = 'SYNTHETIC'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  UNIQUE (source_id, competition_id, season_id, source_revision),
  FOREIGN KEY (source_id, competition_id, season_id, supersedes_source_revision)
    REFERENCES efra_ingest.source_revision (source_id, competition_id, season_id, source_revision)
);
CREATE INDEX source_revision_predecessor_idx ON efra_ingest.source_revision
  (source_id, competition_id, season_id, supersedes_source_revision) WHERE supersedes_source_revision IS NOT NULL;

CREATE TABLE efra_ingest.import_batch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision_id bigint NOT NULL REFERENCES efra_ingest.source_revision,
  mapping_version text NOT NULL CHECK (btrim(mapping_version) <> ''),
  schema_version text NOT NULL CHECK (btrim(schema_version) <> ''),
  batch_key text NOT NULL,
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  retrieved_at timestamptz NOT NULL CHECK (isfinite(retrieved_at)),
  UNIQUE (revision_id, mapping_version, schema_version)
);

CREATE TABLE efra_ingest.staged_game (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES efra_ingest.import_batch,
  source_record_id text NOT NULL CHECK (btrim(source_record_id) <> ''),
  game_id text NOT NULL CHECK (btrim(game_id) <> ''),
  player_id text NOT NULL CHECK (btrim(player_id) <> ''),
  position text NOT NULL CHECK (position IN (
    'QB','RB','FB','WR','TE','OT','OG','C','DT','NT','EDGE','ILB','MLB','OLB','CB','FS','SS','S','K','P','KR','PR','LS','GUNNER'
  )),
  status text NOT NULL CHECK (status IN ('STAGE', 'STAGE_INCOMPLETE')),
  issues text[] NOT NULL CHECK (
    (status = 'STAGE' AND cardinality(issues) = 0)
    OR (status = 'STAGE_INCOMPLETE' AND issues = ARRAY['CORE_INCOMPLETE'])
  ),
  game jsonb NOT NULL CHECK (
    jsonb_typeof(game) = 'object'
    AND game->>'gameId' IS NOT DISTINCT FROM game_id
    AND game->>'playerId' IS NOT DISTINCT FROM player_id
    AND game->>'position' IS NOT DISTINCT FROM position
    AND game#>>'{usage,source,origin}' IS NOT DISTINCT FROM 'SYNTHETIC'
    AND NOT jsonb_path_exists(game, '$.**.origin ? (@ != "SYNTHETIC")')
  ),
  UNIQUE (batch_id, source_record_id),
  UNIQUE (batch_id, game_id, player_id, position),
  UNIQUE (id, status),
  UNIQUE (id, game_id, player_id, position)
);

CREATE TABLE efra_ingest.quarantine (
  batch_id bigint NOT NULL REFERENCES efra_ingest.import_batch,
  decision_ordinal integer NOT NULL CHECK (decision_ordinal > 0),
  source_record_id text NOT NULL,
  issues text[] NOT NULL CHECK (cardinality(issues) > 0 AND array_position(issues, NULL) IS NULL),
  PRIMARY KEY (batch_id, decision_ordinal)
);

CREATE FUNCTION efra_ingest.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EFRA import records are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.source_revision
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.import_batch
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.staged_game
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
