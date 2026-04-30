import fs from 'node:fs/promises';
import { paths } from './paths.js';

export async function ensureStorage() {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.mediaDir, { recursive: true });
  await fs.mkdir(paths.wikiDir, { recursive: true });
}

export async function appendMessage(record) {
  await ensureStorage();
  await fs.appendFile(paths.messagesFile, `${JSON.stringify(record)}\n`);
}

export async function readMessages(limit = 250) {
  try {
    const body = await fs.readFile(paths.messagesFile, 'utf8');
    const rows = body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return rows.slice(-limit);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readAllMessages() {
  return readMessages(Number.MAX_SAFE_INTEGER);
}
