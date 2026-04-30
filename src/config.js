import 'dotenv/config';

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  whatsappGroupJids: splitCsv(process.env.WHATSAPP_GROUP_JIDS),
  ingestAllGroups: process.env.INGEST_ALL_GROUPS === 'true',
  downloadMedia: process.env.DOWNLOAD_MEDIA !== 'false',
  wikiBatchSize: Number.parseInt(process.env.WIKI_BATCH_SIZE || '250', 10),
  autoUpdateWiki: process.env.AUTO_UPDATE_WIKI !== 'false',
  wikiUpdateEveryMessages: Number.parseInt(process.env.WIKI_UPDATE_EVERY_MESSAGES || '20', 10),
};

function splitCsv(value = '') {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
