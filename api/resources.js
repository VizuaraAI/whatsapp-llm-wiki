import { put, list } from '@vercel/blob';
import { formidable } from 'formidable';
import fs from 'node:fs/promises';

const indexPath = 'manual-resources/index.json';

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'GET') {
      return res.status(200).json(dedupeResources((await readResources()).map(normalizeResource)));
    }

    if (req.method !== 'POST') {
      res.setHeader('allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const contentType = req.headers['content-type'] || '';
    const parsed = contentType.includes('application/json')
      ? { fields: await readJson(req), files: {} }
      : await readMultipart(req);

    const fields = parsed.fields;
    const files = parsed.files;
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    const title = String(first(fields.title) || file?.originalFilename || 'Untitled resource').trim();
    const description = String(first(fields.description) || '').trim();
    const url = String(first(fields.url) || '').trim();

    let pathValue = url;
    let type = url ? 'link' : 'note';

    if (file?.filepath && file?.size > 0) {
      const safeName = `${Date.now()}-${sanitizeFileName(file.originalFilename || 'upload')}`;
      const body = await fs.readFile(file.filepath);
      const blob = await put(`manual-uploads/${safeName}`, body, {
        access: 'public',
        addRandomSuffix: false,
        contentType: file.mimetype || undefined,
      });
      pathValue = blob.url;
      type = inferType(safeName);
    }

    if (!title && !pathValue && !description) {
      return res.status(400).json({ error: 'Add a URL, a file, or a description.' });
    }

    const resource = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title,
      description,
      url,
      type,
      path: pathValue,
      date: new Date().toISOString().slice(0, 10),
      source: 'manual',
    };

    const resources = dedupeResources([resource, ...(await readResources()).map(normalizeResource).filter(hasResourceContent)]);
    await put(indexPath, JSON.stringify(resources, null, 2), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return res.status(201).json(resource);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readResources() {
  const blobs = await list({ prefix: indexPath, limit: 1 });
  const blob = blobs.blobs.find((item) => item.pathname === indexPath);
  if (!blob) return [];
  const response = await fetch(blob.url);
  if (!response.ok) return [];
  return response.json();
}

async function readMultipart(req) {
  const [fields, files] = await formidable({
    multiples: false,
    maxFileSize: 50 * 1024 * 1024,
  }).parse(req);
  return { fields, files };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._ -]+/g, '-').slice(0, 160);
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function hasResourceContent(resource) {
  return Boolean(resource && (
    String(resource.title || '').trim() ||
    String(resource.description || '').trim() ||
    String(resource.url || '').trim() ||
    String(resource.path || '').trim()
  ));
}

function dedupeResources(resources) {
  const seen = new Set();
  return resources.map(normalizeResource).filter(hasResourceContent).filter((resource) => {
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

function inferType(fileName) {
  const ext = fileName.toLowerCase().split('.').pop();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return 'file';
}
