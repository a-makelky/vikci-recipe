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
npm run recipes -- show --id batch-01-recipe-0001-xxxxxxxx --ocr
npm run recipes -- update --id batch-01-recipe-0001-xxxxxxxx --ingredients "2 cups flour|1 cup sugar|2 eggs" --review-reasons "Cleaned OCR list"
npm run recipes -- status
```

4. Open the staged JSON artifact, make manual corrections if needed, then approve it:

```bash
npm run recipes -- approve --id batch-01-recipe-0001-xxxxxxxx
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
npm run recipes -- ingest --input /path/to/scans [--stage-only] [--with-google-fallback] [--report ./batch-report.json]
npm run recipes -- review
npm run recipes -- show --id recipe-...
npm run recipes -- update --id recipe-... [--title "..."] [--ingredients "a|b|c"] [--publish]
npm run recipes -- status
npm run recipes -- approve --id recipe-...
npm run recipes -- publish --id recipe-...
```

### Command behavior

- `ingest`
  - OCRs all supported files under the input path
  - writes a staged artifact per scan
  - auto-publishes recipes unless they need review or `--stage-only` is set
- `review`
  - lists staged recipes that still need correction
- `show`
  - prints one staged artifact, including ingredients, instructions, and optional OCR text
- `update`
  - patches a staged artifact from CLI flags and can optionally re-publish the approved recipe
- `status`
  - shows counts for approved recipes, staged artifacts, review queue items, and published scan sets
- `approve`
  - marks a staged artifact approved and publishes it
- `publish`
  - refreshes the public recipe markdown and scan assets from an approved artifact

## Artifact IDs

- Artifact IDs are derived from the relative scan path, not just the filename.
- This prevents collisions when different batches contain files like `recipe-0001.pdf`.
- Example pattern: `batch-01-recipe-0001-1a2b3c4d`

## Review editing helpers

- Use `|` between ingredient, instruction, note, or review-reason entries.
- Use `,` or `|` between tags and proteins.
- Example:

```bash
npm run recipes -- update \
  --id batch-01-recipe-0001-1a2b3c4d \
  --title "Sunday Dinner Rolls" \
  --ingredients "2 cups warm milk|1/2 cup sugar|2 packets yeast|5 to 6 cups flour" \
  --instructions "Dissolve yeast in warm milk.|Mix in the rest and knead.|Let rise twice, then bake." \
  --review-status approved \
  --publish
```

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
