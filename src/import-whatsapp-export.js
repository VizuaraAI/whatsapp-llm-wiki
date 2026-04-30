import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { paths } from './paths.js';
import { appendMessage, ensureStorage, readAllMessages } from './storage.js';

const inputPath = process.argv[2];
const groupName = process.argv[3] || process.env.IMPORT_GROUP_NAME || 'Historical WhatsApp Export';
const groupJid = process.env.IMPORT_GROUP_JID || 'historical-whatsapp-export@g.us';

if (!inputPath) {
  console.error('Usage: npm run import:whatsapp -- "/absolute/path/to/_chat.txt" ["Group Name"]');
  process.exit(1);
}

await ensureStorage();

const absolutePath = path.resolve(inputPath);
const exportDir = path.dirname(absolutePath);
const body = await fs.readFile(absolutePath, 'utf8');
const parsed = parseWhatsAppExport(body);
const existing = new Set((await readAllMessages()).map((message) => message.id));
const exportedMediaDir = path.join(paths.mediaDir, 'exported');
await fs.mkdir(exportedMediaDir, { recursive: true });

let imported = 0;
let skipped = 0;
let copiedMedia = 0;
for (const item of parsed) {
  if (!item.text.trim()) continue;
  const id = stableId(item);

  if (existing.has(id)) {
    skipped += 1;
    continue;
  }

  const media = await copyAttachedMedia(item, exportDir, exportedMediaDir);
  copiedMedia += media.length;

  await appendMessage({
    id,
    groupJid,
    groupName,
    sender: item.sender,
    timestamp: Math.floor(item.date.getTime() / 1000),
    isoTime: item.date.toISOString(),
    text: cleanText(item.text),
    media: media[0] || null,
    mediaItems: media,
    source: 'whatsapp-export',
  });
  imported += 1;
  existing.add(id);
}

console.log(`Imported ${imported} messages from ${absolutePath}`);
console.log(`Skipped ${skipped} already-imported messages. Copied ${copiedMedia} media file(s).`);

function parseWhatsAppExport(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const messages = [];
  let current = null;

  for (const line of lines) {
    const parsed = parseLine(line);

    if (parsed) {
      if (current) messages.push(current);
      current = parsed;
      continue;
    }

    if (current) {
      current.text += `\n${line}`;
    }
  }

  if (current) messages.push(current);
  return messages;
}

function parseLine(line) {
  line = line.replace(/^[\u200e\u200f\s]+/, '');
  const bracket = line.match(/^\[(.+?)\]\s([^:]+?):\s([\s\S]*)$/);
  if (bracket) {
    const date = parseExportDate(bracket[1]);
    if (date) return { date, sender: bracket[2].trim(), text: bracket[3] };
  }

  const plain = line.match(/^(.+?)\s-\s([^:]+?):\s([\s\S]*)$/);
  if (plain) {
    const date = parseExportDate(plain[1]);
    if (date) return { date, sender: plain[2].trim(), text: plain[3] };
  }

  return null;
}

function parseExportDate(value) {
  const normalized = value
    .trim()
    .replace(/\u202f/g, ' ')
    .replace(/\s+/g, ' ');

  const match = normalized.match(
    /^(\d{1,4})[/. -](\d{1,2})[/. -](\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/
  );

  if (!match) return null;

  const first = Number(match[1]);
  const second = Number(match[2]);
  let year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const secondValue = Number(match[6] || 0);
  const meridiem = match[7]?.toUpperCase();

  if (year < 100) year += year >= 70 ? 1900 : 2000;

  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;

  const { day, month } = inferDayMonth(first, second);
  const date = new Date(year, month - 1, day, hour, minute, secondValue);

  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function inferDayMonth(first, second) {
  if (first > 12) return { day: first, month: second };
  if (second > 12) return { day: second, month: first };

  // WhatsApp exports in India commonly use day/month/year.
  return { day: first, month: second };
}

function stableId(item) {
  return crypto
    .createHash('sha256')
    .update(`${item.date.toISOString()}\n${item.sender}\n${item.text}`)
    .digest('hex')
    .slice(0, 24);
}

async function copyAttachedMedia(item, exportDir, mediaDir) {
  const attachments = [...item.text.matchAll(/<attached:\s*([^>]+)>/g)].map((match) => match[1].trim());
  const copied = [];

  for (const fileName of attachments) {
    const source = path.join(exportDir, fileName);
    const targetName = sanitizeFileName(fileName);
    const target = path.join(mediaDir, targetName);

    try {
      await fs.copyFile(source, target);
      copied.push({
        type: inferMediaType(targetName),
        fileName: targetName,
        originalFileName: fileName,
        path: target,
        relativePath: `data/media/exported/${targetName}`,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      copied.push({
        type: 'missing',
        fileName,
        originalFileName: fileName,
        path: source,
        relativePath: '',
      });
    }
  }

  return copied;
}

function cleanText(text) {
  return text
    .replace(/\u200e/g, '')
    .replace(/<attached:\s*[^>]+>/g, '')
    .replace(/<This message was edited>/g, '')
    .trim();
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._ -]+/g, '-').slice(0, 180);
}

function inferMediaType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension)) return 'image';
  if (['.mp4', '.mov', '.webm'].includes(extension)) return 'video';
  if (extension === '.pdf') return 'pdf';
  return 'file';
}
