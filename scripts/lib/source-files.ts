import path from "node:path";

export type ScanSide = "front" | "back";

export interface ScanFileGroup {
  primaryPath: string;
  filePaths: string[];
}

const SIDE_SUFFIX_PATTERN = /^(.*?)(?:[-_\s]+)(front|back)$/i;

export function stripScanSideSuffix(stem: string): string {
  const match = stem.match(SIDE_SUFFIX_PATTERN);
  return match?.[1] ? match[1] : stem;
}

export function detectScanSide(filePath: string): ScanSide | undefined {
  const extension = path.extname(filePath);
  const stem = path.basename(filePath, extension);
  const match = stem.match(SIDE_SUFFIX_PATTERN);
  const side = match?.[2]?.toLowerCase();
  return side === "front" || side === "back" ? side : undefined;
}

export function getPairedScanKey(filePath: string): string | null {
  const extension = path.extname(filePath);
  const stem = path.basename(filePath, extension);
  const baseStem = stripScanSideSuffix(stem);
  if (baseStem === stem) {
    return null;
  }

  return path.join(path.dirname(filePath), baseStem).toLowerCase();
}

export function groupPairedScanFiles(filePaths: string[]): ScanFileGroup[] {
  const grouped = new Map<string, string[]>();

  for (const filePath of [...filePaths].sort()) {
    const key = getPairedScanKey(filePath) || filePath;
    const bucket = grouped.get(key) ?? [];
    bucket.push(filePath);
    grouped.set(key, bucket);
  }

  return [...grouped.values()]
    .map((group) => {
      const sortedGroup = [...group].sort(compareGroupedScanFiles);
      return {
        primaryPath: sortedGroup[0] ?? group[0]!,
        filePaths: sortedGroup
      };
    })
    .sort((left, right) => left.primaryPath.localeCompare(right.primaryPath));
}

export function getScanSideLabel(filePath: string, index: number, total: number): string {
  if (total === 1) {
    return "scan";
  }

  const side = detectScanSide(filePath);
  if (side === "front") {
    return "front";
  }
  if (side === "back") {
    return "back";
  }

  return `scan-${index + 1}`;
}

function compareGroupedScanFiles(left: string, right: string): number {
  const leftSide = getScanSideSortRank(detectScanSide(left));
  const rightSide = getScanSideSortRank(detectScanSide(right));
  if (leftSide !== rightSide) {
    return leftSide - rightSide;
  }

  return left.localeCompare(right);
}

function getScanSideSortRank(side: ScanSide | undefined): number {
  switch (side) {
    case "front":
      return 0;
    case "back":
      return 1;
    default:
      return 2;
  }
}
