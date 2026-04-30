import fs from 'node:fs/promises';
import OpenAI from 'openai';
import { config } from './config.js';
import { paths } from './paths.js';
import { readMessages, ensureStorage } from './storage.js';

await ensureStorage();

const messages = await readMessages(config.wikiBatchSize);

if (messages.length === 0) {
  console.log('No messages found yet. Start npm run whatsapp and send a group message first.');
  process.exit(0);
}

if (!config.openaiApiKey) {
  await writeFallbackWiki(messages);
  console.log('OPENAI_API_KEY is not set. Wrote a basic non-LLM wiki from recent messages.');
  process.exit(0);
}

const openai = new OpenAI({ apiKey: config.openaiApiKey });
const transcript = messages.map(formatMessage).join('\n');

const completion = await openai.chat.completions.create({
  model: config.openaiModel,
  temperature: 0.2,
  messages: [
    {
      role: 'system',
      content: [
        'You maintain a concise technical wiki for an inference engineering workshop WhatsApp group.',
        'Extract durable knowledge, decisions, unresolved questions, resources, and important discussions.',
        'Do not invent facts. Use the provided messages only.',
        'Return JSON with keys homeMarkdown and importantMarkdown.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Update the wiki from these recent messages:\n\n${transcript}`,
    },
  ],
  response_format: { type: 'json_object' },
});

const content = completion.choices[0]?.message?.content || '{}';
const parsed = JSON.parse(content);

await fs.writeFile(paths.homePage, ensureTitle(parsed.homeMarkdown, 'Inference Workshop Wiki'));
await fs.writeFile(paths.importantPage, ensureTitle(parsed.importantMarkdown, 'Important Discussions'));

console.log(`Updated wiki from ${messages.length} messages.`);

function formatMessage(message) {
  const resource = message.media ? ` [resource: ${message.media.fileName}]` : '';
  return `- ${message.isoTime} | ${message.groupName} | ${message.sender}: ${message.text}${resource}`;
}

function ensureTitle(markdown = '', title) {
  const trimmed = markdown.trim();
  if (trimmed.startsWith('# ')) return `${trimmed}\n`;
  return `# ${title}\n\n${trimmed}\n`;
}

async function writeFallbackWiki(recentMessages) {
  const lines = recentMessages.slice(-50).map((message) => {
    const resource = message.media ? ` ([${message.media.fileName}](${message.media.path}))` : '';
    return `- ${message.isoTime} - ${message.sender}: ${message.text || 'Shared a resource'}${resource}`;
  });

  await fs.writeFile(
    paths.homePage,
    `# Inference Workshop Wiki\n\n## Recent Messages\n\n${lines.join('\n')}\n`
  );
  await fs.writeFile(
    paths.importantPage,
    `# Important Discussions\n\nLLM summarization is not configured yet. Add OPENAI_API_KEY to generate this page automatically.\n`
  );
}

