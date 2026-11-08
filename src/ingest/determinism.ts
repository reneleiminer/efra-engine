import { createHash } from "node:crypto";
import { compareId } from "../season/scope.ts";
import type { ImportRowDecision } from "./contracts.ts";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => compareId(left, right)));
  });
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function compareImportDecisions(left: ImportRowDecision, right: ImportRowDecision): number {
  return compareId(left.sourceRecordId, right.sourceRecordId)
    || compareId(left.issues.join(","), right.issues.join(","))
    || compareId(canonicalJson(left), canonicalJson(right));
}
