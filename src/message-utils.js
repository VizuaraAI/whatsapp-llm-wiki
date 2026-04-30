export function unwrapMessage(message) {
  let current = message;

  if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message;
  if (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message;
  if (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;

  return current || {};
}

export function extractText(rawMessage) {
  const message = unwrapMessage(rawMessage);

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    ''
  ).trim();
}

export function getMediaMessageType(rawMessage) {
  const message = unwrapMessage(rawMessage);

  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage) return 'document';
  if (message.stickerMessage) return 'sticker';

  return null;
}

export function getDocumentName(rawMessage, fallback) {
  const message = unwrapMessage(rawMessage);

  return (
    message.documentMessage?.fileName ||
    message.imageMessage?.mimetype?.replace('/', '.') ||
    message.videoMessage?.mimetype?.replace('/', '.') ||
    message.audioMessage?.mimetype?.replace('/', '.') ||
    fallback
  );
}

export function isGroupJid(jid = '') {
  return jid.endsWith('@g.us');
}

