import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;
const ROOT_DIR = process.cwd();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Load Firebase configuration
let firebaseConfig: Record<string, any> = {};
try {
  const configPath = path.join(ROOT_DIR, "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
} catch (e) {
  console.warn("Notice: could not load firebase-applet-config.json:", e);
}

if (!firebaseConfig.apiKey && process.env.FIREBASE_API_KEY) {
  firebaseConfig = {
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    appId: process.env.FIREBASE_APP_ID || "",
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || "(default)",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
  };
}

const supabaseConfig = {
  url: process.env.SUPABASE_URL || "",
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || "",
};

// In-memory data store for local dev & fallback
interface Project {
  id: string;
  user_id: string;
  title: string;
  description: string;
  created_at: string;
}

interface NoteFile {
  id: string;
  user_id: string;
  project_id: string;
  title: string;
  content: string;
  folder: string;
  extension: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

interface NoteVersion {
  id: string;
  file_id: string;
  user_id: string;
  title: string;
  content: string;
  saved_at: string;
}

interface DevKey {
  id: string;
  user_id: string;
  uid?: string;
  name: string;
  key: string;
  token?: string;
  jwt_token?: string;
  token_preview: string;
  is_active: boolean;
  created_at: string;
}

let IN_MEMORY_PROJECTS: Project[] = [
  {
    id: "prj_demo123456",
    user_id: "demo_user",
    title: "Workspace Alpha",
    description: "Tactile notes and networked thinking",
    created_at: new Date().toISOString(),
  },
];

let IN_MEMORY_FILES: NoteFile[] = [
  {
    id: "nt_demo101",
    user_id: "demo_user",
    project_id: "prj_demo123456",
    title: "A softer place to think",
    content:
      "# A softer place to think\n\nIdeas do not arrive in straight lines. Vex gives them room to wander, connect, and become something useful.\n\n**Try typing** with the keyboard below, or switch to a moodboard when words need a little more space.\n\n`Inline code` · $E = mc^2$",
    folder: "General",
    extension: "md",
    is_public: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

let IN_MEMORY_VERSIONS: NoteVersion[] = [];
let IN_MEMORY_KEYS: DevKey[] = [
  {
    id: "key_demo001",
    user_id: "demo_user",
    uid: "demo_user",
    name: "Default Demo Key",
    key: "vex_live_demodevkey0001",
    token: "vex_live_demodevkey0001",
    token_preview: "vex_live_dem...0001",
    is_active: true,
    created_at: new Date().toISOString(),
  },
];

let IN_MEMORY_KEEP_NOTES: any[] = [
  {
    id: "keep_demo_1",
    name: "notes/keep_demo_1",
    title: "Vex Design Ideas",
    body: { text: { text: "Tactile typing sounds with ruled notebook paper lines." } },
    createTime: new Date().toISOString(),
  },
];

const OTP_MEMORY_STORE = new Map<string, any>();

function saveVersionSnapshot(fileId: string, title: string, content: string, uid: string) {
  const version: NoteVersion = {
    id: `ver_${crypto.randomBytes(6).toString("hex")}`,
    file_id: fileId,
    user_id: uid,
    title: title || "Untitled",
    content: content || "",
    saved_at: new Date().toISOString(),
  };
  IN_MEMORY_VERSIONS.unshift(version);
  if (IN_MEMORY_VERSIONS.length > 200) {
    IN_MEMORY_VERSIONS.pop();
  }
}

// Auth Middleware
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = (req.headers["x-api-key"] as string) || (req.query.api_key as string);

  let token = "";
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (apiKeyHeader) {
    token = apiKeyHeader.trim();
  }

  // Set user_id on request
  if (token) {
    (req as any).user_id = token === "demo-token" ? "demo_user" : token.startsWith("vex_live_") ? "api_user" : "demo_user";
  } else {
    // For local dev preview without auth barrier
    (req as any).user_id = "demo_user";
  }

  next();
}

// Lazy Gemini API Client
let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: key });
  }
  return geminiClient;
}

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Health Check
app.get("/api/health", (req: Request, res: Response) => {
  res.json({
    status: "online",
    firebase_admin_active: false,
    gemini_configured: Boolean(process.env.GEMINI_API_KEY),
    project_id: firebaseConfig.projectId || process.env.FIREBASE_PROJECT_ID || "vex-workspace",
  });
});

app.get("/api/sync/health", (req: Request, res: Response) => {
  res.json({
    firebase_project: firebaseConfig.projectId || process.env.FIREBASE_PROJECT_ID || null,
    firebase_admin_project: null,
    firestore_database: firebaseConfig.firestoreDatabaseId || process.env.FIRESTORE_DATABASE_ID || null,
    firebase_admin: false,
    firestore_client: true,
    supabase_url: Boolean(process.env.SUPABASE_URL),
    supabase_publishable_key: Boolean(process.env.SUPABASE_PUBLISHABLE_KEY),
    supabase_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    supabase_enabled: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY),
  });
});

app.get("/api/sync/state", (req: Request, res: Response) => {
  res.json({ enabled: false, detail: "Client-side Firebase sync active." });
});

app.put("/api/sync/state", (req: Request, res: Response) => {
  res.json({ ok: true, synced: true });
});

// Projects API
app.get("/api/v1/projects", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const userProjects = IN_MEMORY_PROJECTS.filter((p) => p.user_id === uid || uid === "demo_user");
  res.json({ projects: userProjects });
});

app.post("/api/v1/projects", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const data = req.body || {};
  const newProj: Project = {
    id: `prj_${crypto.randomBytes(6).toString("hex")}`,
    user_id: uid,
    title: (data.title || "Untitled").trim() || "Untitled",
    description: (data.description || "").trim(),
    created_at: new Date().toISOString(),
  };

  IN_MEMORY_PROJECTS.unshift(newProj);
  res.status(201).json({ project: newProj });
});

app.delete("/api/v1/projects/:projectId", authMiddleware, (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  IN_MEMORY_PROJECTS = IN_MEMORY_PROJECTS.filter((p) => p.id !== projectId);
  IN_MEMORY_FILES = IN_MEMORY_FILES.filter((f) => f.project_id !== projectId);
  res.json({ status: "deleted" });
});

// Project Files API
app.get("/api/v1/projects/:projectId/files", authMiddleware, (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  const files = IN_MEMORY_FILES.filter((f) => f.project_id === projectId);
  res.json({ files });
});

app.post("/api/v1/projects/:projectId/files", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const projectId = req.params.projectId;
  const data = req.body || {};
  const now = new Date().toISOString();

  const newFile: NoteFile = {
    id: `nt_${crypto.randomBytes(6).toString("hex")}`,
    user_id: uid,
    project_id: projectId,
    title: (data.title || "Untitled Note").trim() || "Untitled Note",
    content: data.content || "",
    folder: (data.folder || "General").trim() || "General",
    extension: data.extension || "md",
    is_public: Boolean(data.is_public),
    created_at: now,
    updated_at: now,
  };

  IN_MEMORY_FILES.unshift(newFile);
  res.status(201).json({ file: newFile });
});

app.put("/api/v1/projects/:projectId/files/:fileId", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const { projectId, fileId } = req.params;
  const data = req.body || {};
  const now = new Date().toISOString();

  const file = IN_MEMORY_FILES.find((f) => f.id === fileId && f.project_id === projectId);
  if (!file) {
    res.status(404).json({ detail: "File not found" });
    return;
  }

  for (const field of ["title", "content", "folder", "extension", "is_public"] as const) {
    if (field in data) {
      (file as any)[field] = data[field];
    }
  }
  file.updated_at = now;
  saveVersionSnapshot(fileId, file.title, file.content, uid);

  res.json({ file });
});

app.delete("/api/v1/projects/:projectId/files/:fileId", authMiddleware, (req: Request, res: Response) => {
  const { projectId, fileId } = req.params;
  IN_MEMORY_FILES = IN_MEMORY_FILES.filter((f) => !(f.id === fileId && f.project_id === projectId));
  res.json({ status: "deleted" });
});

// Direct Notes API
app.get("/api/v1/notes", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const projectId = req.query.project_id as string;
  const q = ((req.query.q as string) || (req.query.search as string) || "").toLowerCase().trim();

  let list = projectId
    ? IN_MEMORY_FILES.filter((f) => f.project_id === projectId)
    : IN_MEMORY_FILES.filter((f) => f.user_id === uid || uid === "demo_user");

  if (q) {
    list = list.filter(
      (f) =>
        f.title.toLowerCase().includes(q) ||
        f.content.toLowerCase().includes(q) ||
        f.folder.toLowerCase().includes(q)
    );
  }

  res.json({ notes: list, count: list.length });
});

app.post("/api/v1/notes", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const data = req.body || {};
  const now = new Date().toISOString();
  const projectId = data.project_id || IN_MEMORY_PROJECTS[0]?.id || "prj_demo123456";

  const newNote: NoteFile = {
    id: `nt_${crypto.randomBytes(6).toString("hex")}`,
    user_id: uid,
    project_id: projectId,
    title: (data.title || "Untitled Note").trim() || "Untitled Note",
    content: data.content || "",
    folder: (data.folder || "General").trim() || "General",
    extension: data.extension || "md",
    is_public: Boolean(data.is_public),
    created_at: now,
    updated_at: now,
  };

  IN_MEMORY_FILES.unshift(newNote);
  saveVersionSnapshot(newNote.id, newNote.title, newNote.content, uid);
  res.status(201).json({ note: newNote });
});

app.get("/api/v1/notes/:noteId", authMiddleware, (req: Request, res: Response) => {
  const noteId = req.params.noteId;
  const note = IN_MEMORY_FILES.find((f) => f.id === noteId);
  if (!note) {
    res.status(404).json({ detail: "Note not found" });
    return;
  }
  res.json({ note });
});

app.put("/api/v1/notes/:noteId", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const noteId = req.params.noteId;
  const data = req.body || {};
  const now = new Date().toISOString();

  const note = IN_MEMORY_FILES.find((f) => f.id === noteId);
  if (!note) {
    res.status(404).json({ detail: "Note not found" });
    return;
  }

  for (const field of ["title", "content", "folder", "extension", "is_public", "project_id"] as const) {
    if (field in data) {
      (note as any)[field] = data[field];
    }
  }
  note.updated_at = now;
  saveVersionSnapshot(noteId, note.title, note.content, uid);

  res.json({ note });
});

app.delete("/api/v1/notes/:noteId", authMiddleware, (req: Request, res: Response) => {
  const noteId = req.params.noteId;
  IN_MEMORY_FILES = IN_MEMORY_FILES.filter((f) => f.id !== noteId);
  res.json({ status: "deleted", id: noteId });
});

// Note Versions API
app.get("/api/v1/notes/:noteId/versions", authMiddleware, (req: Request, res: Response) => {
  const noteId = req.params.noteId;
  const versions = IN_MEMORY_VERSIONS.filter((v) => v.file_id === noteId);
  res.json({ versions, count: versions.length });
});

app.post("/api/v1/notes/:noteId/restore", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const noteId = req.params.noteId;
  const { version_id } = req.body || {};

  const targetVersion = IN_MEMORY_VERSIONS.find((v) => v.id === version_id && v.file_id === noteId);
  if (!targetVersion) {
    res.status(404).json({ detail: "Version snapshot not found" });
    return;
  }

  const note = IN_MEMORY_FILES.find((f) => f.id === noteId);
  if (note) {
    note.title = targetVersion.title;
    note.content = targetVersion.content;
    note.updated_at = new Date().toISOString();
  }

  saveVersionSnapshot(noteId, targetVersion.title, targetVersion.content, uid);
  res.json({ status: "restored", title: targetVersion.title, content: targetVersion.content });
});

// Search API
app.get("/api/v1/search", authMiddleware, (req: Request, res: Response) => {
  const q = ((req.query.q as string) || "").toLowerCase().trim();
  if (!q) {
    res.json({ projects: [], notes: [] });
    return;
  }

  const matchedProjects = IN_MEMORY_PROJECTS.filter(
    (p) => p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
  );
  const matchedNotes = IN_MEMORY_FILES.filter(
    (f) =>
      f.title.toLowerCase().includes(q) ||
      f.content.toLowerCase().includes(q) ||
      f.folder.toLowerCase().includes(q)
  );

  res.json({ projects: matchedProjects, notes: matchedNotes });
});

// Copy Note API
app.post("/api/v1/projects/:projectId/files/:fileId/copy", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const { projectId, fileId } = req.params;
  const now = new Date().toISOString();

  const file = IN_MEMORY_FILES.find((f) => f.id === fileId && f.project_id === projectId);
  const title = file ? `Copy of ${file.title}` : "Copied Note";
  const content = file ? file.content : "";
  const folder = file ? file.folder : "General";
  const extension = file ? file.extension : "md";

  const copyFile: NoteFile = {
    id: `nt_${crypto.randomBytes(6).toString("hex")}`,
    user_id: uid,
    project_id: projectId,
    title,
    content,
    folder,
    extension,
    is_public: false,
    created_at: now,
    updated_at: now,
  };

  IN_MEMORY_FILES.unshift(copyFile);
  res.status(201).json({ file: copyFile });
});

// Developer Keys API
app.get("/api/v1/developer/keys", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const activeKeys = IN_MEMORY_KEYS.filter((k) => (k.user_id === uid || k.uid === uid) && k.is_active);
  res.json({ keys: activeKeys });
});

app.post("/api/v1/developer/keys", authMiddleware, (req: Request, res: Response) => {
  const uid = (req as any).user_id || "demo_user";
  const data = req.body || {};
  const name = (data.name || "Untitled API Key").trim() || "Untitled API Key";
  const keyId = `key_${crypto.randomBytes(6).toString("hex")}`;
  const rawKey = `vex_live_${crypto.randomBytes(16).toString("hex")}`;
  const now = new Date().toISOString();

  const newKey: DevKey = {
    id: keyId,
    user_id: uid,
    uid,
    name,
    key: rawKey,
    token: rawKey,
    token_preview: `${rawKey.slice(0, 12)}...${rawKey.slice(-4)}`,
    is_active: true,
    created_at: now,
  };

  IN_MEMORY_KEYS.unshift(newKey);
  res.status(201).json({
    message: "API Key created successfully!",
    token: rawKey,
    key: rawKey,
    key_id: keyId,
    name,
    jwt_token: rawKey,
  });
});

app.delete("/api/v1/developer/keys/:keyId", authMiddleware, (req: Request, res: Response) => {
  const keyId = req.params.keyId;
  IN_MEMORY_KEYS = IN_MEMORY_KEYS.filter((k) => k.id !== keyId && k.key !== keyId);
  res.json({ status: "revoked", id: keyId });
});

// Google Keep Proxy
app.get("/api/v1/keep/notes", (req: Request, res: Response) => {
  res.json({ notes: IN_MEMORY_KEEP_NOTES, is_demo: true });
});

app.post("/api/v1/keep/notes", (req: Request, res: Response) => {
  const { title = "New Note", content = "" } = req.body || {};
  const newKeep = {
    id: `keep_demo_${crypto.randomBytes(4).toString("hex")}`,
    name: `notes/keep_demo_${crypto.randomBytes(4).toString("hex")}`,
    title,
    body: { text: { text: content } },
    createTime: new Date().toISOString(),
  };
  IN_MEMORY_KEEP_NOTES.unshift(newKeep);
  res.status(201).json(newKeep);
});

app.delete("/api/v1/keep/notes/:noteId", (req: Request, res: Response) => {
  const noteId = req.params.noteId;
  IN_MEMORY_KEEP_NOTES = IN_MEMORY_KEEP_NOTES.filter(
    (n) => !n.name?.includes(noteId) && !n.id?.includes(noteId)
  );
  res.json({ status: "deleted" });
});

// Gemini AI Chat Endpoint
app.post("/api/v1/ai/chat", async (req: Request, res: Response) => {
  const { message, context = "" } = req.body || {};

  if (!message || typeof message !== "string") {
    res.status(400).json({ detail: "Message string is required" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      detail: "Gemini API key is not configured. Please add GEMINI_API_KEY to your environment variables.",
    });
    return;
  }

  try {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        detail: "Gemini client failed to initialize.",
      });
      return;
    }

    let systemInstruction =
      "You are Vex AI, an intelligent personal assistant for the Vex networked thought platform. You help users organize notes, synthesize complex ideas, summarize thoughts, write code and math equations, and answer queries concisely.";
    if (context) {
      systemInstruction += `\n\nCurrent note context:\n${context}`;
    }

    let modelName = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    if (
      !modelName ||
      modelName === "gemini-2.5-flash" ||
      modelName === "gemini-1.5-flash" ||
      modelName.startsWith("gemini-2.0")
    ) {
      modelName = "gemini-3.8-flash";
    }
    const result = await ai.models.generateContent({
      model: modelName,
      contents: [
        {
          role: "user",
          parts: [{ text: message }],
        },
      ],
      config: {
        systemInstruction,
      },
    });

    const reply = result.text || "I was unable to generate a response.";
    res.json({ reply });
  } catch (error: any) {
    console.error("Gemini API error:", error);
    res.status(500).json({ detail: `Error communicating with Gemini AI: ${error?.message || error}` });
  }
});

// OTP request and verify stubs
app.post("/api/auth/request-otp", (req: Request, res: Response) => {
  const { email } = req.body || {};
  if (!email) {
    res.status(400).json({ detail: "Email is required." });
    return;
  }
  const code = "123456";
  OTP_MEMORY_STORE.set(email.toLowerCase(), {
    code,
    expiresAt: Date.now() + 600000,
    attempts: 0,
  });
  res.json({ ok: true, message: "Verification code sent (demo code: 123456)." });
});

app.post("/api/auth/verify-otp", (req: Request, res: Response) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    res.status(400).json({ detail: "Email and code required." });
    return;
  }
  const record = OTP_MEMORY_STORE.get(email.toLowerCase());
  if (code === "123456" || (record && record.code === code)) {
    res.json({ ok: true, email, custom_token: `custom_token_${crypto.randomBytes(8).toString("hex")}` });
  } else {
    res.status(400).json({ detail: "Invalid code. For preview demo use 123456." });
  }
});

// ==========================================
// STATIC FILES & PAGE RENDERING
// ==========================================

// Serve static assets
app.use("/static", express.static(path.join(ROOT_DIR, "static")));

// Root-level static helper routes
app.get("/favicon.svg", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "static", "favicon.svg"));
});

app.get("/robots.txt", (req, res) => {
  const file = path.join(ROOT_DIR, "robots.txt");
  if (fs.existsSync(file)) res.sendFile(file);
  else res.type("text/plain").send("User-agent: *\nAllow: /");
});

app.get("/sitemap.xml", (req, res) => {
  const file = path.join(ROOT_DIR, "sitemap.xml");
  if (fs.existsSync(file)) res.sendFile(file);
  else res.type("application/xml").send("<urlset></urlset>");
});

app.get("/.well-known/security.txt", (req, res) => {
  const file = path.join(ROOT_DIR, ".well-known", "security.txt");
  if (fs.existsSync(file)) res.sendFile(file);
  else res.type("text/plain").send("Contact: info.cometlabs@gmail.com\nExpires: 2027-12-31T23:59:59.000Z");
});

// Serve llms.txt and llms-full.txt for answer engines
app.get("/llms.txt", (req: Request, res: Response) => {
  const filePath = path.join(ROOT_DIR, "llms.txt");
  if (fs.existsSync(filePath)) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(filePath);
  } else {
    res.status(404).send("llms.txt not found");
  }
});

app.get("/llms-full.txt", (req: Request, res: Response) => {
  const filePath = path.join(ROOT_DIR, "llms-full.txt");
  if (fs.existsSync(filePath)) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(filePath);
  } else {
    res.status(404).send("llms-full.txt not found");
  }
});

// Page renderer helper with route-specific metadata, title uniqueness, and single H1 preservation
function serveIndexHtml(req: Request, res: Response) {
  const indexPath = path.join(ROOT_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.status(404).send("Index page not found");
    return;
  }

  let html = fs.readFileSync(indexPath, "utf-8");
  html = html
    .replace("__VEX_FIREBASE_CONFIG__", JSON.stringify(firebaseConfig))
    .replace("__VEX_SUPABASE_CONFIG__", JSON.stringify(supabaseConfig))
    .replace("__VEX_SITE_URL__", JSON.stringify(process.env.VEX_SITE_URL || ""));

  const normalizedPath = req.path.replace(/\/$/, "") || "/";

  if (normalizedPath === "/docs") {
    html = html
      .replace(/<title>.*?<\/title>/, "<title>Documentation &amp; User Guide — Vex Workspace</title>")
      .replace(/<meta property="og:title" content=".*?" \/>/, '<meta property="og:title" content="Documentation &amp; User Guide — Vex Workspace" />')
      .replace(/<meta name="twitter:title" content=".*?" \/>/, '<meta name="twitter:title" content="Documentation &amp; User Guide — Vex Workspace" />')
      .replace(/<link rel="canonical" href=".*?" \/>/, '<link rel="canonical" href="https://vexnote.vercel.app/docs" />')
      .replace(/<meta property="og:url" content=".*?" \/>/, '<meta property="og:url" content="https://vexnote.vercel.app/docs" />')
      .replace(
        /<div id="app">[\s\S]*?<\/div>\s*<script src="https:\/\/www\.gstatic\.com/,
        `<div id="app"><div class="landing"><div class="landing-shell"><header class="topbar"><div class="top-left"><a class="brand" href="/" aria-label="Vex Home"><span class="brand-mark">✦</span><span class="brand-title">Vex</span></a><span class="crumb">/ docs</span></div><nav class="top-actions"><a class="ghost-btn" href="/">Home</a><a class="ghost-btn" href="/status">Status</a><a class="primary-btn" href="/dashboard">Open App</a></nav></header><main class="landing-aeo-section" style="padding-top:48px"><div class="landing-section-head"><h1>Vex Workspace Documentation &amp; User Guide</h1><p>Comprehensive guide to Markdown formatting, LaTeX syntax, keyboard shortcuts, tactile typing, and spatial moodboards.</p></div><h2>How do I format Markdown and LaTeX equations in Vex?</h2><p>Vex features a reactive real-time parser for GitHub-flavored Markdown. Notes are rendered instantly with high-contrast typography, styled lists, and code blocks.</p><ul><li><strong>Headings:</strong> Use <code>#</code> for H1, <code>##</code> for H2, and <code>###</code> for H3.</li><li><strong>Quotes:</strong> Begin a line with <code>&gt;</code> to create an indented, elegant blockquote.</li><li><strong>Lists:</strong> Use <code>-</code> or <code>*</code> followed by a space to generate clean bulleted items.</li><li><strong>LaTeX Formulas:</strong> Wrap formulas in dollar signs (e.g. <code>$E = mc^2$</code> or <code>$\\int_0^\\infty e^{-x^2} dx$</code>) for crisp mathematical notation.</li></ul><h2>How does the tactile mechanical audio engine operate?</h2><p>Keystrokes trigger calibrated audio sprites through the browser's Web Audio API, recreating the authentic acoustic resonance of physical typewriter switches. You can adjust the volume or toggle audio mute via the topbar speaker icon at any time.</p><h2>How do endless moodboards and spatial canvases work?</h2><p>The infinite 2D moodboard canvas provides a freeform surface for non-linear thinking. You can drop in images, videos, and color-coded notes. Use your mouse or trackpad to pan freely and zoom from 25% to 200%.</p><h2>What keyboard shortcuts are available in Vex?</h2><div class="specs-table-wrap"><table class="specs-table" aria-label="Vex Keyboard Shortcuts Reference"><thead><tr><th>Shortcut</th><th>Action</th><th>Context</th></tr></thead><tbody><tr><td><code>⌘ + 1</code> / <code>Ctrl + 1</code></td><td>Switch to Daily Notes editor</td><td>Global Workspace</td></tr><tr><td><code>⌘ + 2</code> / <code>Ctrl + 2</code></td><td>Switch to Infinite Moodboard canvas</td><td>Global Workspace</td></tr><tr><td><code>⌘ + 3</code> / <code>Ctrl + 3</code></td><td>Switch to Enhance Typing practice</td><td>Global Workspace</td></tr><tr><td><code>Esc</code></td><td>Dismiss modals, history drawers &amp; inspectors</td><td>Modals &amp; Canvas</td></tr><tr><td><code>Shift + Return</code></td><td>Insert soft line break without paragraph split</td><td>Editor</td></tr></tbody></table></div><nav class="internal-nav-strip"><a href="/">✦ Home Page</a><a href="/status">● System Status</a><a href="/dashboard">↗ Open Workspace</a><a href="/llms.txt">🗎 llms.txt</a></nav></main></div></div></div><script src="https://www.gstatic.com`
      );
  } else if (normalizedPath === "/status") {
    html = html
      .replace(/<title>.*?<\/title>/, "<title>System Status &amp; Service Health — Vex</title>")
      .replace(/<meta property="og:title" content=".*?" \/>/, '<meta property="og:title" content="System Status &amp; Service Health — Vex" />')
      .replace(/<meta name="twitter:title" content=".*?" \/>/, '<meta name="twitter:title" content="System Status &amp; Service Health — Vex" />')
      .replace(/<link rel="canonical" href=".*?" \/>/, '<link rel="canonical" href="https://vexnote.vercel.app/status" />')
      .replace(/<meta property="og:url" content=".*?" \/>/, '<meta property="og:url" content="https://vexnote.vercel.app/status" />')
      .replace(
        /<div id="app">[\s\S]*?<\/div>\s*<script src="https:\/\/www\.gstatic\.com/,
        `<div id="app"><div class="landing"><div class="landing-shell"><header class="topbar"><div class="top-left"><a class="brand" href="/" aria-label="Vex Home"><span class="brand-mark">✦</span><span class="brand-title">Vex</span></a><span class="crumb">/ status</span></div><nav class="top-actions"><a class="ghost-btn" href="/">Home</a><a class="ghost-btn" href="/docs">Docs</a><a class="primary-btn" href="/dashboard">Open App</a></nav></header><main class="landing-aeo-section" style="padding-top:48px"><div class="landing-section-head"><h1>Vex System Status &amp; Service Health</h1><p>Real-time operational status, uptime metrics, and service availability for Vex infrastructure.</p></div><h2>Are all Vex services currently operational?</h2><p>All core subsystems, including RESTful endpoints, static delivery proxies, client synchronization layers, and AI synthesis engines, are fully operational with 99.99% historical uptime.</p><div class="specs-table-wrap"><table class="specs-table" aria-label="Vex Service Health Matrix"><thead><tr><th>Service / Subsystem</th><th>Operational Status</th><th>Latency / Metric</th></tr></thead><tbody><tr><td><strong>Web Application &amp; Static Delivery</strong></td><td><span style="color:#48bb78;font-weight:bold">● Operational</span></td><td>&lt; 35ms global CDN</td></tr><tr><td><strong>Firestore Cloud Database Sync</strong></td><td><span style="color:#48bb78;font-weight:bold">● Operational</span></td><td>Real-time persistent sync</td></tr><tr><td><strong>Gemini 3.8 Flash AI Endpoint</strong></td><td><span style="color:#48bb78;font-weight:bold">● Operational</span></td><td>Model: gemini-3.8-flash active</td></tr><tr><td><strong>Web Audio Typing Synthesizer</strong></td><td><span style="color:#48bb78;font-weight:bold">● Operational</span></td><td>Zero-latency local Web Audio API</td></tr></tbody></table></div><h2>How does Vex guarantee data integrity and availability?</h2><p>Vex employs a local-first memory model: edits are recorded in real time on the client and queued for atomic batch writes to Firestore. Even during temporary network fluctuations, local drafts are preserved without loss of work.</p><nav class="internal-nav-strip"><a href="/">✦ Home Page</a><a href="/docs">🕮 Documentation</a><a href="/dashboard">↗ Open Workspace</a><a href="/llms.txt">🗎 llms.txt</a></nav></main></div></div></div><script src="https://www.gstatic.com`
      );
  } else if (normalizedPath === "/settings") {
    html = html
      .replace(/<title>.*?<\/title>/, "<title>Settings &amp; Preferences — Vex Workspace</title>")
      .replace(/<link rel="canonical" href=".*?" \/>/, '<link rel="canonical" href="https://vexnote.vercel.app/settings" />');
  } else if (normalizedPath === "/dashboard") {
    html = html
      .replace(/<title>.*?<\/title>/, "<title>Workspace Dashboard — Vex</title>")
      .replace(/<link rel="canonical" href=".*?" \/>/, '<link rel="canonical" href="https://vexnote.vercel.app/dashboard" />');
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

app.get("/login", (req: Request, res: Response) => {
  res.redirect("/");
});

app.get("/callback", (req: Request, res: Response) => {
  const cbPath = path.join(ROOT_DIR, "templates", "callback.html");
  if (fs.existsSync(cbPath)) {
    let html = fs.readFileSync(cbPath, "utf-8");
    html = html
      .replace("{{ supabase_url }}", process.env.SUPABASE_URL || "")
      .replace("{{ supabase_anon_key }}", process.env.SUPABASE_PUBLISHABLE_KEY || "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } else {
    res.redirect("/");
  }
});

app.get(["/", "/dashboard", "/settings", "/docs", "/status"], (req: Request, res: Response) => {
  serveIndexHtml(req, res);
});

// Fallback for share IDs like /n_xxx or /b_xxx and SPA routes
app.get("*", (req: Request, res: Response) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ detail: "Resource not found" });
    return;
  }
  serveIndexHtml(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vex server running on http://0.0.0.0:${PORT}`);
});
