import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { formidable } from 'formidable';
import { paths } from './paths.js';

const port = Number(process.env.PORT || 4173);

await fs.mkdir(paths.manualUploadsDir, { recursive: true });
await ensureJsonArray(paths.manualResourcesFile);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendFile(res, paths.siteIndex);
    }

    if (req.method === 'GET' && url.pathname === '/api/resources') {
      const resources = JSON.parse(await fs.readFile(paths.manualResourcesFile, 'utf8'));
      return sendJson(res, dedupeResources(resources));
    }

    if (req.method === 'POST' && url.pathname === '/api/resources') {
      const saved = await saveManualResource(req);
      return sendJson(res, saved, 201);
    }

    const candidate = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    const staticPath = path.join(paths.root, candidate);
    if (staticPath.startsWith(paths.root) && fsSync.existsSync(staticPath)) {
      return sendFile(res, staticPath);
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(error.stack || error.message);
  }
});

server.listen(port, () => {
  console.log(`Wiki site running at http://localhost:${port}`);
});

async function saveManualResource(req) {
  const form = formidable({
    multiples: false,
    uploadDir: paths.manualUploadsDir,
    keepExtensions: true,
    maxFileSize: 50 * 1024 * 1024,
  });

  const [fields, files] = await form.parse(req);
  const file = Array.isArray(files.file) ? files.file[0] : files.file;
  const title = first(fields.title)?.trim() || file?.originalFilename || 'Untitled resource';
  const description = first(fields.description)?.trim() || '';
  const url = first(fields.url)?.trim() || '';

  let storedFile = null;
  if (file?.filepath && file?.originalFilename) {
    const safeName = `${Date.now()}-${sanitizeFileName(file.originalFilename)}`;
    const target = path.join(paths.manualUploadsDir, safeName);
    await fs.rename(file.filepath, target);
    storedFile = {
      path: `data/manual-uploads/${safeName}`,
      type: inferType(safeName),
    };
  }

  if (!storedFile?.path && !url && !description) {
    throw new Error('Add a URL, a file, or a description.');
  }

  const resource = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    description,
    url,
    type: storedFile?.type || (url ? 'link' : 'note'),
    path: storedFile?.path || url,
    date: new Date().toISOString().slice(0, 10),
    source: 'manual',
  };

  const existing = JSON.parse(await fs.readFile(paths.manualResourcesFile, 'utf8'));
  const resources = dedupeResources([resource, ...existing.map(normalizeResource)]);
  await fs.writeFile(paths.manualResourcesFile, `${JSON.stringify(resources, null, 2)}\n`);
  return resource;
}

async function sendFile(res, filePath) {
  const body = await fs.readFile(filePath);
  res.writeHead(200, { 'content-type': mime(filePath) });
  res.end(body);
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function ensureJsonArray(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, '[]\n');
  }
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._ -]+/g, '-').slice(0, 160);
}

function inferType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (ext === '.pdf') return 'pdf';
  return 'file';
}

function dedupeResources(resources) {
  const seen = new Set();
  return resources
    .map(normalizeResource)
    .filter((resource) => resource && (
      String(resource.title || '').trim() ||
      String(resource.description || '').trim() ||
      String(resource.url || '').trim() ||
      String(resource.path || '').trim()
    ))
    .filter((resource) => {
      const key = [resource.url || '', resource.path || '', resource.title || ''].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeResource(resource) {
  if (!resource || typeof resource !== 'object') return null;
  const normalized = {
    ...resource,
    title: String(resource.title || '').trim(),
    description: String(resource.description || '').trim(),
    url: String(resource.url || '').trim(),
    path: String(resource.path || '').trim(),
    type: String(resource.type || '').trim() || 'link',
  };
  if (!normalized.title || normalized.title === 'Untitled resource') {
    normalized.title = titleFromValue(normalized.url || normalized.path || normalized.description);
  }
  return normalized;
}

function titleFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.hostname.replace(/^www\./, '') || 'Resource';
  } catch {
    const file = decodeURIComponent(text.split('/').filter(Boolean).pop() || text);
    return file.replace(/^\d+-/, '').replace(/[_-]+/g, ' ').slice(0, 90);
  }
}

function mime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
  }[ext] || 'application/octet-stream';
}
