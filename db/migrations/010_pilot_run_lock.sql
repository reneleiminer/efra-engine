-- A pilot run is independently locked before any test access.
CREATE TABLE efra_validation.pilot_run (
  dataset_id text PRIMARY KEY REFERENCES efra_validation.approval,
  run_id uuid NOT NULL UNIQUE,
  dataset_sha256 text NOT NULL CHECK (dataset_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  report_key_id text NOT NULL CHECK (report_key_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'),
  approver text NOT NULL REFERENCES efra_validation.principal(subject),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_validation.pilot_run
  FOR EACH STATEMENT EXECUTE FUNCTION efra_ingest.reject_mutation();
REVOKE ALL ON efra_validation.pilot_run FROM PUBLIC;

CREATE FUNCTION efra_validation.register_pilot_run(dataset_key text, run uuid, dataset_hash text, manifest_hash text, report_key text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  actor text := efra_validation.subject('approver');
  prior efra_validation.pilot_run%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(716184, 13);
  IF NOT EXISTS (SELECT FROM efra_validation.approval a WHERE a.dataset_id = dataset_key AND a.sha256 = dataset_hash
    AND a.approver = actor AND a.xid <> pg_current_xact_id())
  THEN RAISE EXCEPTION 'Committed approval from this approver is required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO prior FROM efra_validation.pilot_run p WHERE p.dataset_id = dataset_key;
  IF FOUND THEN
    IF (prior.run_id,prior.dataset_sha256,prior.manifest_sha256,prior.report_key_id,prior.approver)
      = (run,dataset_hash,manifest_hash,report_key,actor) THEN RETURN 'ALREADY_REGISTERED'; END IF;
    RAISE EXCEPTION 'Pilot run already locked' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT FROM efra_validation.evaluation e WHERE e.dataset_id = dataset_key)
  THEN RAISE EXCEPTION 'Pilot lock must precede evaluation' USING ERRCODE = '23514'; END IF;
  INSERT INTO efra_validation.pilot_run(dataset_id,run_id,dataset_sha256,manifest_sha256,report_key_id,approver)
    VALUES (dataset_key,run,dataset_hash,manifest_hash,report_key,actor);
  RETURN 'REGISTERED';
END;
$$;

ALTER FUNCTION efra_validation.claim_evaluation(text,uuid,text) RENAME TO claim_evaluation_internal;
REVOKE EXECUTE ON FUNCTION efra_validation.claim_evaluation_internal(text,uuid,text) FROM efra_validation_worker;

CREATE FUNCTION efra_validation.claim_evaluation(dataset_key text, run uuid, engine_digest text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM efra_validation.subject('worker');
  PERFORM pg_advisory_xact_lock(716184, 13);
  IF EXISTS (SELECT FROM efra_validation.pilot_run p WHERE p.dataset_id = dataset_key)
  THEN RAISE EXCEPTION 'Pilot dataset requires the locked manifest' USING ERRCODE = '42501'; END IF;
  RETURN efra_validation.claim_evaluation_internal(dataset_key,run,engine_digest);
END;
$$;

CREATE FUNCTION efra_validation.claim_pilot_evaluation(
  dataset_key text, run uuid, engine_digest text, dataset_hash text, manifest_hash text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM efra_validation.subject('worker');
  PERFORM pg_advisory_xact_lock(716184, 13);
  IF NOT EXISTS (SELECT FROM efra_validation.pilot_run p WHERE
    (p.dataset_id,p.run_id,p.dataset_sha256,p.manifest_sha256) = (dataset_key,run,dataset_hash,manifest_hash))
  THEN RAISE EXCEPTION 'No matching locked pilot run' USING ERRCODE = '42501'; END IF;
  RETURN efra_validation.claim_evaluation_internal(dataset_key,run,engine_digest);
END;
$$;

CREATE FUNCTION efra_validation.require_pilot_report_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE locked efra_validation.pilot_run%ROWTYPE;
BEGIN
  SELECT * INTO locked FROM efra_validation.pilot_run p WHERE p.dataset_id = NEW.dataset_id;
  IF FOUND AND (NEW.payload#>>'{pilot,body,version}' IS DISTINCT FROM 'efra-pilot-report-v1'
    OR NEW.payload#>>'{pilot,body,runManifestSha256}' IS DISTINCT FROM locked.manifest_sha256
    OR NEW.payload#>>'{pilot,keyId}' IS DISTINCT FROM locked.report_key_id
    OR coalesce(NEW.payload#>>'{pilot,body,reportSha256}','') !~ '^[a-f0-9]{64}$'
    OR coalesce(NEW.payload#>>'{pilot,signature}','') !~ '^[A-Za-z0-9_-]{86}$')
  THEN RAISE EXCEPTION 'Pilot report requires a bound signature envelope' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_pilot_report_binding BEFORE INSERT ON efra_validation.report
  FOR EACH ROW EXECUTE FUNCTION efra_validation.require_pilot_report_binding();

ALTER FUNCTION efra_validation.read_report(uuid,text) RENAME TO read_report_internal;
REVOKE EXECUTE ON FUNCTION efra_validation.read_report_internal(uuid,text) FROM efra_validation_worker;

CREATE FUNCTION efra_validation.read_report(ticket uuid, recipient text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM efra_validation.subject('worker');
  IF EXISTS (SELECT FROM efra_validation.development_ticket t JOIN efra_validation.pilot_run p ON p.dataset_id = t.dataset_id
    WHERE t.id = ticket)
  THEN RAISE EXCEPTION 'Pilot report requires the locked manifest' USING ERRCODE = '42501'; END IF;
  RETURN efra_validation.read_report_internal(ticket,recipient);
END;
$$;

CREATE FUNCTION efra_validation.read_pilot_report(ticket uuid, recipient text, dataset_key text, run uuid, manifest_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM efra_validation.subject('worker');
  IF NOT EXISTS (SELECT FROM efra_validation.development_ticket t JOIN efra_validation.pilot_run p ON p.dataset_id = t.dataset_id
    WHERE t.id = ticket AND t.researcher = recipient AND (p.dataset_id,p.run_id,p.manifest_sha256) = (dataset_key,run,manifest_hash))
  THEN RAISE EXCEPTION 'Pilot report ticket does not match the locked manifest' USING ERRCODE = '42501'; END IF;
  RETURN efra_validation.read_report_internal(ticket,recipient);
END;
$$;

REVOKE ALL ON FUNCTION efra_validation.register_pilot_run(text,uuid,text,text,text),
  efra_validation.claim_evaluation(text,uuid,text), efra_validation.claim_pilot_evaluation(text,uuid,text,text,text),
  efra_validation.require_pilot_report_binding(), efra_validation.read_report(uuid,text),
  efra_validation.read_pilot_report(uuid,text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION efra_validation.register_pilot_run(text,uuid,text,text,text) TO efra_validation_approver;
GRANT EXECUTE ON FUNCTION efra_validation.claim_evaluation(text,uuid,text),
  efra_validation.claim_pilot_evaluation(text,uuid,text,text,text), efra_validation.read_report(uuid,text),
  efra_validation.read_pilot_report(uuid,text,text,uuid,text) TO efra_validation_worker;
