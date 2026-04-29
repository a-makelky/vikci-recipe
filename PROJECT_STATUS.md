# Vicki Recipe Archive Project Status

Last updated: 2026-04-29

## What This Project Is

This repo turns physical recipe cards into a searchable static website. The intended pipeline is:

1. Take photos or scans of recipe cards.
2. Keep raw scans outside the repo, currently in iCloud Drive or another storage folder.
3. Run the local recipe CLI to OCR, structure, review, and publish recipes.
4. Build the Astro site and Pagefind search index.
5. Deploy the generated static site.

The only step that should stay manual is photographing/scanning the physical cards.

## Current Working Copy

Use this repo path for active work:

```text
/Users/aaronmakelky/code/vicki-recipe
```

Do not use the old iCloud repo folder as the active checkout. iCloud created a duplicate Git index file in that copy, and Astro/Git commands were prone to hanging there. Raw scans can still live in iCloud; the code repo should not.

GitHub repo:

```text
https://github.com/a-makelky/vicki-recipe
```

The repo is public by design. The plan is to open-source it after the private working workflow and site are reliable.

## Current Archive State

As of this checkpoint, local staging artifacts, public recipe pages, and published scan folders line up:

- Staged artifacts: 9
- Published recipe pages: 9
- Published scan folders: 9
- Approved but unpublished artifacts: 0
- Stale published artifacts: 0
- Review queue items: 0

The two demo recipes were removed from the live content so the public archive reflects real ingested cards only.

## Runtime

Use Node 22 LTS. The repo now includes:

- `.nvmrc`
- `.node-version`
- `package.json` engine range: Node `>=22 <25`
- Astro 6 with the Content Layer API
- Zod 4 for shared recipe validation

On this machine, commands were verified with:

```text
npx -y -p node@22 -p npm@10 -c 'npm run ...'
```

That avoids relying on the global Node 25 install.

## Last Verified Health Check

The stabilized checkout passed these checks on 2026-04-29:

- `npm test`: 28 tests passed
- `npm run recipes -- verify`: 0 errors, 0 warnings
- `npm run recipes -- status --json`: 9 artifacts, 9 public recipes, 9 published scan folders
- `npm run check`: 0 errors
- `npm run build`: 10 static pages built, Pagefind indexed 9 recipe pages
- `npm audit --audit-level=moderate`: 0 vulnerabilities
- Published JPEG scan files: EXIF/iPhone metadata stripped before Git commit

## Health Commands

Codex should run these, not the user:

```bash
npm test
npm run recipes -- status
npm run recipes -- verify
npm run check
npm run build
```

What each one proves:

- `npm test`: unit-level pipeline behavior still works.
- `npm run recipes -- status`: counts artifacts, review items, published state, and OCR breakdowns.
- `npm run recipes -- verify`: catches drift between staged artifacts, recipe pages, scan folders, scan asset files, and original source paths.
- `npm run check`: Astro/TypeScript validation.
- `npm run build`: production Astro build plus Pagefind index.

## Next Work

Before photographing the whole collection, do a pilot batch:

1. Pick 15-25 cards.
2. Include easy cards, messy handwriting, at least a few double-sided cards, and any weird formats.
3. Photograph one card per image in good light.
4. Name double-sided cards like `recipe-0001-front.jpg` and `recipe-0001-back.jpg`.
5. Run ingest and review on that pilot.
6. Tune OCR, pairing, and review rules before scaling to the full box.

## Known Follow-Ups

- Add automatic HEIC conversion so iPhone capture does not depend on camera settings.
- Improve front/back pairing for real-world filenames like sequential `IMG_1234.JPG` and `IMG_1235.JPG`.
- Decide long-term scan storage before hundreds of original-resolution images accumulate in Git.
- Build a friendlier review UI so humans do not have to edit JSON or use command flags.
