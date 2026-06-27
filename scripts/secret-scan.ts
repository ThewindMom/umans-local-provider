#!/usr/bin/env bun

type Finding = { file: string; pattern: string; line: number };

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ignoredDirs: Record<string, true> = { '.git': true, node_modules: true, '.cache': true, '.logs': true };
const ignoredFiles: Record<string, true> = { 'bun.lockb': true };
const patterns: [string, RegExp][] = [
  ['UMANS/OpenAI-style API key', /\bsk-(?!your-|local-placeholder\b)[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ['Bearer token literal', /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/g],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/g],
];
const textExt: Record<string, true> = { '.js': true, '.ts': true, '.json': true, '.jsonc': true, '.md': true, '.yml': true, '.yaml': true, '.sh': true, '.service': true, '.gitignore': true, '.example': true };

function ext(path: string): string {
  const base = path.split('/').pop() || '';
  if (base.startsWith('.')) return base;
  const idx = base.lastIndexOf('.');
  return idx === -1 ? '' : base.slice(idx);
}


async function listFiles(dir: string, out: string[] = []): Promise<string[]> {
  for await (const entry of new Bun.Glob('**/*').scan({ cwd: dir, dot: true, onlyFiles: true })) {
    const parts = entry.split('/');
    if (parts.some(p => ignoredDirs[p])) continue;
    const name = parts[parts.length - 1];
    if (ignoredFiles[name]) continue;
    const path = `${dir}/${entry}`;
    if (!textExt[ext(path)] && !name.includes('README') && !name.includes('LICENSE')) continue;
    out.push(path);
  }
  return out;
}

const findings: Finding[] = [];
for (const file of await listFiles(root)) {
  const text = await Bun.file(file).text();
  for (const [label, re] of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const before = text.slice(0, match.index);
      findings.push({ file: file.slice(root.length + 1), pattern: label, line: before.split(/\n/).length });
    }
  }
}

if (findings.length) {
  console.error('Secret scan failed:');
  for (const f of findings) console.error(`- ${f.file}:${f.line} ${f.pattern}`);
  process.exit(1);
}

console.log('Secret scan passed');
