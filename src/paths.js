import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  root,
  authDir: path.join(root, 'auth'),
  dataDir: path.join(root, 'data'),
  mediaDir: path.join(root, 'data', 'media'),
  qrFile: path.join(root, 'data', 'whatsapp-qr.png'),
  messagesFile: path.join(root, 'data', 'messages.jsonl'),
  wikiDir: path.join(root, 'wiki'),
  siteDir: path.join(root, 'site'),
  siteDataFile: path.join(root, 'data', 'site-data.json'),
  siteIndex: path.join(root, 'site', 'index.html'),
  rootIndex: path.join(root, 'index.html'),
  manualResourcesFile: path.join(root, 'data', 'manual-resources.json'),
  manualUploadsDir: path.join(root, 'data', 'manual-uploads'),
  mediaCaptionsFile: path.join(root, 'data', 'media-captions.json'),
  homePage: path.join(root, 'wiki', 'Home.md'),
  importantPage: path.join(root, 'wiki', 'Important Discussions.md'),
};
