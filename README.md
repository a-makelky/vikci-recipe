# Vicki's Recipe Archive

A static, Git-backed archive for handwritten and printed recipe cards.

## What this repo does

- Publishes approved recipes as a static Astro site that can deploy on Netlify.
- Indexes built pages with Pagefind for full-text search.
- Ingests scan batches through a local CLI:
  - OCR with `GLM-OCR`
  - structured extraction into a typed recipe schema
  - low-confidence review queue
  - publish approved recipes and scan assets into the site

## Repo structure

- `src/content/recipes/`: approved public recipes
- `public/scans/`: published scan previews and originals
- `data/staging/artifacts/`: local OCR artifacts before approval
- `data/staging/review/`: local review queue copies
- `scripts/recipes.ts`: ingest, review, approve, and publish CLI

Raw scans should stay outside the repo in iCloud Drive or Google Drive. Point the CLI at that folder with `RAW_SCAN_DIR` or `--input`.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in `ZAI_API_KEY`.
3. Optionally add Google Vision credentials for fallback OCR.
4. Install dependencies:

```bash
npm install
```

## Typical workflow

1. Scan each card as a PDF or image from iPhone into your raw scan folder.
2. Ingest a batch:

```bash
npm run recipes -- ingest --input "/absolute/path/to/Vickis-Recipes/raw/2026-03-batch-01"
```

3. Review anything that was held back:

```bash
npm run recipes -- review
```

4. Open the staged JSON artifact, make manual corrections if needed, then approve it:

```bash
npm run recipes -- approve --id recipe-0001
```

5. Start the site locally:

```bash
npm run dev
```

6. Build the production site and Pagefind index:

```bash
npm run build
```

## CLI commands

```bash
npm run recipes -- ingest --input /path/to/scans [--stage-only] [--with-google-fallback]
npm run recipes -- review
npm run recipes -- approve --id recipe-0001
npm run recipes -- publish --id recipe-0001
```

### Command behavior

- `ingest`
  - OCRs all supported files under the input path
  - writes a staged artifact per scan
  - auto-publishes recipes unless they need review or `--stage-only` is set
- `review`
  - lists staged recipes that still need correction
- `approve`
  - marks a staged artifact approved and publishes it
- `publish`
  - refreshes the public recipe markdown and scan assets from an approved artifact

## OCR notes

- `GLM-OCR` is the primary backend and supports PDFs and images.
- Google Vision fallback currently supports local image files only in this repo.
- PDF preview generation uses macOS `qlmanage` when available.
- Image previews use macOS `sips` when available.

## Deploying

- Connect the repo to Netlify.
- Netlify uses `npm run build` and publishes `dist/`.
- Point your custom domain at the Netlify site after the first successful deploy.

## Pilot checklist

- Ingest a 20-card pilot batch.
- Confirm low-confidence recipes are routed to review.
- Confirm ingredient-only searches work on the built site.
- Confirm filters behave correctly for multi-value tags and proteins.
- Confirm scan previews open the original PDF or image.
