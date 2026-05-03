# Data Layout

- Raw scans live outside this repo in iCloud or Drive and are referenced during ingest.
- `data/staging/artifacts/` stores OCR + structured extraction artifacts before approval.
- `data/staging/review/` stores copies of artifacts that need human correction.
- `src/content/recipes/` stores the approved public recipe records.
- `public/scans/` stores publishable derivatives that the site can serve.

## Pilot Batch Triage

- Re-run `ingest` on the original scan folder without `--reprocess-existing` when a parser fix lands. It skips current artifacts and only revisits files that never staged.
- Treat one-step appetizer cards as publishable when the title, ingredients, OCR length, and confidence are otherwise solid.
- Keep generic titles like `Dip` or `Appetizers` in review until they get a descriptive title plus a note that the original card title was generic.
- Split multi-recipe cards before approval. The current card should not keep ingredients or instructions from the second recipe.
- Do not keep retrying blank, cropped, or partial-card photos. Stage whatever OCR can be recovered, then rescan the card in full frame or pair front/back images with matching `-front` and `-back` names.
