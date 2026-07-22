import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';
const START_TIME = Date.now();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ==========================================
// IN-MEMORY STORAGE FALLBACK
// ==========================================
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

interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  key: string;
  is_active: boolean;
  created_at: string;
  last_used_at?: string;
}

const inMemoryProjects: Project[] = [
  {
    id: 'prj_demo123456',
    user_id: 'demo_user',
    title: 'Personal Workspace',
    description: 'Main research and networked ideas workspace.',
    created_at: new Date().toISOString()
  }
];

const inMemoryFiles: NoteFile[] = [
  {
    id: 'nt_demo101',
    user_id: 'demo_user',
    project_id: 'prj_demo123456',
    title: 'Welcome to Vex',
    content: '# Welcome to Vex 🚀\n\nVex is your networked thought platform.\n\n### Key Features:\n- **Markdown & LaTeX**: Support for equations like $E = mc^2$ and math blocks:\n  $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$\n- **Networked Notes**: Organize by folders and tags.\n- **Vex AI**: Powered by Gemini for instant brainstorming.',
    folder: 'General',
    extension: 'md',
    is_public: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];

const inMemoryKeys: ApiKey[] = [
  {
    id: 'key_demo001',
    user_id: 'demo_user',
    name: 'Default Production Key',
    key: 'vex_live_' + crypto.randomBytes(16).toString('hex'),
    is_active: true,
    created_at: new Date().toISOString()
  }
];

function _now(): string {
  return new Date().toISOString();
}

function randomHex(length: number): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

// ==========================================
// TEMPLATE RENDER HELPER
// ==========================================
let firebaseConfigObj: any = {};
try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    firebaseConfigObj = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
} catch (e) {
  console.warn('Could not read firebase-applet-config.json in server.ts');
}

function renderHtmlTemplate(filename: string, res: Response) {
  const filePath = path.join(process.cwd(), 'templates', filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).sendFile(path.join(process.cwd(), 'templates', '404.html'));
  }
  let content = fs.readFileSync(filePath, 'utf-8');
  content = content.replace(/\{\{\s*supabase_url\s*\}\}/g, SUPABASE_URL);
  content = content.replace(/\{\{\s*supabase_anon_key\s*\}\}/g, SUPABASE_ANON_KEY);
  content = content.replace(/\{\{\s*firebase_json\s*\|\s*safe\s*if\s*firebase_json\s*else\s*['"]\{\}['"]\s*\}\}/g, JSON.stringify(firebaseConfigObj));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(content);
}

// ==========================================
// FRONTEND ROUTES
// ==========================================
app.get('/', (req, res) => renderHtmlTemplate('index.html', res));
app.get('/login', (req, res) => renderHtmlTemplate('login.html', res));
app.get('/dashboard', (req, res) => renderHtmlTemplate('dashboard.html', res));
app.get('/settings', (req, res) => renderHtmlTemplate('settings.html', res));
app.get('/docs', (req, res) => renderHtmlTemplate('docs.html', res));
app.get('/status', (req, res) => renderHtmlTemplate('status.html', res));
app.get('/auth/callback', (req, res) => renderHtmlTemplate('callback.html', res));

// ==========================================
// SYSTEM HEALTH API
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    gemini_configured: !!process.env.GEMINI_API_KEY
  });
});

// ==========================================
// CORE API: PROJECTS
// ==========================================
app.get('/api/v1/projects', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (SUPABASE_URL && SUPABASE_ANON_KEY && token && token !== 'demo-token') {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/projects?order=created_at.desc`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`
        }
      });
      if (resp.ok) {
        const data = await resp.json();
        return res.json({ projects: data });
      }
    } catch (e) {
      console.warn('Supabase fetch projects error, using in-memory');
    }
  }

  res.json({ projects: inMemoryProjects });
});

app.post('/api/v1/projects', async (req, res) => {
  const { title, description } = req.body || {};
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const newProj: Project = {
    id: `prj_${randomHex(12)}`,
    user_id: 'demo_user',
    title: (title || 'Untitled').trim() || 'Untitled',
    description: (description || '').trim(),
    created_at: _now()
  };

  if (SUPABASE_URL && SUPABASE_ANON_KEY && token && token !== 'demo-token') {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(newProj)
      });
      if (resp.ok) {
        const data = await resp.json();
        return res.status(201).json({ project: data[0] || newProj });
      }
    } catch (e) {
      console.warn('Supabase create project error, using in-memory');
    }
  }

  inMemoryProjects.unshift(newProj);
  res.status(201).json({ project: newProj });
});

app.delete('/api/v1/projects/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (SUPABASE_URL && SUPABASE_ANON_KEY && token && token !== 'demo-token') {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${projectId}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`
        }
      });
      await fetch(`${SUPABASE_URL}/rest/v1/files?project_id=eq.${projectId}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`
        }
      });
    } catch (e) {
      console.warn('Supabase delete project error');
    }
  }

  const pIndex = inMemoryProjects.findIndex((p) => p.id === projectId);
  if (pIndex > -1) inMemoryProjects.splice(pIndex, 1);
  for (let i = inMemoryFiles.length - 1; i >= 0; i--) {
    if (inMemoryFiles[i].project_id === projectId) {
      inMemoryFiles.splice(i, 1);
    }
  }

  res.json({ status: 'deleted' });
});

// ==========================================
// CORE API: FILES / NOTES
// ==========================================
app.get('/api/v1/projects/:projectId/files', async (req, res) => {
  const { projectId } = req.params;
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (SUPABASE_URL && SUPABASE_ANON_KEY && token && token !== 'demo-token') {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/files?project_id=eq.${projectId}&order=updated_at.desc`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`
        }
      });
      if (resp.ok) {
        const data = await resp.json();
        return res.json({ files: data });
      }
    } catch (e) {
      console.warn('Supabase fetch files error');
    }
  }

  const files = inMemoryFiles.filter((f) => f.project_id === projectId);
  res.json({ files });
});

app.post('/api/v1/projects/:projectId/files', async (req, res) => {
  const { projectId } = req.params;
  const { title, content, folder, extension } = req.body || {};
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const newFile: NoteFile = {
    id: `nt_${randomHex(12)}`,
    user_id: 'demo_user',
    project_id: projectId,
    title: title || 'Untitled Note',
    content: content || '',
    folder: folder || 'General',
    extension: extension || 'md',
    is_public: false,
    created_at: _now(),
    updated_at: _now()
  };

  if (SUPABASE_URL && SUPABASE_ANON_KEY && token && token !== 'demo-token') {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/files`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(newFile)
      });
      if (resp.ok) {
        const data = await resp.json();
        return res.status(201).json({ file: data[0] || newFile });
      }
    } catch (e) {
      console.warn('Supabase create file error');
    }
  }

  inMemoryFiles.unshift(newFile);
  res.status(201).json({ file: newFile });
});

app.put('/api/v1/projects/:projectId/files/:fileId', async (req, res) => {
  const { projectId, fileId } = req.params;
  const data = req.body || {};
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (SUPABASE_URL && SUPABASE_ANON_KEY && token && token !== 'demo-token') {
    try {
      const patchData: Record<string, any> = { updated_at: _now() };
      for (const key of ['title', 'content', 'folder', 'extension', 'is_public']) {
        if (key in data) patchData[key] = data[key];
      }
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/files?id=eq.${fileId}&project_id=eq.${projectId}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(patchData)
      });
      if (resp.ok) {
        const result = await resp.json();
        if (result && result.length > 0) return res.json({ file: result[0] });
      }
    } catch (e) {
      console.warn('Supabase update file error');
    }
  }

  const file = inMemoryFiles.find((f) => f.id === fileId && f.project_id === projectId);
  if (!file) {
    return res.status(404).json({ detail: 'File not found' });
  }

  if ('title' in data) file.title = data.title;
  if ('content' in data) file.content = data.content;
  if ('folder' in data) file.folder = data.folder;
  if ('extension' in data) file.extension = data.extension;
  if ('is_public' in data) file.is_public = data.is_public;
  file.updated_at = _now();

  res.json({ file });
});

app.delete('/api/v1/projects/:projectId/files/:fileId', async (req, res) => {
  const { projectId, fileId } = req.params;
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (SUPABASE_URL && SUPABASE_ANON_KEY && token && token !== 'demo-token') {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/files?id=eq.${fileId}&project_id=eq.${projectId}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`
        }
      });
    } catch (e) {
      console.warn('Supabase delete file error');
    }
  }

  const fIndex = inMemoryFiles.findIndex((f) => f.id === fileId && f.project_id === projectId);
  if (fIndex > -1) inMemoryFiles.splice(fIndex, 1);

  res.json({ status: 'deleted' });
});

app.post('/api/v1/projects/:projectId/files/:fileId/copy', async (req, res) => {
  const { projectId, fileId } = req.params;
  const original = inMemoryFiles.find((f) => f.id === fileId && f.project_id === projectId);

  if (!original) {
    return res.status(404).json({ detail: 'Source file not found' });
  }

  const copyFile: NoteFile = {
    id: `nt_${randomHex(12)}`,
    user_id: original.user_id,
    project_id: projectId,
    title: `Copy of ${original.title}`,
    content: original.content,
    folder: original.folder,
    extension: original.extension,
    is_public: false,
    created_at: _now(),
    updated_at: _now()
  };

  inMemoryFiles.unshift(copyFile);
  res.status(201).json({ file: copyFile });
});

// ==========================================
// DEVELOPER API KEYS
// ==========================================
app.get('/api/v1/developer/keys', (req, res) => {
  res.json({ keys: inMemoryKeys });
});

app.post('/api/v1/developer/keys', (req, res) => {
  const { name } = req.body || {};
  const newKey: ApiKey = {
    id: `key_${randomHex(8)}`,
    user_id: 'demo_user',
    name: name || 'Untitled Key',
    key: `vex_live_${randomHex(24)}`,
    is_active: true,
    created_at: _now()
  };
  inMemoryKeys.unshift(newKey);
  res.status(201).json({ key: newKey });
});

app.delete('/api/v1/developer/keys/:keyId', (req, res) => {
  const { keyId } = req.params;
  const kIndex = inMemoryKeys.findIndex((k) => k.id === keyId);
  if (kIndex > -1) inMemoryKeys.splice(kIndex, 1);
  res.json({ status: 'deleted' });
});

// ==========================================
// GEMINI AI CHAT ENDPOINT
// ==========================================
app.post('/api/v1/ai/chat', async (req, res) => {
  const { message, context } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ detail: 'Message string is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      detail: 'Gemini API key is not configured. Please add GEMINI_API_KEY to your environment variables.'
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    
    let systemInstruction = 'You are Vex AI, an intelligent personal assistant for the Vex networked thought platform. You help users organize notes, synthesize complex ideas, summarize thoughts, write code and math equations, and answer queries concisely.';
    
    if (context) {
      systemInstruction += `\n\nCurrent note context:\n${context}`;
    }

    const response = await ai.models.generateContent({
      model: modelName,
      contents: message,
      config: {
        systemInstruction
      }
    });

    res.json({ reply: response.text || 'No response generated.' });
  } catch (error: any) {
    console.error('Gemini API Error:', error);
    res.status(500).json({ detail: error.message || 'Error communicating with Gemini AI' });
  }
});

// 404 Fallback for unhandled routes
app.use((req, res) => {
  renderHtmlTemplate('404.html', res);
});

app.listen(PORT, HOST, () => {
  console.log(`Vex server listening on http://${HOST}:${PORT}`);
});
