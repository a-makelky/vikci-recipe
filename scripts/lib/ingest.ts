import type { StagedRecipe } from "../../src/lib/recipe-schema";
import { isArtifactPublishCurrent } from "./publish";

export interface ExistingArtifactDecision {
  skip: boolean;
  reason: string;
}

export function decideExistingArtifactAction(
  artifact: StagedRecipe,
  reprocessExisting: boolean
): ExistingArtifactDecision {
  if (reprocessExisting) {
    return {
      skip: false,
      reason: "Reprocessing requested with --reprocess-existing."
    };
  }

  if (artifact.review.status === "needs_review") {
    return {
      skip: true,
      reason: "Artifact already exists in the review queue."
    };
  }

  if (artifact.publication.is_published && isArtifactPublishCurrent(artifact)) {
    return {
      skip: true,
      reason: "Artifact is already published and current."
    };
  }

  if (artifact.publication.is_published) {
    return {
      skip: true,
      reason: "Artifact already exists and has a stale published copy. Use republish-stale or --reprocess-existing."
    };
  }

  return {
    skip: true,
    reason: "Artifact already exists. Use --reprocess-existing to rebuild it from the source scans."
  };
}
