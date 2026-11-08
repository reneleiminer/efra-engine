import type { Position } from "../contracts/statistics.ts";
import { timestamp } from "../contracts/time.ts";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { positionDataAvailabilityMatrix } from "../models/positions/data-requirements.ts";

export const filmLabContractVersion = "efra-film-lab-v1";

export interface FilmEvidenceClip {
  readonly assetId: string;
  readonly assetSha256: string;
  readonly clipSha256: string;
  readonly rightsReference: string;
  readonly rightsStatus: "SYNTHETIC_FIXTURE" | "NOT_CLEARED" | "REVIEW_REQUIRED";
  readonly angle: "SIDELINE" | "END_ZONE" | "BROADCAST" | "OTHER";
  readonly startMs: number;
  readonly endMs: number;
}
export interface FilmSnap {
  readonly competitionId: string;
  readonly seasonId: string;
  readonly gameId: string;
  readonly playId: string;
  readonly snapId: string;
  readonly sequence: number;
  readonly period: number;
  readonly clockRemainingMs: number;
  readonly playedAt: string;
  readonly validity: "COUNTED" | "NO_PLAY" | "UNRESOLVED";
  readonly phase: "SCRIMMAGE" | "KICKOFF" | "PUNT" | "PLACEKICK" | "OTHER";
  readonly down: 1 | 2 | 3 | 4 | null;
  readonly yardsToGo: number | null;
  readonly startFieldYard: number | null;
  readonly clips: readonly FilmEvidenceClip[];
}

export type FilmParticipation =
  | { readonly status: "IDENTIFIED"; readonly playerId: string; readonly teamId: string; readonly position: Position; readonly alignment: string }
  | { readonly status: "UNRESOLVED"; readonly reason: "JERSEY_UNREADABLE" | "OFF_CAMERA" | "ROLE_UNCLEAR" | "CONFLICTING_EVIDENCE" };

type AssignmentKind =
  | { readonly family: "BLOCKING"; readonly role: "PASS_PROTECTION" | "LEAD" | "INLINE_RUN" | "EDGE_RUN"
      | "DRIVE" | "PULL" | "COMBO" | "SECOND_LEVEL" | "OFF_BALL" | "SNAPPER_PROTECTION" }
  | { readonly family: "COVERAGE"; readonly role: "MAN" | "ZONE" | "DEEP" | "SHORT" | "FLAT" | "MIDDLE" | "CROSSING_ROUTE";
      readonly targeted: boolean | null; readonly yardsAllowed: number | null }
  | { readonly family: "PASS_RUSH"; readonly role: "INTERIOR" | "NOSE" | "EDGE" | "INTERIOR_BLITZ" | "OUTSIDE_BLITZ" | "SAFETY_BLITZ";
      readonly pressure: "NONE" | "PRESSURE" | "SACK" | "UNRESOLVED" | null }
  | { readonly family: "RUN_DEFENSE"; readonly role: "FIT" | "ANCHOR" | "TWO_GAP" | "DOUBLE_TEAM_GAP" | "CONTAIN" | "BOOTLEG" | "TACKLE" }
  | { readonly family: "BALL_ACTION"; readonly role: "PASS" | "QB_RUN" | "CARRY" | "TARGET" | "EXCHANGE" | "SITUATIONAL_SACK" }
  | { readonly family: "SPECIAL_TEAMS"; readonly role: "KICK_PLACEMENT" | "ONSIDE_EXECUTION" | "PUNT_OPERATION"
      | "RETURN" | "FAIR_CATCH" | "NO_RETURN" | "LET_GO" | "LONG_SNAP" | "GUNNER_RELEASE" | "GUNNER_COVERAGE";
      readonly durationMs: number | null };
export type FilmAssignment = {
  readonly assignmentId: string;
  readonly evidenceClipSha256: readonly string[];
  readonly notesCode?: string;
} & AssignmentKind & (
  | { readonly opportunity: "ELIGIBLE"; readonly outcome: "SUCCESS" | "FAILURE" | "NEUTRAL" | "UNRESOLVED" }
  | { readonly opportunity: "NOT_APPLICABLE" | "UNRESOLVED"; readonly outcome: null }
);

export interface FilmAnnotation {
  readonly version: typeof filmLabContractVersion;
  readonly origin: "SYNTHETIC" | "REAL";
  readonly protocolVersion: string;
  readonly annotationId: string;
  readonly revision: number;
  readonly previousRevisionSha256?: string;
  readonly correctionReason?: string;
  /** Recorded by the ingestion service from an authenticated principal. */
  readonly annotatorSubject: string;
  readonly submittedAt: string;
  readonly snap: FilmSnap;
  readonly participation: FilmParticipation;
  readonly assignments: readonly FilmAssignment[];
}
export interface FilmReview {
  readonly annotationSha256: string;
  readonly reviewedAt: string;
  readonly decision: "ACCEPTED" | "REJECTED" | "NEEDS_CORRECTION";
  readonly protocolVersion: string;
  readonly reviewReference: string;
}

const positions = positionDataAvailabilityMatrix().positions;
const assignmentRoles: Readonly<Record<AssignmentKind["family"], readonly string[]>> = {
  BLOCKING: ["PASS_PROTECTION", "LEAD", "INLINE_RUN", "EDGE_RUN", "DRIVE", "PULL", "COMBO", "SECOND_LEVEL", "OFF_BALL", "SNAPPER_PROTECTION"],
  COVERAGE: ["MAN", "ZONE", "DEEP", "SHORT", "FLAT", "MIDDLE", "CROSSING_ROUTE"],
  PASS_RUSH: ["INTERIOR", "NOSE", "EDGE", "INTERIOR_BLITZ", "OUTSIDE_BLITZ", "SAFETY_BLITZ"],
  RUN_DEFENSE: ["FIT", "ANCHOR", "TWO_GAP", "DOUBLE_TEAM_GAP", "CONTAIN", "BOOTLEG", "TACKLE"],
  BALL_ACTION: ["PASS", "QB_RUN", "CARRY", "TARGET", "EXCHANGE", "SITUATIONAL_SACK"],
  SPECIAL_TEAMS: ["KICK_PLACEMENT", "ONSIDE_EXECUTION", "PUNT_OPERATION", "RETURN", "FAIR_CATCH", "NO_RETURN", "LET_GO",
    "LONG_SNAP", "GUNNER_RELEASE", "GUNNER_COVERAGE"],
};
const digest = (value: string) => /^[0-9a-f]{64}$/.test(value);
const named = (value: string) => typeof value === "string" && value.trim().length > 0;
const nonnegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;

function requireFilm(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function snapScope(snap: FilmSnap) {
  return [snap.competitionId, snap.seasonId, snap.gameId, snap.playId, snap.snapId];
}

export function assessFilmAnnotation(annotation: FilmAnnotation, options: {
  readonly authenticatedAnnotatorSubject: string;
  readonly previous?: FilmAnnotation;
  readonly independentReview?: { readonly authenticatedReviewerSubject: string; readonly review: FilmReview };
}) {
  const { previous, independentReview } = options;
  const { snap, participation } = annotation;
  requireFilm(annotation.version === filmLabContractVersion && annotation.origin === "SYNTHETIC"
    && [annotation.protocolVersion, annotation.annotationId, annotation.annotatorSubject, ...snapScope(snap)].every(named)
    && annotation.annotatorSubject === options.authenticatedAnnotatorSubject
    && timestamp(snap.playedAt) <= timestamp(annotation.submittedAt)
    && nonnegativeInteger(snap.sequence) && nonnegativeInteger(snap.period) && snap.period > 0
    && nonnegativeInteger(snap.clockRemainingMs)
    && ["COUNTED", "NO_PLAY", "UNRESOLVED"].includes(snap.validity)
    && ["SCRIMMAGE", "KICKOFF", "PUNT", "PLACEKICK", "OTHER"].includes(snap.phase)
    && (snap.down === null || [1, 2, 3, 4].includes(snap.down))
    && (snap.yardsToGo === null || nonnegativeInteger(snap.yardsToGo))
    && (snap.startFieldYard === null || nonnegativeInteger(snap.startFieldYard) && snap.startFieldYard <= 100),
  "Invalid or non-synthetic film annotation");
  requireFilm(Number.isSafeInteger(annotation.revision) && (previous
    ? previous.annotationId === annotation.annotationId && previous.origin === annotation.origin
      && previous.protocolVersion === annotation.protocolVersion && previous.revision + 1 === annotation.revision
      && canonicalSha256(snapScope(previous.snap)) === canonicalSha256(snapScope(snap))
      && annotation.previousRevisionSha256 === canonicalSha256(previous) && !!annotation.correctionReason?.trim()
      && timestamp(previous.submittedAt) < timestamp(annotation.submittedAt)
    : annotation.revision === 1 && annotation.previousRevisionSha256 === undefined && annotation.correctionReason === undefined),
  "Invalid film correction chain");

  const clipIds = new Set(snap.clips.map(({ clipSha256 }) => clipSha256));
  requireFilm(clipIds.size > 0 && clipIds.size === snap.clips.length && snap.clips.every((clip) =>
    named(clip.assetId) && digest(clip.assetSha256) && digest(clip.clipSha256) && named(clip.rightsReference)
    && clip.rightsStatus === "SYNTHETIC_FIXTURE" && ["SIDELINE", "END_ZONE", "BROADCAST", "OTHER"].includes(clip.angle)
    && nonnegativeInteger(clip.startMs) && nonnegativeInteger(clip.endMs) && clip.endMs > clip.startMs), "Missing or unauthorized clip evidence");
  requireFilm(participation.status === "IDENTIFIED" ? named(participation.playerId) && named(participation.teamId)
    && Object.hasOwn(positions, participation.position) && named(participation.alignment)
    : participation.status === "UNRESOLVED" && ["JERSEY_UNREADABLE", "OFF_CAMERA", "ROLE_UNCLEAR", "CONFLICTING_EVIDENCE"].includes(participation.reason),
  "Invalid film participation");

  const assignmentKeys = new Set<string>();
  const ids = new Set<string>();
  let unresolved = snap.validity === "UNRESOLVED" || participation.status === "UNRESOLVED";
  for (const item of annotation.assignments) {
    const key = JSON.stringify([item.family, item.role]);
    requireFilm(Object.hasOwn(assignmentRoles, item.family) && assignmentRoles[item.family].includes(item.role)
      && named(item.assignmentId) && !ids.has(item.assignmentId) && !assignmentKeys.has(key)
      && item.evidenceClipSha256.length > 0 && new Set(item.evidenceClipSha256).size === item.evidenceClipSha256.length
      && item.evidenceClipSha256.every((id) => clipIds.has(id)), "Duplicate assignment or missing clip binding");
    ids.add(item.assignmentId);
    assignmentKeys.add(key);
    requireFilm(item.opportunity === "ELIGIBLE"
      ? snap.validity === "COUNTED" && participation.status === "IDENTIFIED"
        && ["SUCCESS", "FAILURE", "NEUTRAL", "UNRESOLVED"].includes(item.outcome)
      : (item.opportunity === "UNRESOLVED" || item.opportunity === "NOT_APPLICABLE") && item.outcome === null,
    "Ineligible or ambiguous film assignment cannot carry a result");
    if (item.family === "COVERAGE") {
      requireFilm((item.opportunity === "ELIGIBLE" ? typeof item.targeted === "boolean" : item.targeted === null)
        && (item.yardsAllowed === null || item.targeted === true && Number.isSafeInteger(item.yardsAllowed)), "Invalid coverage attribution");
    }
    if (item.family === "PASS_RUSH") {
      requireFilm(item.opportunity === "ELIGIBLE" ? item.pressure !== null
        && ["NONE", "PRESSURE", "SACK", "UNRESOLVED"].includes(item.pressure) : item.pressure === null, "Invalid pressure opportunity");
    }
    if (item.family === "SPECIAL_TEAMS") {
      requireFilm(item.durationMs === null || item.opportunity === "ELIGIBLE" && nonnegativeInteger(item.durationMs), "Invalid film duration");
    }
    unresolved ||= item.opportunity === "UNRESOLVED" || item.outcome === "UNRESOLVED"
      || item.family === "PASS_RUSH" && item.pressure === "UNRESOLVED";
  }

  const annotationSha256 = canonicalSha256(annotation);
  if (independentReview) {
    const { review, authenticatedReviewerSubject } = independentReview;
    requireFilm(named(authenticatedReviewerSubject) && authenticatedReviewerSubject !== annotation.annotatorSubject
      && review.annotationSha256 === annotationSha256 && review.protocolVersion === annotation.protocolVersion
      && timestamp(annotation.submittedAt) <= timestamp(review.reviewedAt) && named(review.reviewReference)
      && ["ACCEPTED", "REJECTED", "NEEDS_CORRECTION"].includes(review.decision),
    "Invalid or non-independent film review");
  }
  const decision = independentReview?.review.decision;
  const status = decision === "REJECTED" ? "REJECTED" : snap.validity === "NO_PLAY" ? "NOT_COUNTED" : unresolved ? "UNRESOLVED"
    : decision === "ACCEPTED" ? "SYNTHETIC_REVIEW_ACCEPTED" : decision === "NEEDS_CORRECTION" ? "NEEDS_CORRECTION" : "NEEDS_REVIEW";
  return {
    label: "SIMULATION" as const, annotationSha256, status,
    eligibleForCanonicalImport: false as const,
  };
}
