import { positionMetricRegistry } from "../src/models/positions/metric-registry.ts";

const { metrics, rules, version } = positionMetricRegistry();
const json = (entries) => entries.map((entry) => JSON.stringify(entry)).join(",\n");

process.stdout.write(
  `-- Generated from the TypeScript position contracts. Registry version: ${version}.\n` +
  "-- Verify with npm run --silent registry:sql. Introduce changes through a new migration.\n" +
  "INSERT INTO efra_ingest.metric_registry\n" +
  "SELECT position, field, code, unit, domain, tiers, roles, source_capability, storage, definition_version\n" +
  "FROM jsonb_to_recordset($registry$[\n" +
  json(metrics.map(({ sourceCapability, definitionVersion, ...metric }) => ({
    ...metric, source_capability: sourceCapability, definition_version: definitionVersion,
  }))) +
  "\n]$registry$::jsonb) AS m(position text, field text, code text, unit text, domain text, tiers text[],\n" +
  "  roles text[], source_capability text, storage text, definition_version text);\n\n" +
  "INSERT INTO efra_ingest.metric_rule\nSELECT position, upper_field, fields, kind\n" +
  "FROM jsonb_to_recordset($rules$[\n" +
  json(rules.map(({ upper, ...rule }) => ({ ...rule, upper_field: upper }))) +
  "\n]$rules$::jsonb) AS r(position text, upper_field text, fields text[], kind text);\n",
);
