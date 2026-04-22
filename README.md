# People Database — RTL Hebrew Web App

A small single-page web app for editing and viewing information pages about
people. The UI is right-to-left, with Hebrew labels; every textual field has
side-by-side Hebrew and English inputs plus an optional comments column.

## Running

```bash
python3 server.py
```

The server listens on `http://127.0.0.1:8765` by default. Set a different port
with `PORT=9000 python3 server.py`. There are no external dependencies — only
Python 3's standard library.

## Files

- `server.py` — HTTP server (built on `http.server`). Serves static assets,
  exposes a small JSON API, and stores all data on disk.
- `index.html` — markup only; pulls in `styles.css` and `app.js`.
- `styles.css` — all styling.
- `app.js` — all UI logic (list view, person editor, version switcher, etc.).
- `data/<technical_id>/` — created on first save; holds one `data.json` and any
  uploaded photo files for that person.

## Data layout

Each person is stored at `data/<technical_id>/data.json` with this shape:

```json
{
  "technical_id": "rachel",
  "versions": [
    {
      "version": 1,
      "saved_at": "2026-04-16T10:00:00",
      "data": { "first_name": { "he": "רחל", "en": "Rachel" }, ... }
    },
    { "version": 2, "saved_at": "...", "data": { ... } }
  ]
}
```

Every save appends a new entry to the `versions` array — old data is never
deleted. Empty fields are pruned out of `data` so the JSON stays compact.

Photos are saved as files (never as data URLs in the JSON):
`data/<technical_id>/photo_v<N>_<i>.<ext>`. Each version's `data.photos` is an
array of `{ "file": "...", "comment": "..." }` entries pointing at those files.
Carrying a photo across versions reuses its existing filename, so disk usage
stays modest.

## Fields

Names: first name (always shown), last name (always shown), and a set of
optional name fields (maiden, additional last, former last, Hebrew, nickname,
alternate spellings) that are collapsed by default and expand when their
checkbox is ticked.

Family: father, mother, siblings, spouses, children. Each entry can be either
free text (Hebrew + English) or a clickable link to another person in the
database.

Life events: birth date (with a "year only" toggle) and birth place. A
`deceased` checkbox; when checked, the death date, death place, and burial
place fields appear.

Addresses, free text, and a photo gallery in the left-hand panel. The free
text panel is rendered full-width below the rest, with Hebrew + English only
(no comments column).

## Versions

The top of the person page shows the technical id, the current version
number, the version's save timestamp, and a dropdown to switch to any earlier
version. Viewing an old version is read-only; a "restore as new version"
button loads its values into the editor so that the next save creates a fresh
version with that content.

A new person is only persisted when the first save happens — there is no
empty placeholder version 1.
