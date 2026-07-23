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

const app = express();
const PORT = process.env.PORT || 3000;

/* Bump whenever the API changes shape. The frontend declares the version it
 * was built against; a mismatch shows a "restart the server" banner instead
 * of letting edits silently fail. */
const API_VERSION = 1;

const DATA_DIR = process.env.APPDATA_DIR || path.join(__dirname, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const PROTOCOL_DIR = path.join(__dirname, "config", "protocols");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Atomic write: temp file + rename, so a crash mid-write can't corrupt data.
function writeFileAtomic(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

/* ── Protocols (read-only config) ────────────────────────────── */
const protocols = {};
for (const f of fs.readdirSync(PROTOCOL_DIR).filter(f => f.endsWith(".json"))) {
  const p = JSON.parse(fs.readFileSync(path.join(PROTOCOL_DIR, f), "utf8"));
  protocols[p.id] = p;
}

/* ── Store ───────────────────────────────────────────────────── */
let projects = [];
if (fs.existsSync(PROJECTS_FILE)) {
  projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
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

app.delete("/api/projects/:id", (req, res) => {
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ errors: ["Project not found"] });
  projects.splice(idx, 1);
  saveProjects();
  res.json({ ok: true });
});

/* ── Start ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`WSSP Tracker running at http://localhost:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
  console.log(`Protocols loaded: ${Object.keys(protocols).join(", ")}`);
});
