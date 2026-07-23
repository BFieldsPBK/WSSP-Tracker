/* WSSP Tracker — server.
 *
 * Serves the frontend and persists projects as JSON on disk.
 * Protocol definitions (WSSP 2018 / 2023) are read-only config.
 * Run with `npm start`; browse to http://localhost:3000.
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

/* Bump whenever the API changes shape. The frontend declares the version it
 * was built against; a mismatch shows a "restart the server" banner instead
 * of letting edits silently fail. */
const API_VERSION = 3;

const DATA_DIR = process.env.APPDATA_DIR || path.join(__dirname, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const FILES_DIR = path.join(DATA_DIR, "files");
const PROTOCOL_DIR = path.join(__dirname, "config", "protocols");
const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB per file, matching PBK's other tools

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, "file-" + crypto.randomBytes(8).toString("hex"))
  }),
  limits: { fileSize: MAX_UPLOAD }
});

// Atomic write: temp file + rename, so a crash mid-write can't corrupt data.
function writeFileAtomic(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

/* ── Protocols & reference material (read-only config) ───────── */
const protocols = {};
for (const f of fs.readdirSync(PROTOCOL_DIR).filter(f => f.endsWith(".json"))) {
  const p = JSON.parse(fs.readFileSync(path.join(PROTOCOL_DIR, f), "utf8"));
  protocols[p.id] = p;
}

/* Handbook excerpts, keyed by protocol id -> credit id -> text. */
const excerpts = {};
const HANDBOOK_DIR = path.join(__dirname, "config", "handbook");
if (fs.existsSync(HANDBOOK_DIR)) {
  for (const f of fs.readdirSync(HANDBOOK_DIR).filter(f => f.endsWith("-excerpts.json"))) {
    const protocolId = f.replace("-excerpts.json", "");
    excerpts[protocolId] = JSON.parse(fs.readFileSync(path.join(HANDBOOK_DIR, f), "utf8"));
  }
}

/* OSPI credit interpretation library. */
const interpretations = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config", "interpretations.json"), "utf8"));

/* Canonical SCAP D-Form phase keys (see D_PHASES in public/js/app.js).
 * Legacy free-text values like "D4" or "d-5" normalize to these; anything
 * unrecognized is kept as entered. */
const D_PHASE_KEYS = ["pre-d3", "d3", "d4", "d5", "d7", "d9", "d11", "annual"];
function normalizeDPhase(v) {
  if (!v) return "";
  const k = String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  return D_PHASE_KEYS.find(p => p.replace(/[^a-z0-9]/g, "") === k) || v;
}

/* ── Store ───────────────────────────────────────────────────── */
let projects = [];
if (fs.existsSync(PROJECTS_FILE)) {
  projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
  // One-time normalization of legacy free-text D-phase values ("D4" -> "d4").
  let migrated = false;
  for (const p of projects) {
    const norm = normalizeDPhase(p.dPhase);
    if (norm !== (p.dPhase || "")) { p.dPhase = norm; migrated = true; }
  }
  if (migrated) setImmediate(() => saveProjects());
}
function saveProjects() {
  writeFileAtomic(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

/* ── Middleware ──────────────────────────────────────────────── */
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ── API ─────────────────────────────────────────────────────── */
app.get("/api/meta", (req, res) => {
  res.json({ apiVersion: API_VERSION });
});

app.get("/api/protocols", (req, res) => {
  res.json(Object.values(protocols).sort((a, b) => b.id.localeCompare(a.id)));
});

app.get("/api/reference", (req, res) => {
  res.json({ excerpts, interpretations });
});

app.get("/api/projects", (req, res) => {
  // List view only needs the summary, not every credit selection.
  res.json(projects.map(p => ({
    id: p.id, name: p.name, number: p.number, district: p.district,
    districtClass: p.districtClass, projectType: p.projectType,
    protocolId: p.protocolId, dPhase: p.dPhase,
    city: p.city, updatedAt: p.updatedAt, createdAt: p.createdAt,
    creditCount: Object.keys(p.credits || {}).length
  })));
});

const PROJECT_FIELDS = [
  "name", "number", "projectType", "protocolId",
  "district", "districtClass", "dPhase",
  "address", "city", "state", "zip",
  "contactName", "contactPhone", "notes"
];
const PROJECT_TYPES = ["new", "newBuilding", "modernization"];

function validateProject(body, { partial } = {}) {
  const errors = [];
  const out = {};
  for (const f of PROJECT_FIELDS) {
    if (body[f] !== undefined) {
      if (typeof body[f] !== "string") { errors.push(`${f} must be a string`); continue; }
      out[f] = body[f].trim();
    }
  }
  if (out.dPhase !== undefined) out.dPhase = normalizeDPhase(out.dPhase);
  if (!partial || out.name !== undefined) {
    if (!out.name) errors.push("Project name is required");
  }
  if (!partial || out.protocolId !== undefined) {
    if (!protocols[out.protocolId]) errors.push("A valid WSSP edition is required");
  }
  if (!partial || out.projectType !== undefined) {
    if (!PROJECT_TYPES.includes(out.projectType)) errors.push("A valid project type is required");
  }
  if (!partial || out.districtClass !== undefined) {
    if (!["I", "II"].includes(out.districtClass)) errors.push("District class must be I or II");
  }
  if (!partial || out.district !== undefined) {
    if (!out.district) errors.push("School district is required");
  }
  return { errors, out };
}

app.post("/api/projects", (req, res) => {
  const { errors, out } = validateProject(req.body || {});
  if (errors.length) return res.status(400).json({ errors });
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomBytes(6).toString("hex"),
    ...out,
    credits: {},          // creditId -> { status: "yes"|"maybe"|"no", points: n }
    createdAt: now,
    updatedAt: now
  };
  projects.push(project);
  saveProjects();
  res.status(201).json(project);
});

function findProject(req, res) {
  const p = projects.find(p => p.id === req.params.id);
  if (!p) { res.status(404).json({ errors: ["Project not found"] }); return null; }
  return p;
}

app.get("/api/projects/:id", (req, res) => {
  const p = findProject(req, res);
  if (p) res.json(p);
});

app.put("/api/projects/:id", (req, res) => {
  const p = findProject(req, res);
  if (!p) return;
  const { errors, out } = validateProject(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ errors });
  // The protocol edition is locked once any credit has been marked, so a
  // scorecard filled against one edition can't silently switch to another.
  if (out.protocolId && out.protocolId !== p.protocolId && Object.keys(p.credits).length) {
    return res.status(400).json({ errors: [
      "The WSSP edition can't be changed once scorecard entries exist. Clear the scorecard first."
    ]});
  }
  Object.assign(p, out);
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.json(p);
});

app.put("/api/projects/:id/credits/:creditId", (req, res) => {
  const p = findProject(req, res);
  if (!p) return;
  const { status, points } = req.body || {};
  if (status === null || status === "none") {
    delete p.credits[req.params.creditId];
  } else {
    if (!["yes", "maybe", "no"].includes(status)) {
      return res.status(400).json({ errors: ["status must be yes, maybe, no, or none"] });
    }
    const entry = { status };
    if (points !== undefined && points !== null) {
      const n = Number(points);
      if (!Number.isInteger(n) || n < 0 || n > 99) {
        return res.status(400).json({ errors: ["points must be a whole number"] });
      }
      entry.points = n;
    }
    p.credits[req.params.creditId] = entry;
  }
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.json(p);
});

/* Per-credit notes, stored apart from status entries so clearing a
 * credit's Yes/Maybe/No never discards its notes. */
app.put("/api/projects/:id/credits/:creditId/note", (req, res) => {
  const p = findProject(req, res);
  if (!p) return;
  const text = req.body && typeof req.body.text === "string" ? req.body.text.trim() : "";
  if (!p.creditNotes) p.creditNotes = {};
  if (text) p.creditNotes[req.params.creditId] = text;
  else delete p.creditNotes[req.params.creditId];
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.json(p);
});

/* ── Credit documentation ────────────────────────────────────── *
 * Files live in data/files under random names; the original name and
 * which credit each file supports are recorded on the project. Documents
 * are kept separate from credit status entries, so clearing a credit's
 * Yes/Maybe/No never discards its uploaded evidence. */

function allDocuments(p) {
  return Object.values(p.documents || {}).flat();
}

app.post("/api/projects/:id/credits/:creditId/files", upload.single("file"), (req, res) => {
  const p = findProject(req, res);
  if (!p) return;
  if (!req.file) return res.status(400).json({ errors: ["No file received"] });
  if (!p.documents) p.documents = {};
  const list = p.documents[req.params.creditId] || (p.documents[req.params.creditId] = []);
  list.push({
    id: crypto.randomBytes(6).toString("hex"),
    name: req.file.originalname,
    size: req.file.size,
    storedName: req.file.filename,
    uploadedAt: new Date().toISOString()
  });
  p.updatedAt = new Date().toISOString();
  saveProjects();
  res.status(201).json(p);
});

app.get("/api/projects/:id/files/:fileId", (req, res) => {
  const p = findProject(req, res);
  if (!p) return;
  const doc = allDocuments(p).find(d => d.id === req.params.fileId);
  if (!doc) return res.status(404).json({ errors: ["File not found"] });
  res.download(path.join(FILES_DIR, doc.storedName), doc.name);
});

app.delete("/api/projects/:id/files/:fileId", (req, res) => {
  const p = findProject(req, res);
  if (!p) return;
  for (const [creditId, list] of Object.entries(p.documents || {})) {
    const idx = list.findIndex(d => d.id === req.params.fileId);
    if (idx !== -1) {
      const [doc] = list.splice(idx, 1);
      if (!list.length) delete p.documents[creditId];
      try { fs.unlinkSync(path.join(FILES_DIR, doc.storedName)); } catch (e) { /* already gone */ }
      p.updatedAt = new Date().toISOString();
      saveProjects();
      return res.json(p);
    }
  }
  res.status(404).json({ errors: ["File not found"] });
});

app.delete("/api/projects/:id", (req, res) => {
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ errors: ["Project not found"] });
  const [removed] = projects.splice(idx, 1);
  for (const doc of allDocuments(removed)) {
    try { fs.unlinkSync(path.join(FILES_DIR, doc.storedName)); } catch (e) { /* already gone */ }
  }
  saveProjects();
  res.json({ ok: true });
});

/* Multer errors (e.g. oversize uploads) arrive as thrown errors. */
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ errors: ["File is larger than the 25 MB limit"] });
  }
  console.error(err);
  res.status(500).json({ errors: ["Unexpected server error"] });
});

/* ── Start ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`WSSP Tracker running at http://localhost:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  console.log(`Protocols loaded: ${Object.keys(protocols).join(", ")}`);
});
