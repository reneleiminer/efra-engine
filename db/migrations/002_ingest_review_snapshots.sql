CREATE TABLE efra_ingest.review (
  stage_id bigint PRIMARY KEY,
  stage_status text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reviewer_id text NOT NULL CHECK (btrim(reviewer_id) <> ''),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  reviewed_at timestamptz NOT NULL CHECK (isfinite(reviewed_at)),
  FOREIGN KEY (stage_id, stage_status) REFERENCES efra_ingest.staged_game (id, status),
  UNIQUE (stage_id, decision),
  CHECK (decision <> 'APPROVED' OR stage_status = 'STAGE')
);

CREATE TABLE efra_ingest.snapshot (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  competition_id text NOT NULL CHECK (btrim(competition_id) <> ''),
  season_id text NOT NULL CHECK (btrim(season_id) <> ''),
  schema_version text NOT NULL CHECK (btrim(schema_version) <> ''),
  as_of timestamptz NOT NULL CHECK (isfinite(as_of)),
  created_xid xid8 NOT NULL,
  origin text NOT NULL DEFAULT 'SYNTHETIC' CHECK (origin = 'SYNTHETIC')
);

CREATE TABLE efra_ingest.snapshot_game (
  snapshot_id text NOT NULL REFERENCES efra_ingest.snapshot,
  stage_id bigint NOT NULL,
  game_id text NOT NULL,
  player_id text NOT NULL,
  position text NOT NULL,
  review_decision text NOT NULL DEFAULT 'APPROVED' CHECK (review_decision = 'APPROVED'),
  PRIMARY KEY (snapshot_id, game_id, player_id, position),
  FOREIGN KEY (stage_id, game_id, player_id, position) REFERENCES efra_ingest.staged_game (id, game_id, player_id, position),
  FOREIGN KEY (stage_id, review_decision) REFERENCES efra_ingest.review (stage_id, decision)
);
CREATE INDEX snapshot_game_stage_idx ON efra_ingest.snapshot_game (stage_id);

CREATE FUNCTION efra_ingest.record_review_time() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.reviewed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION efra_ingest.record_snapshot_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_xid := pg_current_xact_id();
  RETURN NEW;
END;
$$;

CREATE FUNCTION efra_ingest.check_snapshot_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM efra_ingest.snapshot AS s
    JOIN efra_ingest.staged_game AS g ON g.id = NEW.stage_id
    JOIN efra_ingest.review AS r ON r.stage_id = g.id AND r.decision = 'APPROVED'
    JOIN efra_ingest.import_batch AS b ON b.id = g.batch_id
    JOIN efra_ingest.source_revision AS v ON v.id = b.revision_id
    WHERE s.id = NEW.snapshot_id AND s.created_xid = pg_current_xact_id()
      AND s.competition_id = v.competition_id AND s.season_id = v.season_id AND s.schema_version = b.schema_version
      AND b.retrieved_at <= s.as_of AND r.reviewed_at <= s.as_of
  ) THEN
    RAISE EXCEPTION 'Snapshot member is outside the creation transaction, review, scope or cutoff' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION efra_ingest.require_snapshot_members() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM efra_ingest.snapshot_game WHERE snapshot_id = NEW.id) THEN
    RAISE EXCEPTION 'EFRA snapshots must contain reviewed games' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER record_time BEFORE INSERT ON efra_ingest.review
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.record_review_time();
CREATE TRIGGER record_transaction BEFORE INSERT ON efra_ingest.snapshot
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.record_snapshot_transaction();
CREATE TRIGGER check_member BEFORE INSERT ON efra_ingest.snapshot_game
  FOR EACH ROW EXECUTE FUNCTION efra_ingest.check_snapshot_member();
CREATE CONSTRAINT TRIGGER require_members AFTER INSERT ON efra_ingest.snapshot
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION efra_ingest.require_snapshot_members();

CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.review
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_ingest.snapshot_game
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
