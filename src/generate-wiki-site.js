import fs from 'node:fs/promises';
import OpenAI from 'openai';
import { config } from './config.js';
import { paths } from './paths.js';
import { ensureStorage, readAllMessages } from './storage.js';

await ensureStorage();
await fs.mkdir(paths.siteDir, { recursive: true });
await fs.mkdir(paths.manualUploadsDir, { recursive: true });

const allMessages = await readAllMessages();
const messages = normalizeMessages(allMessages);
const mediaCaptions = await readMediaCaptions();
const media = collectMedia(messages, mediaCaptions);
const fallback = buildFallbackData(messages, media);
const manualResources = await readManualResources();

let data = fallback;

if (config.openaiApiKey) {
  try {
    data = await buildLlmData(messages, media, fallback);
  } catch (error) {
    console.error(`LLM wiki generation failed, using deterministic fallback: ${error.message}`);
  }
}

if (!data.topics?.length || data.topics.length < 5) {
  data.topics = mergeByName(data.topics || [], fallback.topics);
}
data.topics = polishTopics(mergeByName(data.topics || [], fallback.topics));
data.importantDiscussions = polishDiscussions(data.importantDiscussions || [], data.topics);
data.resources = cleanResources([...(data.resources || []), ...manualResources], media);
data.graph = normalizeGraph(data.graph, data.topics, data.resources);
data.title = 'Vizuara Inference Engineering Wiki Group';
data.subtitle = 'An LLM wiki created for group discussions. Indexed daily.';

await fs.writeFile(paths.siteDataFile, `${JSON.stringify(data, null, 2)}\n`);
await writeMarkdown(data);
await writeLlmWiki(data);
const html = renderHtml(data);
await fs.writeFile(paths.siteIndex, html);
await fs.writeFile(paths.rootIndex, html);

console.log(`Built wiki site from ${messages.length} messages and ${media.length} media item(s).`);
console.log(`Open ${paths.siteIndex}`);

function normalizeMessages(rows) {
  const seen = new Set();
  return rows
    .filter((message) => message?.text || message?.media || message?.mediaItems?.length)
    .filter((message) => !isLowValueSystemMessage(message.text || ''))
    .map((message) => ({
      ...message,
      text: scrubText(message.text || ''),
      sender: scrubSender(message.sender || 'Unknown'),
      date: (message.isoTime || '').slice(0, 10),
    }))
    .filter((message) => {
      const key = `${message.isoTime}|${message.sender}|${message.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.isoTime || '').localeCompare(b.isoTime || ''));
}

function isLowValueSystemMessage(text) {
  return /joined using a group link|Messages and calls are end-to-end encrypted|created group|This message was deleted/i.test(text);
}

function scrubText(text) {
  return text
    .replace(/\u200e/g, '')
    .replace(/<This message was edited>/g, '')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]')
    .trim();
}

function scrubSender(sender) {
  return sender
    .replace(/^~/, '')
    .replace(/\u202f/g, ' ')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, 'Participant')
    .trim();
}

function collectMedia(rows, captions = {}) {
  return rows.flatMap((message) => {
    const items = message.mediaItems?.length ? message.mediaItems : message.media ? [message.media] : [];
    return items
      .filter((item) => item?.relativePath)
      .map((item) => ({
        ...item,
        sender: message.sender,
        date: message.date,
        caption: captions[item.fileName]?.title || meaningfulCaption(message.text, item.fileName),
        generatedTitle: captions[item.fileName]?.title,
        generatedDescription: captions[item.fileName]?.description,
        generatedTags: captions[item.fileName]?.tags || [],
      }));
  });
}

function meaningfulCaption(text, fileName) {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim();
  if (cleaned && !/^<attached/i.test(cleaned)) return cleaned;
  return fileName;
}

async function buildLlmData(rows, mediaItems, fallbackData) {
  const client = new OpenAI({ apiKey: config.openaiApiKey });
  const transcript = rows.map(formatForPrompt).join('\n').slice(0, 180000);
  const mediaList = mediaItems.map((item) => `${item.date} | ${item.type} | ${item.fileName} | ${item.caption || 'no caption'}`).join('\n').slice(0, 25000);

  const response = await client.chat.completions.create({
    model: config.openaiModel,
    temperature: 0.15,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You are building a high-signal LLM inference engineering wiki from a WhatsApp workshop export.',
          'Create durable knowledge, not a chat summary. Preserve technical nuance.',
          'Do not expose phone numbers. Do not invent resources. Use only the transcript and media list.',
          'Return strict JSON. Keep values concise but specific.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Return JSON with this shape:
{
  "title": string,
  "subtitle": string,
  "overview": string,
  "metrics": [{"label": string, "value": string}],
  "dailySummaries": [{"date": "YYYY-MM-DD", "summary": string, "highlights": [string]}],
  "topics": [{"name": string, "summary": string, "takeaways": [string], "questions": [string], "resources": [string], "related": [string]}],
  "importantDiscussions": [{"title": string, "date": string, "summary": string, "whyItMatters": string, "nextAction": string}],
  "resources": [{"title": string, "type": string, "path": string, "description": string, "date": string}],
  "openQuestions": [string],
  "graph": {"nodes": [{"id": string, "label": string, "type": "topic"|"resource"|"question"|"event"}], "edges": [{"source": string, "target": string, "label": string}]}
}

Use these fallback metrics if useful: ${JSON.stringify(fallbackData.metrics)}.

Transcript:
${transcript}

Media list:
${mediaList}`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
  const resources = mergeResources(parsed.resources || [], mediaItems);
  return {
    ...fallbackData,
    ...parsed,
    metrics: parsed.metrics?.length ? parsed.metrics : fallbackData.metrics,
    resources,
    graph: normalizeGraph(parsed.graph, parsed.topics || fallbackData.topics, resources),
    generatedAt: new Date().toISOString(),
  };
}

function buildFallbackData(rows, mediaItems) {
  const topicSeeds = [
    ['KV Cache', /kv cache|cache pruning|caching/i, 'The group repeatedly discussed how inference reuses key/value tensors across generated tokens, why KV caching changes the compute profile, and how pruning or better cache management could reduce memory pressure.'],
    ['FLOPs and Memory Math', /flops|memory|bytes|gpu|vram|bandwidth|70b|quant/i, 'Participants worked through how to compute FLOPs and bytes moved for transformer operations, connecting matrix shapes, precision, quantization, memory bandwidth, and practical GPU sizing.'],
    ['Tensor Parallelism', /tensor parallel|sharding|heads|mha|mhla|5-d parallelism/i, 'Questions around heads, latent vectors, MHA/MHLA, and sharding converged on tensor parallelism: how attention heads and tensor slices are distributed across accelerators.'],
    ['Edge Inference', /edge|raspberry|rubik|npu|tpu|local inference/i, 'The group explored local and edge inference on Raspberry Pi, Mac, Rubik Pi, consumer GPUs, and small models, with emphasis on practical constraints like RAM, model size, and latency.'],
    ['AI Chips', /chip|hardware|tpu|npu|systolic|taalas|broadcom/i, 'The hardware thread connected NPUs, TPUs, systolic arrays, custom model chips, and AI chip design to inference economics and performance per cost.'],
    ['Workshop Logistics', /dashboard|recording|zoom|class|lecture|session/i, 'Operational messages covered dashboard access, lecture recordings, PDFs, Zoom links, optional sessions, and coordination for live classes and meetups.'],
    ['Startup and Product Ideas', /yc|startup|harvey|abridge|founder|product/i, 'The group discussed YC-style company ideas, legal and healthcare AI examples such as Harvey and Abridge, and the gap between a working model demo and a grounded product.'],
  ];

  const topics = topicSeeds.map(([name, pattern, summary]) => {
    const hits = rows.filter((message) => pattern.test(message.text));
    return {
      name,
      summary,
      takeaways: hits.slice(-3).map((message) => message.text.slice(0, 180)),
      questions: hits.filter((message) => message.text.includes('?')).slice(-3).map((message) => message.text.slice(0, 180)),
      resources: [],
      related: [],
    };
  }).filter((topic) => topic.takeaways.length || topic.questions.length);

  const byDate = groupBy(rows, (message) => message.date);
  const dailySummaries = Object.entries(byDate).map(([date, items]) => ({
    date,
    summary: `${items.length} relevant message(s), including discussion around ${topTerms(items).slice(0, 4).join(', ')}.`,
    highlights: items.slice(-4).map((message) => message.text.slice(0, 160)),
  }));

  const resources = mergeResources([], mediaItems);
  return {
    title: 'Vizuara Inference Engineering Workshop Wiki',
    subtitle: 'Living memory for discussions, resources, questions, and technical connections from the WhatsApp group.',
    overview: 'The group is converging around practical LLM inference: KV cache mechanics, FLOPs and memory accounting, parallelism, edge deployment, AI chips, workshop logistics, and startup/product applications.',
    metrics: [
      { label: 'Messages Indexed', value: String(rows.length) },
      { label: 'Media Resources', value: String(mediaItems.length) },
      { label: 'Topics Detected', value: String(topics.length) },
      { label: 'Date Range', value: `${rows[0]?.date || '-'} to ${rows.at(-1)?.date || '-'}` },
    ],
    dailySummaries,
    topics,
    importantDiscussions: topics.slice(0, 5).map((topic) => ({
      title: topic.name,
      date: rows.at(-1)?.date || '',
      summary: topic.summary,
      whyItMatters: 'This thread is directly tied to understanding and operating LLM inference systems.',
      nextAction: 'Convert into a durable explainer and attach the best resources.',
    })),
    resources,
    openQuestions: topics.flatMap((topic) => topic.questions).slice(0, 10),
    graph: normalizeGraph(null, topics, resources),
    generatedAt: new Date().toISOString(),
  };
}

function formatForPrompt(message) {
  const media = message.mediaItems?.length ? ` [media: ${message.mediaItems.map((item) => item.fileName).join(', ')}]` : '';
  return `${message.isoTime} | ${message.sender}: ${message.text}${media}`;
}

function mergeResources(llmResources, mediaItems) {
  const fromMedia = mediaItems.map((item) => ({
    title: item.caption || item.fileName,
    type: item.type,
    path: item.relativePath,
    description: item.generatedDescription || item.caption || `Shared ${item.type}: ${item.fileName}`,
    date: item.date,
    tags: item.generatedTags || [],
  }));

  const seen = new Set();
  return [...llmResources, ...fromMedia]
    .filter((item) => item?.title || item?.path || item?.url || item?.description)
    .map((item) => ({
      title: item.title || item.path,
      type: item.type || 'link',
      path: item.path || '',
      description: item.description || '',
      date: item.date || '',
    }))
    .filter((item) => {
      const key = `${item.title}|${item.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 80);
}

function cleanResources(resources, mediaItems = []) {
  const byFileName = new Map(mediaItems.map((item) => [item.fileName, item.relativePath]));
  const seen = new Set();
  return resources
    .map((resource) => ({
      ...resource,
      title: cleanResourceTitle(resource.title || resource.path || 'Shared resource'),
      path: normalizeResourcePath(resource.path || '', byFileName),
      description: (resource.description || '').replace(/\n+/g, ' ').slice(0, 220),
    }))
    .filter((resource) => hasResourceContent(resource))
    .filter((resource) => {
      const key = `${resource.title}|${resource.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function hasResourceContent(resource) {
  const title = String(resource.title || '').trim();
  const pathValue = String(resource.path || '').trim();
  const url = String(resource.url || '').trim();
  const description = String(resource.description || '').trim();
  return Boolean((title && title !== 'Shared resource') || pathValue || url || description);
}

function normalizeResourcePath(resourcePath, byFileName) {
  if (!resourcePath) return '';
  if (resourcePath.startsWith('data/')) return resourcePath;
  return byFileName.get(resourcePath) || resourcePath;
}

function cleanResourceTitle(title) {
  const single = String(title).replace(/\n+/g, ' ').replace(/\[[^\]]+\]\s*[^:]+:/g, '').trim();
  if (single.length <= 90) return single;
  return `${single.slice(0, 87).trim()}...`;
}

function mergeByName(primary, secondary) {
  const byName = new Map();
  for (const item of [...primary, ...secondary]) {
    if (!item?.name) continue;
    const key = item.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, item);
    }
  }
  return [...byName.values()];
}

function polishTopics(topics) {
  const curated = {
    'KV Cache': {
      name: 'KV Cache',
      summary: 'The group is trying to understand why autoregressive inference stores keys and values from previous tokens, how that changes latency and memory usage, and when cache pruning becomes necessary.',
      details: 'During generation, each new token attends to all previous tokens. Without a KV cache, the model would repeatedly recompute key and value vectors for the full prefix. KV caching saves those tensors once and reuses them, which turns a lot of repeated compute into a memory-management problem. The practical implication is that long contexts and many concurrent users can become limited by KV cache memory rather than model weights alone.',
      takeaways: [
        'KV cache reduces repeated computation during decoding but consumes memory proportional to layers, heads, head dimension, sequence length, batch size, and precision.',
        'KV cache pruning is interesting because not every previous token is equally useful forever; pruning tries to preserve quality while reducing cache memory.',
        'For production serving, KV cache management is tied to context length, batching strategy, latency targets, and GPU memory pressure.',
      ],
      questions: [
        'Which KV cache pruning techniques preserve answer quality best for long-context workloads?',
        'How should cache memory be budgeted for multiple simultaneous users?',
      ],
      related: ['FLOPs and Memory Math', 'Batch Inference', 'Tensor Parallelism'],
    },
    'FLOPs and Memory Math': {
      name: 'FLOPs and Memory Math',
      summary: 'Participants are working out how to estimate compute and memory for transformer inference from first principles: matrix shapes, precision, bytes moved, and hardware bandwidth.',
      details: 'A recurring thread is that model serving cannot be understood only by parameter count. You need to estimate both arithmetic work and memory movement. For a matrix multiply A(n,d) @ B(d,m), the rough FLOPs are 2*n*d*m. For memory, each tensor read or written costs element_count times bytes_per_element. In inference, especially token-by-token decoding, memory bandwidth and KV cache movement often dominate perceived latency.',
      takeaways: [
        'FLOPs estimate arithmetic work; bytes moved estimates pressure on memory bandwidth.',
        'Precision matters: fp16/bf16 are usually 2 bytes per value, int8 is 1 byte, and int4 is half a byte for weights, though runtime kernels may pack/unpack differently.',
        'A useful sizing estimate includes model weights, KV cache, activations/workspace, concurrent users, and target context length.',
      ],
      questions: [
        'How do we calculate GPU memory for a 70B model under different quantization schemes?',
        'When does serving become memory-bound rather than compute-bound?',
      ],
      related: ['KV Cache', 'Batch Inference', 'AI Chips'],
    },
    'Tensor Parallelism': {
      name: 'Tensor Parallelism',
      summary: 'The group discussed how attention heads, weight matrices, and latent vectors are split across GPUs when a model is too large or too slow for one accelerator.',
      details: 'Tensor parallelism slices large tensor operations across multiple devices. In attention, different heads or matrix partitions can live on different GPUs, with collective communication used to combine results. The practical challenge is that newer architectures such as MHA variants, MQA/GQA, or latent-attention designs may not split as cleanly as a simple “one head per GPU” mental model.',
      takeaways: [
        'Parallelism is not just about fitting weights; communication overhead can dominate if partitions require frequent synchronization.',
        'Attention heads can often be split, but shared latent representations or projection matrices may need replication or collective operations.',
        'The Ultra-Scale Playbook and classic Megatron-style tensor parallelism paper are useful references for this thread.',
      ],
      questions: [
        'How does MHLA/MLA change the clean head-splitting story?',
        'Which tensors must be replicated versus sharded in practical serving systems?',
      ],
      related: ['FLOPs and Memory Math', 'KV Cache', 'AI Chips'],
    },
    'Batch Inference': {
      name: 'Batch vs Continuous Inference',
      summary: 'The group distinguished offline batch APIs from continuous batching inside an inference server, which are often confused but solve different problems.',
      details: 'Offline batch inference means submitting many independent jobs and accepting delayed results, often at lower cost. Continuous batching is a serving-runtime technique where requests from multiple users are dynamically grouped during decoding to improve GPU utilization while still returning interactive responses. The second is central to vLLM-style production serving.',
      takeaways: [
        'Batch API pricing and continuous batching are different ideas.',
        'Continuous batching converts many single-user decode steps into larger GPU-friendly operations.',
        'The tradeoff is scheduling complexity, fairness, memory management, and latency control.',
      ],
      questions: [
        'How do schedulers decide which requests join a decode batch?',
        'How do prefill and decode phases interact under continuous batching?',
      ],
      related: ['KV Cache', 'FLOPs and Memory Math'],
    },
    'Edge Inference': {
      name: 'Edge Inference',
      summary: 'The group explored what can realistically run on local devices such as Raspberry Pi, Rubik Pi, Macs, phones, and small GPUs.',
      details: 'Edge inference is attractive when latency, privacy, offline availability, or device integration matter. But the constraints are tight: RAM, thermal limits, supported kernels, model size, and input modality determine what is feasible. The discussion included YOLO-style vision models, pose detection, small language models, Raspberry Pi memory choices, and cloud GPU fallback options.',
      takeaways: [
        'Small vision and audio models are often more realistic on edge devices than large LLMs.',
        'RAM matters as much as raw compute for local model experiments.',
        'Hybrid designs can run perception locally and delegate heavier reasoning to cloud models.',
      ],
      questions: [
        'Which workshop projects are best suited for edge deployment?',
        'When should a prototype use local inference versus rented GPUs?',
      ],
      related: ['AI Chips', 'FLOPs and Memory Math', 'Startup and Product Ideas'],
    },
    'AI Chips': {
      name: 'AI Chips and Accelerators',
      summary: 'Participants compared GPUs, TPUs, NPUs, systolic arrays, and custom chips in terms of inference throughput, cost, latency, and deployment setting.',
      details: 'The hardware thread moves beyond “which GPU?” into accelerator architecture. TPUs and many NPUs are optimized for tensor operations; systolic arrays can improve performance per watt/cost for certain workloads. Custom model chips are compelling for fixed architectures but trade flexibility for speed and efficiency.',
      takeaways: [
        'GPUs are flexible and broadly supported; specialized accelerators can win on cost or power for narrower workloads.',
        'TPUs/NPUs are not just faster GPUs; their memory hierarchy and execution model affect what workloads fit well.',
        'Custom chips may make sense when the model and use case are stable enough to justify reduced flexibility.',
      ],
      questions: [
        'What workloads justify custom inference silicon?',
        'How do accelerator memory systems affect transformer serving?',
      ],
      related: ['Edge Inference', 'FLOPs and Memory Math'],
    },
    'Workshop Logistics': {
      name: 'Workshop Logistics',
      summary: 'The group uses WhatsApp to coordinate recordings, dashboards, PDFs, optional sessions, guest speakers, meetups, and access issues.',
      details: 'A large fraction of the group traffic is operational: where recordings live, which Zoom link to use, whether a class is optional, and how to access PDFs or dashboards. This should be kept separate from the technical wiki so learners can quickly find either course logistics or concept explanations.',
      takeaways: [
        'Dashboard links and recording availability are recurring support topics.',
        'Optional sessions and guest speakers need clearer calendar visibility.',
        'Regional meetups, especially Bay Area, are emerging as community coordination threads.',
      ],
      questions: [
        'Should logistics be split into a separate page from technical discussions?',
        'Can dashboard/recording links be pinned in a stable resource section?',
      ],
      related: ['Resources'],
    },
    'Startup and Product Ideas': {
      name: 'Startup and Product Ideas',
      summary: 'The group connected inference engineering to company ideas: YC applications, Harvey/Abridge-style vertical AI, edge AI products, and productization of technical demos.',
      details: 'A useful thread is the distinction between a model demo and a business. Participants discussed legal AI, healthcare AI, edge devices, retail inventory, and founder execution. The inference angle is that latency, cost, reliability, and grounding determine whether an AI feature becomes a usable product.',
      takeaways: [
        'Vertical AI products need domain grounding, accuracy, workflow integration, and trust.',
        'Inference cost and latency can directly shape whether a product is viable.',
        'Edge AI ideas become stronger when tied to a concrete user pain and deployment constraint.',
      ],
      questions: [
        'Which workshop ideas are strong enough for YC-style applications?',
        'Where does inference engineering create a defensible product advantage?',
      ],
      related: ['Edge Inference', 'AI Chips'],
    },
  };

  const byName = new Map();
  for (const topic of topics) {
    const key = normalizeTopicName(topic.name);
    const base = curated[key] || curated[topic.name] || topic;
    byName.set(base.name || topic.name, {
      ...topic,
      ...base,
      takeaways: base.takeaways || sanitizeList(topic.takeaways),
      questions: base.questions || sanitizeList(topic.questions),
      related: base.related || topic.related || [],
    });
  }
  for (const topic of Object.values(curated)) byName.set(topic.name, topic);
  return [...byName.values()].slice(0, 9);
}

function normalizeTopicName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('kv')) return 'KV Cache';
  if (lower.includes('flop') || lower.includes('memory')) return 'FLOPs and Memory Math';
  if (lower.includes('tensor') || lower.includes('parallel')) return 'Tensor Parallelism';
  if (lower.includes('batch')) return 'Batch Inference';
  if (lower.includes('edge')) return 'Edge Inference';
  if (lower.includes('chip') || lower.includes('accelerator')) return 'AI Chips';
  if (lower.includes('logistic') || lower.includes('workshop')) return 'Workshop Logistics';
  if (lower.includes('startup') || lower.includes('yc') || lower.includes('product')) return 'Startup and Product Ideas';
  return name;
}

function sanitizeList(items = []) {
  return items
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter((item) => item && item.length > 24)
    .map((item) => (item.length > 160 ? `${item.slice(0, 157)}...` : item))
    .slice(0, 3);
}

function polishDiscussions(discussions, topics) {
  const existing = discussions.map((discussion) => ({
    ...discussion,
    summary: String(discussion.summary || '').replace(/\s+/g, ' ').trim(),
  })).filter((discussion) => discussion.title && discussion.summary);

  const topicDiscussions = topics.slice(0, 5).map((topic) => ({
    title: topic.name,
    date: '2026-04-30',
    summary: topic.summary,
    whyItMatters: topic.details || topic.summary,
    nextAction: `Turn this into an explainer page with linked resources and examples for ${topic.name}.`,
  }));

  const byTitle = new Map();
  for (const item of [...existing, ...topicDiscussions]) {
    const key = String(item.title || '').toLowerCase();
    if (key && !byTitle.has(key)) byTitle.set(key, item);
  }
  return [...byTitle.values()].slice(0, 6);
}

function normalizeGraph(graph, topics, resources) {
  if (graph?.nodes?.length >= topics.length && graph?.edges?.length >= Math.max(3, topics.length - 1)) return graph;

  const nodes = topics.map((topic) => ({ id: slug(topic.name), label: topic.name, type: 'topic' }));
  const resourceNodes = resources.slice(0, 12).map((resource) => ({ id: slug(resource.title), label: resource.title.slice(0, 42), type: 'resource' }));
  const edges = [];

  for (let index = 1; index < nodes.length; index += 1) {
    edges.push({ source: nodes[0].id, target: nodes[index].id, label: 'related' });
  }

  for (const resource of resourceNodes) {
    const target = nodes.find((node) => resource.label.toLowerCase().includes(node.label.toLowerCase().split(' ')[0])) || nodes[0];
    if (target) edges.push({ source: target.id, target: resource.id, label: 'resource' });
  }

  return { nodes: [...nodes, ...resourceNodes], edges };
}

async function writeMarkdown(data) {
  const home = [
    `# ${data.title}`,
    '',
    data.overview,
    '',
    '## Topics',
    ...data.topics.map((topic) => `- **${topic.name}**: ${topic.summary}`),
    '',
    '## Open Questions',
    ...data.openQuestions.map((question) => `- ${question}`),
  ].join('\n');

  const important = [
    '# Important Discussions',
    '',
    ...data.importantDiscussions.map((discussion) => [
      `## ${discussion.title}`,
      `Date: ${discussion.date}`,
      '',
      discussion.summary,
      '',
      `Why it matters: ${discussion.whyItMatters}`,
      '',
      `Next action: ${discussion.nextAction}`,
      '',
    ].join('\n')),
  ].join('\n');

  const resources = [
    '# Resources',
    '',
    ...data.resources.map((resource) => `- **${resource.title}** (${resource.type}) ${resource.path ? `- ${resource.path}` : ''}\n  ${resource.description}`),
  ].join('\n');

  await fs.writeFile(paths.homePage, `${home}\n`);
  await fs.writeFile(paths.importantPage, `${important}\n`);
  await fs.writeFile(`${paths.wikiDir}/Resources.md`, `${resources}\n`);
}

async function writeLlmWiki(data) {
  const dirs = ['concepts', 'discussions', 'resources', 'sources'];
  for (const dir of dirs) {
    await fs.mkdir(`${paths.wikiDir}/${dir}`, { recursive: true });
  }

  const conceptPages = data.topics.map((topic) => ({
    file: `concepts/${slug(topic.name)}.md`,
    title: topic.name,
    summary: topic.summary,
  }));
  const discussionPages = data.importantDiscussions.map((discussion) => ({
    file: `discussions/${slug(discussion.title)}.md`,
    title: discussion.title,
    summary: discussion.summary,
  }));
  const resourcePages = data.resources.slice(0, 50).map((resource) => ({
    file: `resources/${slug(resource.title)}.md`,
    title: resource.title,
    summary: resource.description || resource.path || resource.type,
  }));

  await fs.writeFile(`${paths.wikiDir}/index.md`, [
    '# Index',
    '',
    'This is the maintained LLM wiki index. The generated dashboard is a viewing layer; these Markdown pages are the durable knowledge base.',
    '',
    '## Concepts',
    ...conceptPages.map((page) => `- [[${page.file.replace(/\.md$/, '')}|${page.title}]] - ${page.summary}`),
    '',
    '## Discussions',
    ...discussionPages.map((page) => `- [[${page.file.replace(/\.md$/, '')}|${page.title}]] - ${page.summary}`),
    '',
    '## Resources',
    ...resourcePages.map((page) => `- [[${page.file.replace(/\.md$/, '')}|${page.title}]] - ${page.summary}`),
    '',
  ].join('\n'));

  await fs.appendFile(`${paths.wikiDir}/log.md`, [
    `## [${new Date().toISOString().slice(0, 10)}] ingest | WhatsApp group sync`,
    '',
    `- Indexed ${data.metrics.find((metric) => metric.label.includes('Messages'))?.value || 'unknown'} messages.`,
    `- Indexed ${data.metrics.find((metric) => metric.label.includes('Media'))?.value || 'unknown'} media resources.`,
    `- Updated ${conceptPages.length} concept pages, ${discussionPages.length} discussion pages, and ${resourcePages.length} resource pages.`,
    '',
  ].join('\n'));

  for (const topic of data.topics) {
    const related = (topic.related || []).map((name) => `[[concepts/${slug(name)}|${name}]]`).join(', ') || 'None yet';
    await fs.writeFile(`${paths.wikiDir}/concepts/${slug(topic.name)}.md`, [
      `# ${topic.name}`,
      '',
      '## Synthesis',
      topic.summary,
      '',
      '## Takeaways',
      ...(topic.takeaways || []).map((item) => `- ${item}`),
      '',
      '## Questions',
      ...(topic.questions || []).map((item) => `- ${item}`),
      '',
      '## Resources',
      ...(topic.resources || []).map((item) => `- ${item}`),
      '',
      '## Related',
      related,
      '',
    ].join('\n'));
  }

  for (const discussion of data.importantDiscussions) {
    await fs.writeFile(`${paths.wikiDir}/discussions/${slug(discussion.title)}.md`, [
      `# ${discussion.title}`,
      '',
      `Date: ${discussion.date}`,
      '',
      '## Summary',
      discussion.summary,
      '',
      '## Why It Matters',
      discussion.whyItMatters,
      '',
      '## Next Action',
      discussion.nextAction,
      '',
    ].join('\n'));
  }

  for (const resource of data.resources.slice(0, 50)) {
    await fs.writeFile(`${paths.wikiDir}/resources/${slug(resource.title)}.md`, [
      `# ${resource.title}`,
      '',
      `Type: ${resource.type}`,
      `Date: ${resource.date || 'Unknown'}`,
      resource.path ? `Path: ${resource.path}` : '',
      '',
      '## Notes',
      resource.description || 'Shared in the WhatsApp group.',
      '',
    ].filter(Boolean).join('\n'));
  }

  await fs.writeFile(`${paths.wikiDir}/sources/whatsapp-export.md`, [
    '# WhatsApp Export',
    '',
    'Immutable source: exported WhatsApp chat plus copied media files.',
    '',
    `Generated ingest timestamp: ${new Date().toISOString()}`,
    '',
    'The source export itself remains outside the generated wiki. Message records are stored in `data/messages.jsonl` and media in `data/media/exported/`.',
    '',
  ].join('\n'));
}

function renderHtmlLegacy(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(data.title)}</title>
  <style>
    :root { --bg:#050509; --fg:#fafafa; --muted:#a1a1aa; --card:#0d0d13; --line:#27272a; --gold:#ffd78a; --sky:#8ad4ff; --pink:#ffa8ff; --blue:#1e96e6; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Figtree, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at 20% 0%, rgba(30,150,230,.18), transparent 28%), radial-gradient(circle at 85% 5%, rgba(255,168,255,.13), transparent 24%), var(--bg); color:var(--fg); selection-background:var(--blue); }
    a { color:inherit; }
    .shell { width:min(1400px, calc(100% - 40px)); margin:0 auto; }
    .hero { min-height:72vh; display:grid; align-items:end; padding:56px 0 32px; border-bottom:1px solid rgba(255,255,255,.08); position:relative; overflow:hidden; }
    .hero:before { content:""; position:absolute; inset:-20%; background:linear-gradient(120deg, rgba(251,176,59,.10), rgba(46,170,225,.08), rgba(249,6,249,.09)); filter:blur(30px); transform:rotate(-6deg); }
    .hero-inner { position:relative; display:grid; gap:24px; }
    .eyebrow { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.12em; }
    h1 { margin:0; font-size:clamp(44px, 7vw, 104px); line-height:.95; letter-spacing:0; max-width:1100px; }
    .gradient { background:linear-gradient(to right, var(--gold), var(--sky), var(--pink)); -webkit-background-clip:text; background-clip:text; color:transparent; }
    .subtitle { max-width:900px; color:#d4d4d8; font-size:clamp(18px, 2vw, 26px); line-height:1.45; }
    .metrics { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; margin-top:18px; }
    .metric, .card { background:linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.025)); border:1px solid rgba(255,255,255,.10); border-radius:8px; box-shadow:0 18px 60px rgba(0,0,0,.22); }
    .metric { padding:16px; }
    .metric strong { display:block; font-size:28px; }
    .metric span { color:var(--muted); font-size:13px; }
    .section { padding:42px 0; }
    .section-head { display:flex; justify-content:space-between; align-items:end; gap:20px; margin-bottom:18px; }
    h2 { margin:0; font-size:32px; }
    .grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px; }
    .card { padding:18px; min-height:150px; position:relative; overflow:hidden; }
    .card:before { content:""; position:absolute; inset:0; border-top:2px solid transparent; border-image:linear-gradient(to right, var(--gold), var(--sky), var(--pink)) 1; opacity:.75; pointer-events:none; }
    .card h3 { margin:0 0 10px; font-size:19px; }
    .card p, .card li { color:#d4d4d8; line-height:1.5; }
    .card ul { padding-left:18px; margin:10px 0 0; }
    .timeline { display:grid; gap:12px; }
    .day { display:grid; grid-template-columns:120px 1fr; gap:16px; padding:16px 0; border-top:1px solid rgba(255,255,255,.08); }
    .date { color:var(--sky); font-weight:700; }
    .resources { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px; }
    .resource { padding:0; overflow:hidden; }
    .resource-body { padding:12px; }
    .thumb { width:100%; aspect-ratio:16/10; object-fit:cover; background:#111; display:block; border-bottom:1px solid rgba(255,255,255,.08); }
    .pdf-thumb { display:grid; place-items:center; aspect-ratio:16/10; color:#0b0b10; background:linear-gradient(to right, var(--gold), var(--sky), var(--pink)); font-weight:800; }
    .graph-wrap { height:560px; padding:0; }
    svg { width:100%; height:100%; display:block; }
    .pill { display:inline-flex; align-items:center; border:1px solid rgba(255,255,255,.12); border-radius:999px; padding:6px 10px; color:#d4d4d8; font-size:12px; }
    .footer { color:var(--muted); padding:28px 0 48px; border-top:1px solid rgba(255,255,255,.08); }
    @media (max-width: 900px) { .metrics, .grid, .resources { grid-template-columns:1fr; } .day { grid-template-columns:1fr; } .hero { min-height:auto; } }
  </style>
</head>
<body>
  <main id="app"></main>
  <script>window.WIKI_DATA = ${json};</script>
  <script>
    const data = window.WIKI_DATA;
    const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const assetUrl = (p='') => p.startsWith('http') ? p : '/' + p;
    const media = (r) => {
      if (!r.path) return '<div class="pdf-thumb">LINK</div>';
      if (r.type === 'image') return '<img class="thumb" src="../' + esc(r.path) + '" alt="' + esc(r.title) + '">';
      if (r.type === 'video') return '<video class="thumb" src="../' + esc(r.path) + '" controls muted></video>';
      if (r.type === 'pdf') return '<a href="../' + esc(r.path) + '"><div class="pdf-thumb">PDF</div></a>';
      return '<div class="pdf-thumb">FILE</div>';
    };
    document.getElementById('app').innerHTML = \`
      <section class="hero"><div class="shell hero-inner">
        <div class="eyebrow">WhatsApp Knowledge Graph · Updated \${esc(new Date(data.generatedAt).toLocaleString())}</div>
        <h1><span class="gradient">\${esc(data.title)}</span></h1>
        <div class="subtitle">\${esc(data.subtitle || data.overview)}</div>
        <div class="metrics">\${(data.metrics||[]).map(m => '<div class="metric"><strong>'+esc(m.value)+'</strong><span>'+esc(m.label)+'</span></div>').join('')}</div>
      </div></section>
      <section class="section shell"><div class="section-head"><h2 class="gradient">Signal Summary</h2><span class="pill">Living wiki from group discussion</span></div><div class="card"><p>\${esc(data.overview)}</p></div></section>
      <section class="section shell"><div class="section-head"><h2>Topic Wiki</h2><span class="pill">\${(data.topics||[]).length} nodes</span></div><div class="grid">\${(data.topics||[]).map(t => '<article class="card"><h3>'+esc(t.name)+'</h3><p>'+esc(t.summary)+'</p><ul>'+((t.takeaways||[]).slice(0,3).map(x=>'<li>'+esc(x)+'</li>').join(''))+'</ul></article>').join('')}</div></section>
      <section class="section shell"><div class="section-head"><h2 class="gradient">Important Discussions</h2></div><div class="grid">\${(data.importantDiscussions||[]).map(d => '<article class="card"><h3>'+esc(d.title)+'</h3><p>'+esc(d.summary)+'</p><p><strong>Why:</strong> '+esc(d.whyItMatters)+'</p><p><strong>Next:</strong> '+esc(d.nextAction)+'</p></article>').join('')}</div></section>
      <section class="section shell"><div class="section-head"><h2>Connection Graph</h2><span class="pill">Topics · resources · questions</span></div><div class="card graph-wrap"><svg id="graph"></svg></div></section>
      <section class="section shell"><div class="section-head"><h2 class="gradient">Resources & Media</h2><span class="pill">\${(data.resources||[]).length} indexed</span></div><div class="resources">\${(data.resources||[]).slice(0,32).map(r => '<article class="card resource">'+media(r)+'<div class="resource-body"><h3>'+esc(r.title).slice(0,90)+'</h3><p>'+esc(r.description).slice(0,180)+'</p></div></article>').join('')}</div></section>
      <section class="section shell"><div class="section-head"><h2>Daily Timeline</h2></div><div class="timeline">\${(data.dailySummaries||[]).map(d => '<div class="day"><div class="date">'+esc(d.date)+'</div><div><p>'+esc(d.summary)+'</p><ul>'+((d.highlights||[]).slice(0,4).map(h=>'<li>'+esc(h)+'</li>').join(''))+'</ul></div></div>').join('')}</div></section>
      <footer class="shell footer">Generated from local WhatsApp export and live message log. Phone numbers are redacted in generated summaries.</footer>
    \`;
    drawGraph(data.graph || {nodes:[], edges:[]});
    function drawGraph(graph) {
      const svg = document.getElementById('graph');
      const w = svg.clientWidth || 1000, h = svg.clientHeight || 560;
      const nodes = (graph.nodes || []).slice(0, 36).map((n,i) => ({...n, x:w/2 + Math.cos(i)*80, y:h/2 + Math.sin(i)*80}));
      const edges = (graph.edges || []).filter(e => nodes.find(n=>n.id===e.source) && nodes.find(n=>n.id===e.target));
      for (let tick=0; tick<180; tick++) {
        for (const a of nodes) for (const b of nodes) if (a!==b) {
          const dx=a.x-b.x, dy=a.y-b.y, dist=Math.max(24, Math.hypot(dx,dy)); const f=260/(dist*dist);
          a.x += dx/dist*f; a.y += dy/dist*f;
        }
        for (const e of edges) {
          const a=nodes.find(n=>n.id===e.source), b=nodes.find(n=>n.id===e.target); const dx=b.x-a.x, dy=b.y-a.y, dist=Math.max(1, Math.hypot(dx,dy)); const f=(dist-160)*.012;
          a.x += dx/dist*f; a.y += dy/dist*f; b.x -= dx/dist*f; b.y -= dy/dist*f;
        }
        for (const n of nodes) { n.x += (w/2-n.x)*.01; n.y += (h/2-n.y)*.01; n.x=Math.max(80,Math.min(w-80,n.x)); n.y=Math.max(50,Math.min(h-50,n.y)); }
      }
      svg.innerHTML = '<defs><linearGradient id="g"><stop offset="0%" stop-color="#ffd78a"/><stop offset="50%" stop-color="#8ad4ff"/><stop offset="100%" stop-color="#ffa8ff"/></linearGradient></defs>' +
        edges.map(e => { const a=nodes.find(n=>n.id===e.source), b=nodes.find(n=>n.id===e.target); return '<line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke="rgba(255,255,255,.18)" />'; }).join('') +
        nodes.map(n => '<g><circle cx="'+n.x+'" cy="'+n.y+'" r="'+(n.type==='topic'?12:8)+'" fill="url(#g)"/><text x="'+(n.x+14)+'" y="'+(n.y+4)+'" fill="#f4f4f5" font-size="12">'+esc(n.label)+'</text></g>').join('');
    }
  </script>
</body>
</html>`;
}

function groupBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item) || 'Unknown';
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});
}

function topTerms(items) {
  const stop = new Set('the and for that this with from are was you have what how can will class group message using link'.split(' '));
  const counts = {};
  for (const item of items) {
    for (const word of item.text.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []) {
      if (!stop.has(word)) counts[word] = (counts[word] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([word]) => word);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'node';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function readManualResources() {
  try {
    const body = await fs.readFile(paths.manualResourcesFile, 'utf8');
    return JSON.parse(body).map((resource) => ({
      ...resource,
      source: 'manual',
    }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readMediaCaptions() {
  try {
    return JSON.parse(await fs.readFile(paths.mediaCaptionsFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function renderHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(data.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#ffffff; --fg:#18181b; --muted:#71717a; --soft:#f4f4f5; --card:#ffffff; --line:#e4e4e7; --gold:#ffd78a; --sky:#8ad4ff; --pink:#ffa8ff; --blue:#1e96e6; --shadow:0 10px 30px rgba(24,24,27,.06); }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Figtree, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-weight:300; background:var(--bg); color:var(--fg); selection-background:var(--blue); }
    a { color:inherit; text-decoration:none; }
    button, input, textarea { font:inherit; }
    .shell { width:min(1180px, calc(100% - 56px)); margin:0 auto; }
    .nav { position:sticky; top:0; z-index:10; background:rgba(255,255,255,.86); backdrop-filter:blur(18px); border-bottom:1px solid var(--line); }
    .nav-inner { height:64px; display:flex; align-items:center; justify-content:space-between; gap:18px; }
    .brand { display:flex; align-items:center; gap:10px; font-weight:520; letter-spacing:-.01em; }
    .logo { width:30px; height:30px; object-fit:contain; border-radius:7px; }
    .nav-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .btn { border:1px solid var(--line); background:#fff; color:var(--fg); border-radius:8px; padding:9px 13px; font-weight:430; cursor:pointer; transition:160ms ease; box-shadow:0 1px 0 rgba(0,0,0,.02); }
    .btn:hover { border-color:#c8c8cf; box-shadow:var(--shadow); transform:translateY(-1px); }
    .btn.primary { border:0; background:linear-gradient(to right,var(--gold),var(--sky),var(--pink)); color:#18181b; font-weight:560; }
    .hero { padding:76px 0 36px; background:linear-gradient(180deg,#fff 0%,#fbfbfd 100%); border-bottom:1px solid var(--line); }
    .eyebrow { color:var(--muted); font-size:12px; font-weight:500; text-transform:uppercase; letter-spacing:.12em; margin-bottom:16px; }
    h1 { margin:0; max-width:900px; font-size:clamp(46px,6vw,78px); line-height:.98; letter-spacing:0; font-weight:650; }
    .gradient { background:linear-gradient(to right,var(--gold),var(--sky),var(--pink)); -webkit-background-clip:text; background-clip:text; color:transparent; }
    .subtitle { max-width:780px; margin-top:20px; color:#52525b; font-size:20px; line-height:1.55; font-weight:300; }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-top:34px; }
    .metric, .card, .panel { background:var(--card); border:1px solid var(--line); border-radius:8px; box-shadow:var(--shadow); }
    .metric { padding:18px; }
    .metric strong { display:block; font-size:30px; letter-spacing:-.03em; font-weight:560; }
    .metric span { color:var(--muted); font-size:13px; font-weight:400; }
    .section { padding:44px 0; }
    .section-head { display:flex; justify-content:space-between; align-items:flex-end; gap:20px; margin-bottom:18px; }
    h2 { margin:0; font-size:30px; letter-spacing:-.02em; font-weight:560; }
    h3 { margin:0 0 9px; font-size:17px; letter-spacing:-.01em; font-weight:520; }
    p { margin:0; }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
    .card { padding:18px; min-height:132px; }
    .card p, .card li { color:#52525b; line-height:1.55; font-size:14px; }
    .card ul { padding-left:18px; margin:12px 0 0; }
    .topic-card { border-top:3px solid transparent; border-image:linear-gradient(to right,var(--gold),var(--sky),var(--pink)) 1; }
    .summary-card { padding:24px; font-size:18px; line-height:1.6; color:#3f3f46; }
    .pill { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:7px 11px; color:var(--muted); font-size:12px; font-weight:400; background:#fff; }
    .resources { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
    .resource { padding:0; overflow:hidden; min-height:0; }
    .resource-link { display:block; height:100%; }
    .resource:hover { transform:translateY(-1px); box-shadow:0 14px 36px rgba(24,24,27,.08); }
    .resource-url { display:inline-flex; margin-top:10px; color:#1e96e6; font-size:13px; }
    .thumb-frame { position:relative; aspect-ratio:16/9; overflow:hidden; border-bottom:1px solid var(--line); background:linear-gradient(135deg,rgba(255,215,138,.55),rgba(138,212,255,.45),rgba(255,168,255,.42)); }
    .thumb { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
    .thumb-fallback, .generated-thumb, .pdf-thumb { display:grid; place-items:center; aspect-ratio:16/9; padding:18px; color:#18181b; background:linear-gradient(135deg,rgba(255,215,138,.55),rgba(138,212,255,.45),rgba(255,168,255,.42)); border-bottom:1px solid var(--line); font-weight:520; text-align:center; }
    .thumb-frame .thumb-fallback { position:absolute; inset:0; aspect-ratio:auto; border-bottom:0; background:transparent; }
    .resource-body { padding:14px; }
    .timeline { display:grid; gap:0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#fff; box-shadow:var(--shadow); }
    .day { display:grid; grid-template-columns:130px 1fr; gap:20px; padding:18px; border-top:1px solid var(--line); }
    .day:first-child { border-top:0; }
    .date { color:#0f78bf; font-weight:520; }
    .graph-card { padding:0; overflow:hidden; }
    .graph-toolbar { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:12px; border-bottom:1px solid var(--line); background:#fafafa; }
    .graph-controls { display:flex; gap:8px; }
    .graph-wrap { height:620px; cursor:grab; background:linear-gradient(180deg,#fff,#fbfbfd); }
    .graph-wrap:active { cursor:grabbing; }
    svg { width:100%; height:100%; display:block; touch-action:none; }
    .modal { position:fixed; inset:0; display:none; align-items:center; justify-content:center; z-index:40; background:rgba(24,24,27,.32); padding:24px; }
    .modal.open { display:flex; }
    .modal-card { width:min(560px,100%); background:#fff; border:1px solid var(--line); border-radius:12px; box-shadow:0 24px 90px rgba(0,0,0,.18); padding:20px; }
    .form { display:grid; gap:12px; margin-top:16px; }
    label { display:grid; gap:6px; color:#3f3f46; font-weight:430; font-size:13px; }
    input, textarea { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:#fff; color:var(--fg); outline:none; }
    input:focus, textarea:focus { border-color:#8ad4ff; box-shadow:0 0 0 3px rgba(138,212,255,.24); }
    input[type=file] { position:absolute; inline-size:1px; block-size:1px; opacity:0; pointer-events:none; }
    .upload-control { border:1px dashed #c7c7d1; border-radius:8px; padding:18px; background:#fafafa; display:flex; align-items:center; justify-content:space-between; gap:14px; cursor:pointer; transition:160ms ease; }
    .upload-control:hover { border-color:#8ad4ff; background:#f7fbff; }
    .upload-control span { color:#52525b; font-size:14px; }
    .upload-icon { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; background:linear-gradient(135deg,rgba(255,215,138,.7),rgba(138,212,255,.55),rgba(255,168,255,.55)); }
    .form-row { display:flex; justify-content:flex-end; gap:10px; margin-top:8px; }
    .footer { color:var(--muted); padding:32px 0 56px; border-top:1px solid var(--line); }
    @media (max-width:900px) { .shell{width:min(100% - 32px,1180px)} .metrics,.grid,.resources{grid-template-columns:1fr} .day{grid-template-columns:1fr} .nav-inner{height:auto;padding:12px 0;align-items:flex-start;flex-direction:column} }
  </style>
</head>
<body>
  <main id="app"></main>
  <div class="modal" id="resourceModal" aria-hidden="true">
    <div class="modal-card">
      <div class="section-head" style="margin-bottom:0"><div><h2>Add resource</h2><p class="muted">Stored locally in data/manual-resources.json and data/manual-uploads/.</p></div><button class="btn" id="closeModal" type="button">Close</button></div>
      <form class="form" id="resourceForm">
        <label>Title<input name="title" required placeholder="KV cache pruning paper"></label>
        <label>Description<textarea name="description" rows="3" placeholder="Why this resource matters"></textarea></label>
        <label>URL<input name="url" type="url" placeholder="https://..."></label>
        <label>File upload
          <span class="upload-control" id="uploadControl"><span id="fileLabel">Choose a PDF, image, video, or notes file</span><span class="upload-icon">↑</span></span>
          <input id="fileInput" name="file" type="file">
        </label>
        <div class="form-row"><button class="btn" type="button" id="cancelModal">Cancel</button><button class="btn primary" type="submit">Save resource</button></div>
      </form>
    </div>
  </div>
  <div class="modal" id="topicModal" aria-hidden="true">
    <div class="modal-card">
      <div class="section-head" style="margin-bottom:12px"><div><h2 id="topicTitle">Topic</h2><p class="muted" id="topicSummary"></p></div><button class="btn" id="closeTopicModal" type="button">Close</button></div>
      <div id="topicDetails" class="summary-card" style="box-shadow:none;border:1px solid var(--line);font-size:15px"></div>
    </div>
  </div>
  <script>window.WIKI_DATA = ${json};</script>
  <script>
    let data = window.WIKI_DATA;
    const RESOURCE_CACHE_KEY = 'vizuara-manual-resources-v1';
    const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const assetUrl = (p='') => p.startsWith('http') ? p : '/' + p;
    const byId = (id) => document.getElementById(id);
    const fileNameFromPath = (value='') => {
      try {
        const url = value.startsWith('http') ? new URL(value) : null;
        const pathname = url ? url.pathname : value;
        return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
      } catch { return String(value).split('/').filter(Boolean).pop() || ''; }
    };
    const labelFromResource = (r={}) => {
      const title = String(r.title || '').trim();
      if (title && title !== 'Untitled resource') return title;
      const description = String(r.description || '').trim();
      if (description) return description.split(/[.!?]/)[0].slice(0, 80);
      const value = String(r.url || r.path || '').trim();
      if (!value) return '';
      try {
        const url = new URL(value);
        return url.hostname.replace(/^www\\./, '') || 'Resource';
      } catch {
        return fileNameFromPath(value).replace(/^\\d+-/, '').replace(/[_-]+/g, ' ') || 'Resource';
      }
    };
    const compactLabel = (label='Resource') => esc(String(label || 'Resource').split(' ').slice(0, 5).join(' '));
    const resourceThumb = (r) => {
      const label = labelFromResource(r) || 'Resource';
      if (r.path && r.type === 'image') return '<div class="thumb-frame"><div class="thumb-fallback">' + compactLabel(label) + '</div><img class="thumb" src="' + esc(assetUrl(r.path)) + '" alt="' + esc(label) + '" loading="lazy" onerror="this.remove()"></div>';
      if (r.path && r.type === 'video') return '<div class="thumb-frame"><div class="thumb-fallback">' + compactLabel(label) + '</div><video class="thumb" src="' + esc(assetUrl(r.path)) + '" controls muted></video></div>';
      if (r.path && r.type === 'pdf') return '<div class="pdf-thumb">PDF · ' + compactLabel(label) + '</div>';
      return '<div class="generated-thumb">' + compactLabel(label) + '</div>';
    };
    const renderResourceCard = (r) => {
      if (!hasVisibleResource(r)) return '';
      const href = resourceHref(r);
      const title = labelFromResource(r) || 'Resource';
      const description = String(r.description || '').trim();
      const inner = resourceThumb({ ...r, title }) + '<div class="resource-body"><h3>' + esc(title).slice(0,92) + '</h3>' + (description ? '<p>' + esc(description).slice(0,220) + '</p>' : '') + (href ? '<span class="resource-url">Open resource</span>' : '') + '</div>';
      return '<article class="card resource">' + (href ? '<a class="resource-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>' : inner) + '</article>';
    };
    const readResourceCache = () => {
      try { return dedupeResources(JSON.parse(localStorage.getItem(RESOURCE_CACHE_KEY) || '[]')); } catch { return []; }
    };
    const writeResourceCache = (resources) => {
      try { localStorage.setItem(RESOURCE_CACHE_KEY, JSON.stringify(dedupeResources(resources).slice(0, 120))); } catch {}
    };
    function render() {
      data.resources = dedupeResources(data.resources || []);
      byId('app').innerHTML = \`
        <nav class="nav"><div class="shell nav-inner"><div class="brand"><img class="logo" src="/site/vizuara.png" alt="Vizuara"><span>Vizuara Wiki</span></div><div class="nav-actions"><a class="btn" href="/wiki/index.md" target="_blank">Markdown Index</a><button class="btn primary" id="addResourceBtn">Add resource</button></div></div></nav>
        <section class="hero"><div class="shell"><div class="eyebrow">WhatsApp Knowledge Graph · Updated \${esc(new Date(data.generatedAt).toLocaleString())}</div><h1><span class="gradient">\${esc(data.title)}</span></h1><p class="subtitle">\${esc(data.subtitle || data.overview)}</p><div class="metrics">\${(data.metrics||[]).map(m=>'<div class="metric"><strong>'+esc(m.value)+'</strong><span>'+esc(m.label)+'</span></div>').join('')}</div></div></section>
        <section class="section shell"><div class="section-head"><h2>Signal Summary</h2><span class="pill">Persistent LLM wiki</span></div><div class="panel summary-card">\${esc(data.overview)}</div></section>
        <section class="section shell"><div class="section-head"><h2 class="gradient">Topic Wiki</h2><span class="pill">\${(data.topics||[]).length} concepts</span></div><div class="grid">\${(data.topics||[]).map((t,i)=>'<article class="card topic-card"><h3>'+esc(t.name)+'</h3><p>'+esc(t.summary)+'</p><button class="btn topic-open" data-topic="'+i+'" type="button" style="margin-top:14px">Open notes</button></article>').join('')}</div></section>
        <section class="section shell"><div class="section-head"><h2>Connection Graph</h2><span class="pill">Drag canvas · wheel/pinch zoom · drag nodes</span></div><div class="panel graph-card"><div class="graph-toolbar"><span class="muted">Topics, resources, and important discussions</span><div class="graph-controls"><button class="btn" id="zoomOut">−</button><button class="btn" id="resetGraph">Reset</button><button class="btn" id="zoomIn">+</button></div></div><div class="graph-wrap" id="graphWrap"><svg id="graph"></svg></div></div></section>
        <section class="section shell"><div class="section-head"><h2 class="gradient">Resources & Media</h2><span class="pill">\${(data.resources||[]).length} stored</span></div><div class="resources" id="resourceGrid">\${(data.resources||[]).slice(0,48).map(renderResourceCard).join('')}</div></section>
        <section class="section shell"><div class="section-head"><h2>Important Discussions</h2></div><div class="grid">\${(data.importantDiscussions||[]).map(d=>'<article class="card"><h3>'+esc(d.title)+'</h3><p>'+esc(d.summary)+'</p><p style="margin-top:10px"><strong>Why:</strong> '+esc(d.whyItMatters)+'</p></article>').join('')}</div></section>
        <section class="section shell"><div class="section-head"><h2>Daily Timeline</h2></div><div class="timeline">\${(data.dailySummaries||[]).map(d=>'<div class="day"><div class="date">'+esc(d.date)+'</div><div><p>'+esc(d.summary)+'</p><ul>'+((d.highlights||[]).slice(0,3).map(h=>'<li>'+esc(h)+'</li>').join(''))+'</ul></div></div>').join('')}</div></section>
        <footer class="shell footer">Generated from local WhatsApp export, live message log, and manually persisted resources.</footer>\`;
      byId('addResourceBtn').onclick = openModal;
      document.querySelectorAll('.topic-open').forEach((button) => button.onclick = () => openTopic(Number(button.dataset.topic)));
      drawGraph(data.graph || {nodes:[],edges:[]});
    }
    const modal = byId('resourceModal');
    const resourceHref = (r) => r.url || r.path || '';
    function openModal(){ modal.classList.add('open'); }
    function closeModal(){ modal.classList.remove('open'); byId('resourceForm').reset(); }
    byId('closeModal').onclick = closeModal; byId('cancelModal').onclick = closeModal;
    byId('closeTopicModal').onclick = () => byId('topicModal').classList.remove('open');
    function openTopic(index) {
      const topic = (data.topics || [])[index];
      if (!topic) return;
      byId('topicTitle').textContent = topic.name;
      byId('topicSummary').textContent = topic.summary || '';
      byId('topicDetails').innerHTML = '<p>' + esc(topic.details || topic.summary || '') + '</p>' +
        '<h3 style="margin-top:18px">Useful takeaways</h3><ul>' + (topic.takeaways || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
        '<h3 style="margin-top:18px">Open questions</h3><ul>' + (topic.questions || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
      byId('topicModal').classList.add('open');
    }
    byId('resourceForm').onsubmit = async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const file = formData.get('file');
      const payload = {
        title: String(formData.get('title') || '').trim(),
        description: String(formData.get('description') || '').trim(),
        url: String(formData.get('url') || '').trim(),
      };
      if (!payload.title && !payload.description && !payload.url && (!file || !file.name)) {
        alert('Add a title, URL, description, or file.');
        return;
      }
      const hasFile = file && file.name;
      const res = await fetch('/api/resources', hasFile
        ? { method:'POST', body:formData }
        : { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload) });
      if (!res.ok) { alert('Could not save resource'); return; }
      const saved = await res.json();
      if (hasVisibleResource(saved)) {
        data.resources = dedupeResources([saved, ...(data.resources || [])]);
        writeResourceCache([saved, ...readResourceCache()]);
      }
      closeModal(); render();
    };
    byId('uploadControl').onclick = () => byId('fileInput').click();
    byId('fileInput').onchange = (event) => { byId('fileLabel').textContent = event.target.files?.[0]?.name || 'Choose a PDF, image, video, or notes file'; };
    function drawGraph(graph) {
      const svg = byId('graph'), wrap = byId('graphWrap');
      const w = wrap.clientWidth || 1000, h = wrap.clientHeight || 620;
      const nodes = (graph.nodes||[]).slice(0,54).map((n,i)=>({ ...n, x:w/2+Math.cos(i*2.399)*Math.sqrt(i+2)*62, y:h/2+Math.sin(i*2.399)*Math.sqrt(i+2)*46 }));
      const edges = (graph.edges||[]).filter(e=>nodes.find(n=>n.id===e.source)&&nodes.find(n=>n.id===e.target));
      for(let t=0;t<240;t++){ for(const a of nodes) for(const b of nodes) if(a!==b){ const dx=a.x-b.x,dy=a.y-b.y,dist=Math.max(36,Math.hypot(dx,dy)); const f=520/(dist*dist); a.x+=dx/dist*f; a.y+=dy/dist*f; } for(const e of edges){ const a=nodes.find(n=>n.id===e.source),b=nodes.find(n=>n.id===e.target); const dx=b.x-a.x,dy=b.y-a.y,dist=Math.max(1,Math.hypot(dx,dy)); const f=(dist-210)*.014; a.x+=dx/dist*f; a.y+=dy/dist*f; b.x-=dx/dist*f; b.y-=dy/dist*f; } }
      let scale=.82, tx=30, ty=10, drag=null, pan=null;
      const paint=()=>{ svg.innerHTML='<defs><linearGradient id="g"><stop offset="0%" stop-color="#ffd78a"/><stop offset="50%" stop-color="#8ad4ff"/><stop offset="100%" stop-color="#ffa8ff"/></linearGradient></defs><g transform="translate('+tx+' '+ty+') scale('+scale+')">'+edges.map(e=>{const a=nodes.find(n=>n.id===e.source),b=nodes.find(n=>n.id===e.target);return '<line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke="#d4d4d8" stroke-width="1.2"/>';}).join('')+nodes.map(n=>'<g class="node" data-id="'+esc(n.id)+'"><circle cx="'+n.x+'" cy="'+n.y+'" r="'+(n.type==='topic'?12:8)+'" fill="url(#g)" stroke="#fff" stroke-width="2"/><text x="'+(n.x+16)+'" y="'+(n.y+4)+'" fill="#27272a" font-size="12" font-weight="500">'+esc(n.label)+'</text></g>').join('')+'</g>'; };
      const point=(ev)=>({x:(ev.offsetX-tx)/scale,y:(ev.offsetY-ty)/scale});
      svg.onpointerdown=(ev)=>{ const p=point(ev); drag=nodes.find(n=>Math.hypot(n.x-p.x,n.y-p.y)<18); if(!drag) pan={x:ev.clientX,y:ev.clientY,tx,ty}; svg.setPointerCapture(ev.pointerId); };
      svg.onpointermove=(ev)=>{ if(drag){ const p=point(ev); drag.x=p.x; drag.y=p.y; paint(); } else if(pan){ tx=pan.tx+ev.clientX-pan.x; ty=pan.ty+ev.clientY-pan.y; paint(); } };
      svg.onpointerup=()=>{ drag=null; pan=null; };
      svg.onwheel=(ev)=>{ ev.preventDefault(); const old=scale; scale=Math.max(.35,Math.min(2.8,scale*(ev.deltaY<0?1.08:.92))); const mx=ev.offsetX,my=ev.offsetY; tx=mx-(mx-tx)*(scale/old); ty=my-(my-ty)*(scale/old); paint(); };
      byId('zoomIn').onclick=()=>{scale=Math.min(2.8,scale*1.18);paint();}; byId('zoomOut').onclick=()=>{scale=Math.max(.35,scale*.84);paint();}; byId('resetGraph').onclick=()=>{scale=.82;tx=30;ty=10;paint();};
      paint();
    }
    async function loadPersistedResources() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch('/api/resources', { cache: 'no-store' });
          if (!response.ok) continue;
          const resources = await response.json();
          const fresh = resources.filter(hasVisibleResource);
          if (fresh.length) {
            writeResourceCache(fresh);
            data.resources = dedupeResources([...fresh, ...(data.resources || [])]);
            render();
          }
          return;
        } catch {}
      }
    }
    function hasVisibleResource(r) {
      return Boolean(r && (String(r.title || '').trim() || String(r.description || '').trim() || String(r.url || '').trim() || String(r.path || '').trim()));
    }
    function dedupeResources(resources) {
      const seen = new Set();
      return resources.filter(hasVisibleResource).filter((r) => {
        const key = [r.url || '', r.path || '', r.title || ''].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    data.resources = dedupeResources([...readResourceCache(), ...(data.resources || [])]);
    render();
    loadPersistedResources();
  </script>
</body>
</html>`;
}
