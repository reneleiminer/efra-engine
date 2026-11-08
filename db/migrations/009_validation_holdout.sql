CREATE SCHEMA efra_validation;
REVOKE ALL ON SCHEMA efra_validation FROM PUBLIC;
CREATE ROLE efra_validation_custodian NOLOGIN;
CREATE ROLE efra_validation_researcher NOLOGIN;
CREATE ROLE efra_validation_approver NOLOGIN;
CREATE ROLE efra_validation_worker NOLOGIN;
GRANT USAGE ON SCHEMA efra_validation TO efra_validation_custodian, efra_validation_researcher,
  efra_validation_approver, efra_validation_worker;

CREATE TABLE efra_validation.principal (
  login name PRIMARY KEY, login_oid oid NOT NULL UNIQUE, subject text NOT NULL UNIQUE CHECK (btrim(subject) <> ''),
  capability text NOT NULL CHECK (capability IN ('custodian','researcher','approver','worker')),
  active boolean NOT NULL DEFAULT true
);
CREATE FUNCTION efra_validation.has_capability(principal efra_validation.principal, required text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT FROM pg_catalog.pg_roles r
  WHERE (principal.login, principal.login_oid) = (r.rolname, r.oid) AND r.rolcanlogin
    AND principal.active AND principal.capability = required
    AND pg_has_role(r.oid, 'efra_validation_' || required, 'MEMBER')
    AND NOT EXISTS (SELECT FROM pg_catalog.pg_roles g
      WHERE ((g.rolname LIKE 'efra_validation_%' AND g.rolname IN
        ('efra_validation_custodian','efra_validation_researcher','efra_validation_approver','efra_validation_worker')
        AND g.rolname <> 'efra_validation_' || required)
        OR (g.rolname = 'efra_ingest_reader' AND required <> 'custodian')
        OR g.rolname IN ('efra_ingest_importer','efra_ingest_reviewer','efra_ingest_publisher',
          'efra_ingest_projector','efra_ingest_evidence_attestor'))
        AND pg_has_role(r.oid, g.oid, 'MEMBER')));
$$;
CREATE FUNCTION efra_validation.subject(required text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor text;
BEGIN
  SELECT p.subject INTO actor FROM efra_validation.principal p
  WHERE p.login = session_user AND efra_validation.has_capability(p,required);
  IF actor IS NULL THEN RAISE EXCEPTION 'Unauthorized validation principal' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END;
$$;

-- An accidentally dual-provisioned research principal may not bypass the vault via the old reader.
ALTER FUNCTION efra_ingest.authenticated_subject(text) RENAME TO authenticated_ingest_subject;
CREATE FUNCTION efra_ingest.authenticated_subject(required_capability text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF required_capability = 'READER' AND EXISTS (SELECT FROM pg_catalog.pg_roles r
    WHERE r.rolname IN ('efra_validation_researcher','efra_validation_approver','efra_validation_worker')
      AND pg_has_role(session_user,r.oid,'MEMBER'))
  THEN RAISE EXCEPTION 'Canonical reads are incompatible with this validation role' USING ERRCODE = '42501'; END IF;
  RETURN efra_ingest.authenticated_ingest_subject(required_capability);
END;
$$;
REVOKE ALL ON FUNCTION efra_ingest.authenticated_subject(text) FROM PUBLIC;

CREATE TABLE efra_validation.dataset (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  researcher text NOT NULL REFERENCES efra_validation.principal(subject),
  custodian text NOT NULL REFERENCES efra_validation.principal(subject),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (custodian <> researcher)
);
CREATE TABLE efra_validation.evidence_partition (
  evidence_key text PRIMARY KEY CHECK (btrim(evidence_key) <> ''),
  partition text NOT NULL CHECK (partition IN ('train','validation','test')),
  UNIQUE (evidence_key, partition)
);
CREATE TABLE efra_validation.dataset_evidence (
  dataset_id text NOT NULL REFERENCES efra_validation.dataset,
  evidence_key text NOT NULL,
  partition text NOT NULL,
  PRIMARY KEY (dataset_id, evidence_key),
  FOREIGN KEY (evidence_key, partition) REFERENCES efra_validation.evidence_partition(evidence_key, partition)
);
CREATE TABLE efra_validation.approval (
  dataset_id text PRIMARY KEY REFERENCES efra_validation.dataset,
  sha256 text NOT NULL,
  approver text NOT NULL REFERENCES efra_validation.principal(subject),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE efra_validation.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  login name NOT NULL DEFAULT session_user,
  actor text NOT NULL REFERENCES efra_validation.principal(subject),
  action text NOT NULL CHECK (action IN ('CANONICAL_READ','SEALED','MANIFEST_REVIEWED','APPROVED','DEV_REQUEST','DEV_READ',
    'TEST_OPEN','TEST_REPLAY','TEST_READ','REPORT_WRITTEN','REPORT_REQUEST','REPORT_READ','EVALUATION_FAILED')),
  resource text NOT NULL,
  detail text,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE efra_validation.development_ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id text NOT NULL REFERENCES efra_validation.dataset,
  partition text NOT NULL CHECK (partition IN ('train','validation','report')),
  researcher text NOT NULL REFERENCES efra_validation.principal(subject),
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE efra_validation.development_redemption (
  ticket_id uuid PRIMARY KEY REFERENCES efra_validation.development_ticket
);
CREATE TABLE efra_validation.evaluation (
  dataset_id text PRIMARY KEY REFERENCES efra_validation.approval,
  run_id uuid NOT NULL UNIQUE,
  worker text NOT NULL REFERENCES efra_validation.principal(subject)
);
CREATE TABLE efra_validation.evaluation_ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id text NOT NULL REFERENCES efra_validation.evaluation,
  worker text NOT NULL REFERENCES efra_validation.principal(subject),
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE efra_validation.evaluation_redemption (
  ticket_id uuid PRIMARY KEY REFERENCES efra_validation.evaluation_ticket,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE efra_validation.consumed_holdout (
  evidence_key text PRIMARY KEY REFERENCES efra_validation.evidence_partition,
  dataset_id text NOT NULL REFERENCES efra_validation.evaluation
);
CREATE TABLE efra_validation.report (
  dataset_id text PRIMARY KEY REFERENCES efra_validation.evaluation,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
CREATE TABLE efra_validation.canonical_anchor (
  snapshot_id text PRIMARY KEY REFERENCES efra_ingest.position_projection,
  first_seen_at timestamptz NOT NULL DEFAULT (date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond')
);

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['dataset','evidence_partition','dataset_evidence','approval','audit',
    'development_ticket','development_redemption','evaluation','evaluation_ticket','evaluation_redemption',
    'consumed_holdout','report','canonical_anchor'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_validation.%I
      FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation()', relation);
  END LOOP;
END;
$$;

CREATE FUNCTION efra_validation.observe_release(snapshot_key text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('custodian');
  seen timestamptz;
BEGIN
  PERFORM efra_ingest.authenticated_subject('READER');
  INSERT INTO efra_validation.canonical_anchor(snapshot_id)
    SELECT p.snapshot_id FROM efra_ingest.position_projection p JOIN efra_ingest.snapshot s ON s.id = p.snapshot_id
    WHERE p.snapshot_id = snapshot_key AND s.release_login IS NOT NULL AND s.origin = 'SYNTHETIC'
    ON CONFLICT (snapshot_id) DO NOTHING;
  SELECT a.first_seen_at INTO seen FROM efra_validation.canonical_anchor a WHERE a.snapshot_id = snapshot_key;
  INSERT INTO efra_validation.audit(actor, action, resource) VALUES (actor, 'CANONICAL_READ', snapshot_key);
  RETURN seen;
END;
$$;

CREATE FUNCTION efra_validation.canonical_proofs(snapshot_key text)
RETURNS TABLE (projected_at timestamptz, available_at timestamptz, proofs jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE seen timestamptz := efra_validation.observe_release(snapshot_key);
BEGIN
  IF seen IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT p.projected_at, seen,
      coalesce(jsonb_agg(jsonb_build_object(
        'stageId', e.stage_id::text, 'field', e.field, 'sourceUuid', c.source_id,
        'sourceProtocolSha256', c.protocol_sha256, 'featureVersion', f.feature_version,
        'attestedAt', to_char(e.attested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'attestedBy', e.attested_by, 'artifacts', e.artifacts
      ) ORDER BY e.stage_id, e.field COLLATE "C") FILTER (WHERE e.stage_id IS NOT NULL), '[]'::jsonb)
    FROM efra_ingest.position_projection p
    JOIN efra_ingest.snapshot s ON s.id = p.snapshot_id AND s.release_login IS NOT NULL AND s.origin = 'SYNTHETIC'
    JOIN efra_ingest.position_projection_item i ON i.snapshot_id = p.snapshot_id
    JOIN efra_ingest.position_fact f ON f.id = i.fact_id
    JOIN efra_ingest.metric_registry m ON (m.position,m.field) = (f.position,f.field)
    JOIN efra_ingest.source_revision v ON v.id = f.revision_id
    JOIN efra.data_sources d ON d.code = v.source_id
    LEFT JOIN efra_ingest.position_metric_evidence e ON (e.stage_id,e.field) = (i.stage_id,f.field)
      AND e.attested_at <= s.as_of AND f.canonical_id IS NOT NULL
    LEFT JOIN efra_ingest.source_capability_evidence c
      ON (c.source_id,c.mapping_version,c.schema_version,c.capability) = (d.id,f.mapping_version,f.schema_version,m.source_capability)
      AND c.attested_at <= s.as_of
    WHERE p.snapshot_id = snapshot_key GROUP BY p.snapshot_id;
END;
$$;

CREATE FUNCTION efra_validation.seal(dataset_key text, dataset_hash text, research_subject text, contents jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('custodian');
  existing efra_validation.dataset%ROWTYPE;
  item record;
BEGIN
  IF contents->>'datasetSha256' IS DISTINCT FROM dataset_hash
    OR contents->>'version' IS DISTINCT FROM 'efra-canonical-validation-v1'
    OR contents#>>'{study,plan,origin}' IS DISTINCT FROM 'SYNTHETIC'
    OR jsonb_path_exists(contents, '$.**.origin ? (@ != "SYNTHETIC")')
    OR (SELECT array_agg(batch->>'partition' ORDER BY (batch->>'partition') COLLATE "C")
      FROM jsonb_array_elements(contents->'batches') AS batch)
      IS DISTINCT FROM ARRAY['test','train','validation']
    OR NOT EXISTS (SELECT FROM efra_validation.principal p
      WHERE p.subject = research_subject AND efra_validation.has_capability(p,'researcher'))
  THEN RAISE EXCEPTION 'Invalid synthetic validation manifest' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(716184, 13);
  SELECT * INTO existing FROM efra_validation.dataset WHERE id = dataset_key;
  IF FOUND THEN
    IF (existing.sha256,existing.payload,existing.researcher,existing.custodian) = (dataset_hash,contents,research_subject,actor)
      THEN RETURN 'ALREADY_SEALED'; END IF;
    RAISE EXCEPTION 'Dataset identity already sealed' USING ERRCODE = '23514';
  END IF;
  INSERT INTO efra_validation.dataset VALUES (dataset_key,dataset_hash,research_subject,actor,contents);
  FOR item IN SELECT batch->>'partition' AS part, k AS evidence
    FROM jsonb_array_elements(contents->'batches') AS batch,
      LATERAL jsonb_array_elements_text(batch->'evidenceKeys') AS k
    ORDER BY k COLLATE "C"
  LOOP
    INSERT INTO efra_validation.evidence_partition VALUES (item.evidence,item.part) ON CONFLICT (evidence_key) DO NOTHING;
    IF NOT EXISTS (SELECT FROM efra_validation.evidence_partition p
      WHERE (p.evidence_key,p.partition) = (item.evidence,item.part))
    THEN RAISE EXCEPTION 'Evidence already assigned to a different partition' USING ERRCODE = '23514'; END IF;
    INSERT INTO efra_validation.dataset_evidence VALUES (dataset_key,item.evidence,item.part);
  END LOOP;
  IF (SELECT count(DISTINCT partition) FROM efra_validation.dataset_evidence WHERE dataset_id = dataset_key) <> 3
  THEN RAISE EXCEPTION 'Each partition requires evidence' USING ERRCODE = '23514'; END IF;
  INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,'SEALED',dataset_key,dataset_hash);
  RETURN 'SEALED';
END;
$$;

CREATE FUNCTION efra_validation.review_manifest(dataset_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('approver');
  result jsonb;
BEGIN
  SELECT jsonb_build_object('datasetSha256',d.sha256,'version',d.payload->'version',
    'engineArtifactSha256',d.payload->'engineArtifactSha256','modelArtifactSha256',d.payload->'modelArtifactSha256',
    'recipeSha256',d.payload->'recipeSha256','product',d.payload#>'{study,product}',
    'plan',d.payload#>'{study,plan}' #- '{leagueContext,bridges}',
    'candidates',d.payload#>'{study,candidates}','sensitivity',d.payload#>'{study,sensitivity}',
    'probabilityFeature',d.payload#>'{study,probabilityFeature}','binEdges',d.payload#>'{study,binEdges}')
  INTO result FROM efra_validation.dataset d WHERE d.id = dataset_key AND actor NOT IN (d.researcher,d.custodian);
  IF NOT FOUND THEN RAISE EXCEPTION 'Review manifest unavailable' USING ERRCODE = '42501'; END IF;
  INSERT INTO efra_validation.audit(actor,action,resource,detail)
    VALUES (actor,'MANIFEST_REVIEWED',dataset_key,result->>'datasetSha256');
  RETURN result;
END;
$$;

CREATE FUNCTION efra_validation.approve(dataset_key text, dataset_hash text, review_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE approving_subject text := efra_validation.subject('approver');
BEGIN
  IF NOT EXISTS (SELECT FROM efra_validation.dataset d WHERE (d.id,d.sha256) = (dataset_key,dataset_hash)
    AND approving_subject NOT IN (d.researcher,d.custodian))
    OR NOT EXISTS (SELECT FROM efra_validation.audit a WHERE (a.actor,a.action,a.resource,a.detail)
      = (approving_subject,'MANIFEST_REVIEWED',dataset_key,dataset_hash) AND a.xid <> pg_current_xact_id())
  THEN RAISE EXCEPTION 'Approval requires an exact sealed dataset and independent subject' USING ERRCODE = '42501'; END IF;
  INSERT INTO efra_validation.approval(dataset_id,sha256,approver,reason)
    VALUES (dataset_key,dataset_hash,approving_subject,review_reason);
  INSERT INTO efra_validation.audit(actor,action,resource,detail)
    VALUES (approving_subject,'APPROVED',dataset_key,dataset_hash);
END;
$$;

CREATE FUNCTION efra_validation.request_development(dataset_key text, requested_partition text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('researcher');
  ticket uuid;
BEGIN
  IF requested_partition IS NULL OR requested_partition NOT IN ('train','validation')
    OR NOT EXISTS (SELECT FROM efra_validation.dataset d WHERE d.id = dataset_key AND d.researcher = actor)
  THEN RAISE EXCEPTION 'Development partition unavailable' USING ERRCODE = '42501'; END IF;
  INSERT INTO efra_validation.development_ticket(dataset_id,partition,researcher)
    VALUES (dataset_key,requested_partition,actor) RETURNING id INTO ticket;
  INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,'DEV_REQUEST',dataset_key,ticket::text);
  RETURN ticket;
END;
$$;

CREATE FUNCTION efra_validation.read_development(ticket uuid, recipient text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('worker');
  request efra_validation.development_ticket%ROWTYPE;
  result jsonb;
BEGIN
  SELECT t.* INTO request FROM efra_validation.development_ticket t JOIN efra_validation.principal p
    ON p.subject = t.researcher AND efra_validation.has_capability(p,'researcher')
  WHERE t.id = ticket AND t.researcher = recipient AND t.partition IN ('train','validation') AND t.xid <> pg_current_xact_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Development ticket unavailable' USING ERRCODE = '42501'; END IF;
  INSERT INTO efra_validation.development_redemption VALUES (ticket);
  SELECT jsonb_build_object('partition',request.partition, 'samples', coalesce(jsonb_agg(entry->'sample'
    ORDER BY (entry#>>'{sample,id}') COLLATE "C") FILTER (WHERE entry->'issues' = '[]'::jsonb), '[]'::jsonb)) INTO result
  FROM efra_validation.dataset d, LATERAL jsonb_array_elements(d.payload->'batches') AS batch,
    LATERAL jsonb_array_elements(batch->'payload') AS entry
  WHERE d.id = request.dataset_id AND batch->>'partition' = request.partition;
  INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,'DEV_READ',request.dataset_id,ticket::text);
  RETURN result;
END;
$$;

CREATE FUNCTION efra_validation.claim_evaluation(dataset_key text, run uuid, engine_digest text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('worker');
  existing efra_validation.evaluation%ROWTYPE;
  action_key text := 'TEST_OPEN';
  ticket uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(716184, 13);
  PERFORM 1 FROM efra_validation.dataset d JOIN efra_validation.approval a
    ON (d.id,d.sha256) = (a.dataset_id,a.sha256)
  JOIN efra_validation.principal p ON p.subject = a.approver AND efra_validation.has_capability(p,'approver')
  WHERE d.id = dataset_key AND d.payload->>'engineArtifactSha256' = engine_digest
    AND a.xid <> pg_current_xact_id() AND actor NOT IN (d.researcher,d.custodian,a.approver);
  IF NOT FOUND THEN RAISE EXCEPTION 'No independent committed approval' USING ERRCODE = '42501'; END IF;
  SELECT * INTO existing FROM efra_validation.evaluation WHERE dataset_id = dataset_key;
  IF FOUND THEN
    IF existing.run_id IS DISTINCT FROM run OR existing.worker <> actor
      THEN RAISE EXCEPTION 'Holdout locked to original run and worker' USING ERRCODE = '42501'; END IF;
    action_key := 'TEST_REPLAY';
  ELSE
    INSERT INTO efra_validation.evaluation VALUES (dataset_key,run,actor);
    INSERT INTO efra_validation.consumed_holdout(evidence_key,dataset_id)
      SELECT evidence_key,dataset_key FROM efra_validation.dataset_evidence
      WHERE dataset_id = dataset_key AND partition = 'test' ORDER BY evidence_key COLLATE "C";
  END IF;
  INSERT INTO efra_validation.evaluation_ticket(dataset_id,worker) VALUES (dataset_key,actor) RETURNING id INTO ticket;
  INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,action_key,dataset_key,run::text);
  RETURN ticket;
END;
$$;

CREATE FUNCTION efra_validation.read_evaluation(ticket uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('worker');
  dataset_key text;
  result jsonb;
BEGIN
  SELECT t.dataset_id,d.payload INTO dataset_key,result FROM efra_validation.evaluation_ticket t
  JOIN efra_validation.dataset d ON d.id = t.dataset_id
  JOIN efra_validation.approval a ON a.dataset_id = t.dataset_id
  JOIN efra_validation.principal p ON p.subject = a.approver AND efra_validation.has_capability(p,'approver')
  WHERE t.id = ticket AND t.worker = actor AND t.xid <> pg_current_xact_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Committed evaluation ticket required' USING ERRCODE = '42501'; END IF;
  INSERT INTO efra_validation.evaluation_redemption(ticket_id) VALUES (ticket);
  INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,'TEST_READ',dataset_key,ticket::text);
  RETURN result;
END;
$$;

CREATE FUNCTION efra_validation.record_report(dataset_key text, run uuid, report jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor text := efra_validation.subject('worker');
BEGIN
  IF NOT EXISTS (SELECT FROM efra_validation.evaluation e
    JOIN efra_validation.evaluation_ticket t ON (t.dataset_id,t.worker) = (e.dataset_id,e.worker)
    JOIN efra_validation.evaluation_redemption r ON r.ticket_id = t.id AND r.xid <> pg_current_xact_id()
    WHERE (e.dataset_id,e.run_id,e.worker) = (dataset_key,run,actor))
  THEN RAISE EXCEPTION 'A committed holdout read is required for the assigned run' USING ERRCODE = '42501'; END IF;
  IF report IS NULL THEN
    INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,'EVALUATION_FAILED',dataset_key,run::text);
    RETURN;
  END IF;
  IF report#>>'{result,label}' IS DISTINCT FROM 'SIMULATION'
    OR report#>'{result,empiricalValidation}' IS DISTINCT FROM 'false'::jsonb
    OR report#>'{result,officialEligible}' IS DISTINCT FROM 'false'::jsonb
    OR NOT EXISTS (SELECT FROM efra_validation.dataset d WHERE d.id = dataset_key AND
      (d.sha256,d.payload->>'modelArtifactSha256',d.payload->>'engineArtifactSha256')
      = (report->>'datasetSha256',report->>'modelArtifactSha256',report->>'engineArtifactSha256'))
  THEN RAISE EXCEPTION 'Invalid simulation report' USING ERRCODE = '23514'; END IF;
  INSERT INTO efra_validation.report VALUES (dataset_key,report) ON CONFLICT (dataset_id) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (SELECT FROM efra_validation.report r WHERE r.dataset_id = dataset_key AND r.payload = report)
    THEN RAISE EXCEPTION 'Report differs from immutable result' USING ERRCODE = '23514'; END IF;
  INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,'REPORT_WRITTEN',dataset_key,run::text);
END;
$$;

CREATE FUNCTION efra_validation.request_report(dataset_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('approver');
  ticket uuid;
BEGIN
  IF NOT EXISTS (SELECT FROM efra_validation.report r JOIN efra_validation.approval a ON a.dataset_id = r.dataset_id
    WHERE r.dataset_id = dataset_key AND a.approver = actor)
  THEN RAISE EXCEPTION 'Report unavailable' USING ERRCODE = '42501'; END IF;
  INSERT INTO efra_validation.development_ticket(dataset_id,partition,researcher)
    VALUES (dataset_key,'report',actor) RETURNING id INTO ticket;
  INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,'REPORT_REQUEST',dataset_key,ticket::text);
  RETURN ticket;
END;
$$;

CREATE FUNCTION efra_validation.read_report(ticket uuid, recipient text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('worker');
  dataset_key text;
  result jsonb;
BEGIN
  SELECT t.dataset_id, r.payload INTO dataset_key, result FROM efra_validation.development_ticket t
  JOIN efra_validation.principal p ON p.subject = t.researcher AND efra_validation.has_capability(p,'approver')
  JOIN efra_validation.report r ON r.dataset_id = t.dataset_id
  WHERE t.id = ticket AND t.researcher = recipient AND t.partition = 'report' AND t.xid <> pg_current_xact_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Report ticket unavailable' USING ERRCODE = '42501'; END IF;
  INSERT INTO efra_validation.development_redemption VALUES (ticket);
  INSERT INTO efra_validation.audit(actor,action,resource,detail) VALUES (actor,'REPORT_READ',dataset_key,ticket::text);
  RETURN result;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA efra_validation FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA efra_validation FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_validation.observe_release(text), efra_validation.canonical_proofs(text),
  efra_validation.seal(text,text,text,jsonb)
  TO efra_validation_custodian;
GRANT EXECUTE ON FUNCTION efra_validation.request_development(text,text) TO efra_validation_researcher;
GRANT EXECUTE ON FUNCTION efra_validation.review_manifest(text), efra_validation.approve(text,text,text),
  efra_validation.request_report(text) TO efra_validation_approver;
GRANT EXECUTE ON FUNCTION efra_validation.read_development(uuid,text), efra_validation.claim_evaluation(text,uuid,text),
  efra_validation.read_evaluation(uuid),
  efra_validation.record_report(text,uuid,jsonb), efra_validation.read_report(uuid,text) TO efra_validation_worker;
