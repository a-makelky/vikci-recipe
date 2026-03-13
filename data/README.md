# Data Layout

- Raw scans live outside this repo in iCloud or Drive and are referenced during ingest.
- `data/staging/artifacts/` stores OCR + structured extraction artifacts before approval.
- `data/staging/review/` stores copies of artifacts that need human correction.
- `src/content/recipes/` stores the approved public recipe records.
- `public/scans/` stores publishable derivatives that the site can serve.
