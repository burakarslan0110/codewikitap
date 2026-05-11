#!/usr/bin/env node
/**
 * One-shot E2E: spawns the rebuilt dist/index.js MCP server, sends
 * initialize + find_chunks JSON-RPC frames over stdio, and reports
 * whether `degraded` is false and `rerankScore` is non-null on the
 * returned chunks. Standalone — no test harness.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const entry = join(repoRoot, 'dist', 'index.js');

const proc = spawn('node', [entry], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, LOG_LEVEL: 'warn' },
});

let buffer = '';
const pending = new Map();
let nextId = 1;

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      console.error('parse fail:', e.message, '<<', line.slice(0, 200));
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    proc.stdin.write(frame + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}#${id}`));
      }
    }, 90_000);
  });
}

async function main() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-rerank-check', version: '0.0.1' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.error('[e2e] sending find_chunks…');
  const t0 = Date.now();
  const resp = await rpc('tools/call', {
    name: 'find_chunks',
    arguments: {
      query: 'how does zod parse and validate optional and nullable fields',
      repo: 'colinhacks/zod',
      k: 4,
    },
  });
  const elapsedMs = Date.now() - t0;

  if (resp.error) {
    console.error('[e2e] RPC error:', JSON.stringify(resp.error));
    process.exitCode = 2;
    proc.kill();
    return;
  }

  const text = resp.result?.content?.[0]?.text;
  if (!text) {
    console.error('[e2e] no text in result:', JSON.stringify(resp.result).slice(0, 500));
    process.exitCode = 3;
    proc.kill();
    return;
  }

  let payload;
  try { payload = JSON.parse(text); } catch (e) {
    console.error('[e2e] payload not JSON:', e.message);
    process.exitCode = 4;
    proc.kill();
    return;
  }

  const degraded = payload.degraded === true;
  const reason = payload.reason ?? null;
  const chunkCount = (payload.chunks ?? []).length;
  const rerankScores = (payload.chunks ?? []).map((c) => c.rerankScore);
  const allNonNull = rerankScores.length > 0 && rerankScores.every((s) => s != null && Number.isFinite(s));
  const sortedDesc = rerankScores.length < 2 || rerankScores.every((s, i, a) => i === 0 || a[i - 1] >= s);

  console.error(JSON.stringify({
    e2e: 'find_chunks',
    elapsedMs,
    chunkCount,
    degraded,
    reason,
    rerankScores,
    allRerankScoresNonNull: allNonNull,
    rerankScoresMonotonicDesc: sortedDesc,
  }, null, 2));

  if (degraded || !allNonNull) {
    console.error('[e2e] FAIL — reranker still degraded or scores still null');
    process.exitCode = 1;
  } else if (!sortedDesc) {
    console.error('[e2e] FAIL — rerankScore order not monotonic descending');
    process.exitCode = 1;
  } else {
    console.error('[e2e] PASS — rerank live, scores non-null, ordered');
  }
  proc.kill();
}

main().catch((err) => {
  console.error('[e2e] crash:', err.stack ?? err.message);
  process.exitCode = 99;
  proc.kill();
});
