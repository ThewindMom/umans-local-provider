#!/usr/bin/env bun

const imagePath = process.argv[2];
if (!imagePath) {
  console.error('Usage: bun run scripts/smoke-live.ts /path/to/image.png');
  process.exit(2);
}

const file = Bun.file(imagePath);
if (!(await file.exists())) {
  console.error(`Image not found: ${imagePath}`);
  process.exit(2);
}

const mediaType = file.type || 'image/png';
const data = Buffer.from(await file.arrayBuffer()).toString('base64');
const baseUrl = process.env.UMANS_PROVIDER_BASE_URL || 'http://127.0.0.1:8084';
const resp = await fetch(`${baseUrl}/v1/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-umans-target-model': 'umans-glm-5.2',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
        { type: 'text', text: 'What can you see here? Answer with what is visually present. Do not discuss attachment transport.' },
      ],
    }],
  }),
});

const text = await resp.text();
let parsed: unknown;
try { parsed = JSON.parse(text); } catch { parsed = text; }
const body = parsed as { model?: string; content?: Array<{ type?: string; text?: string }> };
const answer = Array.isArray(body.content)
  ? body.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n')
  : text;

console.log(JSON.stringify({
  status: resp.status,
  model: body.model || null,
  answerPreview: answer.slice(0, 1200),
}, null, 2));

if (!resp.ok) process.exit(1);
if (/cannot|can't|unable|unavailable|omitted|placeholder/i.test(answer) && !/not\s+unable/i.test(answer)) {
  console.error('Smoke failed: answer appears to refuse image access.');
  process.exit(1);
}
