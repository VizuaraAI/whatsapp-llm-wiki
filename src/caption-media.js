import fs from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { config } from './config.js';
import { paths } from './paths.js';

if (!config.openaiApiKey) {
  console.error('OPENAI_API_KEY is required to caption media.');
  process.exit(1);
}

const client = new OpenAI({ apiKey: config.openaiApiKey });
const captions = await readCaptions();
const files = await fs.readdir(path.join(paths.mediaDir, 'exported'));
const imageFiles = files.filter((file) => /\.(jpe?g|png|webp)$/i.test(file));

let added = 0;
for (const fileName of imageFiles) {
  if (captions[fileName]) continue;

  const filePath = path.join(paths.mediaDir, 'exported', fileName);
  const bytes = await fs.readFile(filePath);
  const mimeType = mime(fileName);
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;

  const response = await client.chat.completions.create({
    model: config.openaiModel,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: 'Name WhatsApp-shared workshop media. Return JSON only: {"title": "...", "description": "...", "tags": ["..."]}. Use concise descriptive titles. Do not identify people in photos.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Create a useful resource title for this image/screenshot/notes page. Focus on visible technical content, not file names.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  });

  captions[fileName] = JSON.parse(response.choices[0]?.message?.content || '{}');
  added += 1;
  console.log(`Captioned ${fileName}: ${captions[fileName].title || 'untitled'}`);
  await fs.writeFile(paths.mediaCaptionsFile, `${JSON.stringify(captions, null, 2)}\n`);
}

console.log(`Captioned ${added} new media file(s). Total captions: ${Object.keys(captions).length}`);

async function readCaptions() {
  try {
    return JSON.parse(await fs.readFile(paths.mediaCaptionsFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function mime(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
