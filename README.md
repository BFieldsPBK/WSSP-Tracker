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
- **Supporting documentation per credit** — upload compliance evidence
  (agreements, calculations, submittals; up to 25 MB per file) directly on
  each credit via the paperclip button, with download and remove. Files are
  stored in the `data/files` folder and are kept even if a credit's
  Yes/Maybe/No status is cleared.
- **Credit detail panels** — each credit's panel also shows the requirement
  text auto-extracted from the WSSP handbooks for both editions
  (`config/handbook/wssp-2018-excerpts.json` and
  `wssp-2023-excerpts.json`), any OSPI credit interpretations that apply
  (a "CIL" badge marks affected credits), and a free-text project note per
  credit.
- **OSPI Credit Interpretation Library** — all rulings encoded in
  `config/interpretations.json`, browsable from the header nav and surfaced
  inline on the credits they affect in both editions.
- **Four-state scoring** — credits are marked Yes / Maybe Yes / Maybe No /
  No (matching PBK's integrated design workshop scorecards); Yes and Maybe
  Yes carry claimed points, with flags marking Maybe rows. Point dropdowns
  offer only each credit's legal values, alternate compliance pathways
  (E1.1/E1.2/E1.3) are mutually exclusive with unselected alternates
  grayed out, and the server validates credit ids, point values, and
  exclusivity on every write. Required credits support OSPI exemption
  notations (E / V / EX, deemed compliant) and Table 1 not-applicable
  flags on reduced-scope projects; a required credit marked No is flagged
  on the scorecard and blocks a clean export. Categories open collapsed
  with per-state counts in each header.
- **Project dashboard** — a print-ready gauge dashboard per project
  (visible to staff and invited collaborators): overall points gauge with
  the certification minimum marked, an EUI gauge (baseline vs projected
  with WSSP CBPS target, AIA 2030, and Net Zero markers — the WSSP target
  comes from the 2023 handbook's E1.2 tables keyed by climate zone, school
  level, and operating hours entered in project details), and a points
  donut per category.
- **OSPI export report** — the "Export Report" button on a project renders a
  print-optimized report mirroring the official scorecard layout (header
  fields, per-category credit tables with Yes/Maybe/No and claimed points,
  category totals, grand total, and the two-tier minimum table with the
  project's applicable threshold highlighted), plus a supporting
  documentation index and credit notes. "Print / Save as PDF" uses the
  browser's print dialog (enable "Background graphics").

The visual design follows the shared PBK design system (Barlow Semi
Condensed + Source Sans 3, navy/red brand palette, white cards on a pale
blue-gray page) used by the FOCUS Map and PNW Strategic Plan tools. Fonts
are bundled in `public/vendor/fonts`, so the tool needs no internet access.

## Sign-in and permissions

Two kinds of user:

- **PBK staff** — full access: view, create, and edit projects, manage
  invitations, export reports, delete. When deployed to Azure App Service
  with Easy Auth (the FOCUS Map pattern), staff sign in with **Microsoft
  SSO** automatically — the server reads the same `X-MS-CLIENT-PRINCIPAL`
  headers. Anywhere else (Codespaces, office machine), staff sign in with
  the **staff access code**, which is printed in the server console at
  startup, stored in `data/staff-access-code`, and overridable with the
  `STAFF_ACCESS_CODE` environment variable.
- **Invited collaborators (guests)** — consultants, clients, contractors.
  Staff open a project → **Share** → enter an email → the tool generates
  an **account-setup link** (copy it or open a prefilled email draft). On
  first visit the collaborator creates a password bound to their invited
  email; from then on they sign in on the login page with email +
  password, from any device. Guests can set credit statuses and points,
  edit credit notes, and upload documents on invited projects only — no
  project details editing, report export, deletes, or visibility into
  other projects. Access derives from active invites per email, so
  inviting an existing account to another project grants access
  instantly, and revoking an invite cuts it immediately. Clicking an
  invitee's name reissues their link, which doubles as a **password
  reset**; a used setup link can never take over an existing account.

Sessions are HMAC-signed cookies (secret in `data/auth-secret`, marked
`Secure` when served over HTTPS); invite tokens are stored hashed; guest
passwords are scrypt-hashed in `data/guests.json`. Sign-in and
invite-link endpoints are rate-limited per client address, and
account-setup links that were never used expire after **14 days**
(reissuing by clicking the invitee's name starts a fresh window —
already-activated accounts are unaffected). Credit uploads accept
documents, spreadsheets, images, and drawings only (PDF, Word, Excel,
PowerPoint, images, ZIP, DWG/DXF, MSG/EML — never executables or web
pages).

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
  for `config/protocols/wssp-2018.json` and the 2018 credit excerpts.
- `wssp2023.pdf` — the WSSP 2023 handbook (OSPI), the source for the 2023
  credit excerpts. `config/protocols/wssp-2023.json` was encoded from the
  official OSPI WSSP 2023 scorecard workbook.
