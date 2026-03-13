import path from "node:path";

import { CARD_TYPE_VALUES, OCR_CONFIDENCE_VALUES, type StagedRecipe } from "../../src/lib/recipe-schema";
import { isArtifactPublishCurrent } from "./publish";

type CountMap<T extends string> = Record<T, number>;

export type StatusSummary = {
  scope: {
    batch_filter?: string;
    artifact_count: number;
  };
  counts: {
    approved_recipes_on_site?: number;
    published_scan_sets_on_disk?: number;
    approved_artifacts: number;
    published_current: number;
    approved_unpublished: number;
    published_stale: number;
    needs_review: number;
    review_queue_copies: number;
  };
  breakdowns: {
    ocr_confidence: CountMap<(typeof OCR_CONFIDENCE_VALUES)[number]>;
    card_type: CountMap<(typeof CARD_TYPE_VALUES)[number]>;
    batches: Record<string, number>;
  };
  top_review_reasons: Array<{
    reason: string;
    count: number;
  }>;
};

export function deriveBatchKey(inputPath: string): string {
  const batchKey = path.basename(path.dirname(inputPath));
  return batchKey || "root";
}

export function filterArtifactsByBatch(artifacts: StagedRecipe[], batchFilter?: string): StagedRecipe[] {
  if (!batchFilter) {
    return artifacts;
  }

  const normalizedFilter = batchFilter.trim().toLowerCase();
  if (!normalizedFilter) {
    return artifacts;
  }

  return artifacts.filter((artifact) => {
    const batchKey = deriveBatchKey(artifact.source.input_path).toLowerCase();
    const normalizedPath = artifact.source.input_path.toLowerCase();
    return batchKey === normalizedFilter || normalizedPath.includes(normalizedFilter);
  });
}

export function summarizeArtifacts(
  stagedArtifacts: StagedRecipe[],
  reviewQueueCount: number,
  siteCounts?: {
    approvedRecipesOnSite: number;
    publishedScanSetsOnDisk: number;
  },
  batchFilter?: string
): StatusSummary {
  const confidence = createCountMap(OCR_CONFIDENCE_VALUES);
  const cardTypes = createCountMap(CARD_TYPE_VALUES);
  const batches: Record<string, number> = {};
  const reviewReasonCounts = new Map<string, number>();

  let approvedArtifacts = 0;
  let publishedCurrent = 0;
  let approvedUnpublished = 0;
  let publishedStale = 0;
  let needsReview = 0;

  for (const artifact of stagedArtifacts) {
    confidence[artifact.recipe.ocr_confidence] += 1;
    cardTypes[artifact.recipe.card_type] += 1;

    const batchKey = deriveBatchKey(artifact.source.input_path);
    batches[batchKey] = (batches[batchKey] ?? 0) + 1;

    if (artifact.review.status === "approved") {
      approvedArtifacts += 1;
      if (artifact.publication.is_published) {
        if (isArtifactPublishCurrent(artifact)) {
          publishedCurrent += 1;
        } else {
          publishedStale += 1;
        }
      } else {
        approvedUnpublished += 1;
      }
      continue;
    }

    needsReview += 1;
    for (const reason of artifact.review.reasons) {
      reviewReasonCounts.set(reason, (reviewReasonCounts.get(reason) ?? 0) + 1);
    }
  }

  const topReviewReasons = [...reviewReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));

  return {
    scope: {
      batch_filter: batchFilter,
      artifact_count: stagedArtifacts.length
    },
    counts: {
      approved_recipes_on_site: siteCounts?.approvedRecipesOnSite,
      published_scan_sets_on_disk: siteCounts?.publishedScanSetsOnDisk,
      approved_artifacts: approvedArtifacts,
      published_current: publishedCurrent,
      approved_unpublished: approvedUnpublished,
      published_stale: publishedStale,
      needs_review: needsReview,
      review_queue_copies: reviewQueueCount
    },
    breakdowns: {
      ocr_confidence: confidence,
      card_type: cardTypes,
      batches: sortRecordByKey(batches)
    },
    top_review_reasons: topReviewReasons
  };
}

export function formatStatusSummary(summary: StatusSummary): string {
  const lines = [
    "Recipe archive status",
    `- Scope: ${summary.scope.batch_filter ? `batch filter "${summary.scope.batch_filter}"` : "all artifacts"}`,
    `- Matching artifacts: ${summary.scope.artifact_count}`,
    `- Approved artifacts: ${summary.counts.approved_artifacts}`,
    `- Published current: ${summary.counts.published_current}`,
    `- Approved but unpublished: ${summary.counts.approved_unpublished}`,
    `- Published stale: ${summary.counts.published_stale}`,
    `- Needs review: ${summary.counts.needs_review}`,
    `- Review queue copies: ${summary.counts.review_queue_copies}`
  ];

  if (summary.counts.approved_recipes_on_site !== undefined) {
    lines.splice(2, 0, `- Approved recipes on site: ${summary.counts.approved_recipes_on_site}`);
  }

  if (summary.counts.published_scan_sets_on_disk !== undefined) {
    lines.push(`- Published scan sets on disk: ${summary.counts.published_scan_sets_on_disk}`);
  }

  lines.push(
    `- OCR confidence: ${formatCountRecord(summary.breakdowns.ocr_confidence)}`,
    `- Card types: ${formatCountRecord(summary.breakdowns.card_type)}`
  );

  if (!summary.scope.batch_filter && Object.keys(summary.breakdowns.batches).length > 0) {
    lines.push(`- Batches: ${formatCountRecord(summary.breakdowns.batches)}`);
  }

  if (summary.top_review_reasons.length > 0) {
    lines.push("- Top review reasons:");
    for (const entry of summary.top_review_reasons.slice(0, 5)) {
      lines.push(`  - ${entry.reason} (${entry.count})`);
    }
  }

  return lines.join("\n");
}

function createCountMap<T extends string>(values: readonly T[]): CountMap<T> {
  return values.reduce<CountMap<T>>((result, value) => {
    result[value] = 0;
    return result;
  }, {} as CountMap<T>);
}

function formatCountRecord(values: Record<string, number>): string {
  return Object.entries(values)
    .filter(([, count]) => count > 0)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, count]) => `${key} ${count}`)
    .join(", ") || "none";
}

function sortRecordByKey(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
}
