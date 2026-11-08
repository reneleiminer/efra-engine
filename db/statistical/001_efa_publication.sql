CREATE SCHEMA efra_statistical;
REVOKE ALL ON SCHEMA efra_statistical FROM PUBLIC;
CREATE ROLE efra_statistical_writer NOLOGIN;
CREATE ROLE efra_statistical_reader NOLOGIN;
GRANT USAGE ON SCHEMA efra_statistical TO efra_statistical_writer, efra_statistical_reader;

CREATE TABLE efra_statistical.scope (
  environment text PRIMARY KEY CHECK (environment ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  competition_id uuid NOT NULL,
  season_id uuid NOT NULL,
  licensed_enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE efra_statistical.grant (
  environment text NOT NULL REFERENCES efra_statistical.scope,
  person text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('REVIEWER', 'PUBLISHER')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (environment, person),
  UNIQUE (environment, issuer, subject)
);
CREATE TABLE efra_statistical.event (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY,
  environment text NOT NULL REFERENCES efra_statistical.scope,
  previous uuid REFERENCES efra_statistical.event,
  action text NOT NULL CHECK (action IN ('REVIEW', 'PUBLISH', 'REVOKE')),
  target text NOT NULL CHECK (target ~ '^[0-9a-f]{64}$'),
  group_sha text NOT NULL CHECK (group_sha ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (origin IN ('SYNTHETIC', 'REAL')),
  release_sha text CHECK (release_sha ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  cutoff timestamptz,
  lineage jsonb,
  actor text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  session_sha text NOT NULL CHECK (session_sha ~ '^[0-9a-f]{64}$'),
  action_sha text NOT NULL CHECK (action_sha ~ '^[0-9a-f]{64}$'),
  action_key text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((action = 'PUBLISH') = (release_sha IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK ((action = 'REVIEW') = (lineage IS NOT NULL AND cutoff IS NOT NULL)),
  FOREIGN KEY (environment, actor) REFERENCES efra_statistical.grant(environment, person)
);
CREATE INDEX event_head ON efra_statistical.event(environment, seq DESC);
CREATE UNIQUE INDEX event_review_once ON efra_statistical.event(environment,target) WHERE action = 'REVIEW';

CREATE FUNCTION efra_statistical.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Statistical publication journal is append-only' USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_statistical.event
FOR EACH STATEMENT EXECUTE FUNCTION efra_statistical.reject_mutation();

CREATE FUNCTION efra_statistical.commit_action(
  env text, nonce uuid, operation text, expected uuid, target_hash text, human text, external_issuer text,
  external_subject text, session_hash text, action_key_id text, action_hash text, action_expiry timestamptz, explanation text, evidence jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cfg efra_statistical.scope%ROWTYPE;
  head efra_statistical.event%ROWTYPE;
  review efra_statistical.event%ROWTYPE;
  next_group text;
  next_origin text;
  next_release text;
  next_expiry timestamptz;
  next_cutoff timestamptz;
  next_lineage jsonb;
BEGIN
  SELECT * INTO STRICT cfg FROM efra_statistical.scope s WHERE s.environment = env FOR UPDATE;
  IF operation IS NULL OR operation NOT IN ('REVIEW','PUBLISH','REVOKE') OR action_expiry IS NULL OR action_expiry <= clock_timestamp()
    OR NOT EXISTS (SELECT FROM efra_statistical.grant g WHERE (g.environment,g.person,g.issuer,g.subject) =
      (env,human,external_issuer,external_subject) AND g.active
      AND g.role = CASE WHEN operation = 'REVIEW' THEN 'REVIEWER' ELSE 'PUBLISHER' END FOR SHARE)
  THEN RAISE EXCEPTION 'No active EFA publication grant' USING ERRCODE = '42501'; END IF;

  SELECT * INTO head FROM efra_statistical.event e WHERE e.environment = env ORDER BY e.seq DESC LIMIT 1;
  IF head.id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Stale EFA publication head' USING ERRCODE = '40001'; END IF;
  IF operation = 'REVIEW' THEN
    IF (evidence->>'competitionId',evidence->>'seasonId') IS DISTINCT FROM (cfg.competition_id::text,cfg.season_id::text)
      OR ((evidence->>'origin' = 'REAL') IS DISTINCT FROM cfg.licensed_enabled)
    THEN RAISE EXCEPTION 'EFA evidence is outside the configured scope' USING ERRCODE = '42501'; END IF;
    next_group := evidence->>'groupSha256';
    next_origin := evidence->>'origin';
    next_cutoff := (evidence->>'asOf')::timestamptz;
    next_lineage := evidence->'lineage';
    IF jsonb_typeof(next_lineage) IS DISTINCT FROM 'object' OR next_lineage = '{}'::jsonb
      OR EXISTS (SELECT FROM jsonb_each(next_lineage) n WHERE jsonb_typeof(n.value) IS DISTINCT FROM 'array')
    THEN RAISE EXCEPTION 'Invalid EFA revision lineage' USING ERRCODE = '23514'; END IF;
    SELECT * INTO review FROM efra_statistical.event e WHERE e.environment = env AND e.action = 'REVIEW'
      AND e.origin = next_origin ORDER BY e.seq DESC LIMIT 1;
    IF review.id IS NOT NULL AND (next_cutoff <= review.cutoff OR EXISTS (
      SELECT FROM jsonb_each(review.lineage) prior
      CROSS JOIN LATERAL jsonb_array_elements(prior.value) WITH ORDINALITY AS old(digest, ordinal)
      WHERE (next_lineage->prior.key->(old.ordinal - 1)::integer) IS DISTINCT FROM old.digest
    )) THEN RAISE EXCEPTION 'EFA correction cannot rewrite the reviewed lineage or cutoff' USING ERRCODE = '23514'; END IF;
  ELSIF operation = 'PUBLISH' THEN
    IF head.id IS NULL OR head.action <> 'REVIEW' OR head.origin <> 'REAL' OR NOT cfg.licensed_enabled OR head.actor = human
      OR head.target IS DISTINCT FROM target_hash OR head.group_sha IS DISTINCT FROM evidence->>'groupSha256'
      OR NOT EXISTS (SELECT FROM efra_statistical.grant g WHERE g.environment = env AND g.person = head.actor
        AND g.issuer = head.issuer AND g.subject = head.subject AND g.role = 'REVIEWER' AND g.active FOR SHARE)
    THEN RAISE EXCEPTION 'Current independent licensed review required' USING ERRCODE = '42501'; END IF;
    next_group := head.group_sha;
    next_origin := head.origin;
    next_release := evidence->>'releaseSha256';
    next_expiry := (evidence->>'expiresAt')::timestamptz;
    IF next_release IS NULL OR next_expiry IS NULL OR next_expiry <= clock_timestamp()
    THEN RAISE EXCEPTION 'Unusable EFA release' USING ERRCODE = '23514'; END IF;
  ELSE
    IF head.id IS NULL OR head.action <> 'PUBLISH' OR head.release_sha IS DISTINCT FROM target_hash
    THEN RAISE EXCEPTION 'Only the current EFA release may be revoked' USING ERRCODE = '23514'; END IF;
    next_group := head.group_sha;
    next_origin := head.origin;
  END IF;
  INSERT INTO efra_statistical.event (id,environment,previous,action,target,group_sha,origin,release_sha,expires_at,cutoff,lineage,
    actor,issuer,subject,session_sha,action_key,action_sha,reason)
  VALUES (nonce,env,expected,operation,target_hash,next_group,next_origin,next_release,next_expiry,next_cutoff,next_lineage,
    human,external_issuer,external_subject,session_hash,action_key_id,action_hash,explanation);
  RETURN nonce;
END;
$$;

CREATE FUNCTION efra_statistical.active_release(env text)
RETURNS TABLE (id uuid, group_sha text, target text, release_sha text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.id,h.group_sha,h.target,h.release_sha
  FROM (SELECT * FROM efra_statistical.event e WHERE e.environment = env ORDER BY e.seq DESC LIMIT 1) h
  JOIN efra_statistical.scope s ON s.environment = env AND s.licensed_enabled
  JOIN efra_statistical.event r ON r.id = h.previous AND r.environment = env AND r.action = 'REVIEW'
  JOIN efra_statistical.grant g ON (g.environment,g.person,g.issuer,g.subject,g.role) = (env,h.actor,h.issuer,h.subject,'PUBLISHER') AND g.active
  JOIN efra_statistical.grant v ON (v.environment,v.person,v.issuer,v.subject,v.role) = (env,r.actor,r.issuer,r.subject,'REVIEWER') AND v.active
  WHERE h.action = 'PUBLISH' AND h.origin = 'REAL' AND h.expires_at > clock_timestamp()
$$;

CREATE FUNCTION efra_statistical.head_receipt(env text)
RETURNS TABLE (id uuid, action text, target text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.id,e.action,e.target FROM efra_statistical.event e WHERE e.environment = env ORDER BY e.seq DESC LIMIT 1
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA efra_statistical FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_statistical.commit_action(text,uuid,text,uuid,text,text,text,text,text,text,text,timestamptz,text,jsonb)
  TO efra_statistical_writer;
GRANT EXECUTE ON FUNCTION efra_statistical.active_release(text) TO efra_statistical_reader;
GRANT EXECUTE ON FUNCTION efra_statistical.head_receipt(text) TO efra_statistical_writer;
