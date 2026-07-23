# WSSP Tracker

A PBK tool for tracking [Washington Sustainable Schools Protocol (WSSP)](https://ospi.k12.wa.us/)
compliance on school construction projects. Public school district construction
projects receiving state capital funds are required by RCW 39.35D.040 to comply
with LEED Silver or the WSSP; this tool tracks the WSSP path — credits, points,
required prerequisites, and certification thresholds — per project.

## Current features (skeleton)

- **Projects** — create a project with general information (name, project
  number, address, school district, district class, contact, D phase) and
  select the **WSSP edition** it certifies under (2018 or 2023).
- **Edition-aware scorecards** — the full credit structure of both the
  WSSP 2018 and WSSP 2023 editions is encoded in `config/protocols/`,
  including categories, credit groups, point ranges, and required credits.
- **Live scoring** — mark each credit Yes / Maybe / No (with point selection
  for variable-point credits) and see live totals per category and against
  the project's certification threshold, which is computed from project type
  (new / new building on existing / modernization) and district class
  (Class I ≥ 2,000 FTE, Class II below).

The visual design follows the shared PBK design system (Barlow Semi
Condensed + Source Sans 3, navy/red brand palette, white cards on a pale
blue-gray page) used by the FOCUS Map and PNW Strategic Plan tools. Fonts
are bundled in `public/vendor/fonts`, so the tool needs no internet access.

## Planned

- Client / consultant / contractor access with per-project roles
- Supporting documentation uploads per credit
- OSPI credit interpretation library surfaced on credit pages
- OSPI-ready compliance report export

## Running it

Requires [Node.js](https://nodejs.org) 20+.

```
npm install
npm start
```

Then open `http://localhost:3000`. Set `PORT` to use a different port, and
`APPDATA_DIR` to store project data somewhere other than the app's own
`data/` folder (which is git-ignored — the repository holds only code and
protocol definitions, never project data).

## Reference documents

- `wssp-2018-final.pdf` — the WSSP 2018 Edition handbook (OSPI), the source
  for `config/protocols/wssp-2018.json`.
- `config/protocols/wssp-2023.json` was encoded from the official OSPI
  WSSP 2023 scorecard workbook.
