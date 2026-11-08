-- Minimal local contract fixture for the existing EFRA relations used by the resolver.
CREATE SCHEMA efra;
CREATE TABLE efra.data_sources (id uuid PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL, reuse_status text NOT NULL);
CREATE TABLE efra.competitions (id uuid PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL, is_cross_border boolean NOT NULL);
CREATE TABLE efra.seasons (
  id uuid PRIMARY KEY, competition_id uuid NOT NULL REFERENCES efra.competitions,
  label text NOT NULL, start_date date, end_date date, UNIQUE (competition_id, label)
);
CREATE TABLE efra.teams (id uuid PRIMARY KEY, canonical_name text NOT NULL);
CREATE TABLE efra.players (id uuid PRIMARY KEY, display_name text NOT NULL);
CREATE TABLE efra.games (
  id uuid PRIMARY KEY, season_id uuid NOT NULL REFERENCES efra.seasons, kickoff_at timestamptz NOT NULL,
  home_team_id uuid NOT NULL REFERENCES efra.teams, away_team_id uuid NOT NULL REFERENCES efra.teams,
  status text NOT NULL CHECK (status IN ('scheduled', 'live', 'final', 'cancelled')), CHECK (home_team_id <> away_team_id)
);
CREATE TABLE efra.external_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES efra.data_sources,
  entity_type text NOT NULL CHECK (entity_type IN ('player', 'team', 'game', 'competition')),
  entity_id uuid NOT NULL, external_key text NOT NULL, UNIQUE (source_id, entity_type, external_key)
);
CREATE TABLE efra.player_appearances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game_id uuid NOT NULL REFERENCES efra.games, player_id uuid NOT NULL REFERENCES efra.players,
  team_id uuid NOT NULL REFERENCES efra.teams, position_code text NOT NULL, snaps integer CHECK (snaps >= 0),
  exposure_quality text NOT NULL CHECK (exposure_quality IN ('unknown', 'estimated', 'verified')),
  UNIQUE (game_id, player_id, team_id, position_code)
);
CREATE TABLE efra.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES efra.data_sources,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'validated', 'rejected', 'failed')),
  raw_sha256 text, notes text
);
CREATE TABLE efra.stat_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), import_batch_id uuid NOT NULL REFERENCES efra.import_batches,
  player_id uuid REFERENCES efra.players, game_id uuid REFERENCES efra.games,
  season_id uuid REFERENCES efra.seasons, team_id uuid REFERENCES efra.teams,
  position_code text NOT NULL, metric_code text NOT NULL, value numeric NOT NULL, exposure_unit text,
  data_status text NOT NULL CHECK (data_status IN ('unverified', 'verified', 'under_review', 'rejected')),
  recorded_at timestamptz NOT NULL DEFAULT now(), supersedes_id uuid REFERENCES efra.stat_observations,
  CHECK (game_id IS NOT NULL OR team_id IS NOT NULL)
);
