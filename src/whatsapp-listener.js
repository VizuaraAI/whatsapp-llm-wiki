import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import { config } from './config.js';
import { paths } from './paths.js';
import { appendMessage, ensureStorage } from './storage.js';
import {
  extractText,
  getDocumentName,
  getMediaMessageType,
  isGroupJid,
} from './message-utils.js';

await ensureStorage();

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const { state, saveCreds } = await useMultiFileAuthState(paths.authDir);
const { version } = await fetchLatestBaileysVersion();
let ingestedSinceWikiUpdate = 0;
let wikiUpdateRunning = false;

const sock = makeWASocket({
  auth: state,
  logger,
  printQRInTerminal: false,
  version,
  browser: ['Inference Wiki Bot', 'Chrome', '1.0.0'],
});

sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
  if (qr) {
    console.log('\nScan this QR in WhatsApp: Settings -> Linked Devices -> Link a Device\n');
    qrcode.generate(qr, { small: true });
    QRCode.toFile(paths.qrFile, qr, {
      margin: 2,
      scale: 10,
      errorCorrectionLevel: 'M',
    })
      .then(() => console.log(`QR image saved to ${paths.qrFile}`))
      .catch((error) => console.error('Failed to save QR image:', error));
  }

  if (connection === 'open') {
    console.log('WhatsApp linked. Waiting for group messages...');
    printGroupPolicy();
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const message = lastDisconnect?.error?.message || 'unknown error';
    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
    console.log(`WhatsApp connection closed. Status: ${statusCode || 'unknown'}. Reason: ${message}. Reconnect: ${shouldReconnect}`);

    if (shouldReconnect) {
      console.log('Run npm run whatsapp again to reconnect.');
    }
  }
});

sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return;

  for (const message of messages) {
    try {
      await handleMessage(message);
    } catch (error) {
      console.error('Failed to handle message:', error);
    }
  }
});

async function handleMessage(message) {
  const remoteJid = message.key.remoteJid;
  if (!isGroupJid(remoteJid)) return;

  const allowed =
    config.ingestAllGroups || config.whatsappGroupJids.includes(remoteJid);

  const groupName = await getGroupName(remoteJid);

  if (!allowed) {
    console.log(`Saw group "${groupName}" (${remoteJid}). Add this JID to WHATSAPP_GROUP_JIDS to ingest it.`);
    return;
  }

  const text = extractText(message.message);
  const mediaType = getMediaMessageType(message.message);
  const sender = message.key.participant || message.participant || remoteJid;
  const timestamp = Number(message.messageTimestamp || Math.floor(Date.now() / 1000));
  const id = message.key.id;
  const media = mediaType && config.downloadMedia
    ? await saveMedia(message, mediaType, timestamp)
    : null;

  if (!text && !media) return;

  const record = {
    id,
    groupJid: remoteJid,
    groupName,
    sender,
    timestamp,
    isoTime: new Date(timestamp * 1000).toISOString(),
    text,
    media,
  };

  await appendMessage(record);
  scheduleWikiUpdate();
  console.log(`Ingested ${groupName}: ${text || media?.fileName || mediaType}`);
}

async function getGroupName(jid) {
  try {
    const metadata = await sock.groupMetadata(jid);
    return metadata.subject || jid;
  } catch {
    return jid;
  }
}

async function saveMedia(message, mediaType, timestamp) {
  const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {},
    { logger, reuploadRequest: sock.updateMediaMessage }
  );

  const safeName = sanitizeFileName(
    getDocumentName(message.message, `${message.key.id}.${mediaType}`)
  );
  const fileName = `${timestamp}-${message.key.id}-${safeName}`;
  const filePath = path.join(paths.mediaDir, fileName);

  await fs.writeFile(filePath, buffer);

  return {
    type: mediaType,
    fileName,
    path: filePath,
  };
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 160);
}

function printGroupPolicy() {
  if (config.ingestAllGroups) {
    console.log('INGEST_ALL_GROUPS=true, so all group messages visible to this WhatsApp account will be ingested.');
    return;
  }

  if (config.whatsappGroupJids.length === 0) {
    console.log('No WHATSAPP_GROUP_JIDS set yet. I will print discovered group IDs but not ingest them.');
    return;
  }

  console.log(`Watching ${config.whatsappGroupJids.length} WhatsApp group(s).`);
}

function scheduleWikiUpdate() {
  if (!config.autoUpdateWiki) return;

  ingestedSinceWikiUpdate += 1;
  if (ingestedSinceWikiUpdate < config.wikiUpdateEveryMessages) return;
  if (wikiUpdateRunning) return;

  ingestedSinceWikiUpdate = 0;
  wikiUpdateRunning = true;

  const child = spawn(process.execPath, ['src/wiki-updater.js'], {
    cwd: paths.root,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code) => {
    wikiUpdateRunning = false;
    if (code !== 0) {
      console.error(`Wiki update failed with exit code ${code}.`);
    }
  });
}
