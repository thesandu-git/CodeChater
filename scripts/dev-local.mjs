// 本地开发服务器：静态文件 + 把 /api/* 交给真实的 TS handler。
//
//   npm run dev:local        # 需要 .env.local（见 docs/WORKBENCH.md）
//
// 为什么不用 `vercel dev`：本仓库 package.json 的 dev 脚本就是 `vercel dev`，
// Vercel CLI 会判定为递归调用并直接退出（Error: must not recursively invoke itself）。
// 这个脚本只做两件事：读静态文件、动态 import handlers，够本地验证用。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 3120);
const STATIC = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/workbench', 'workbench.html'],
  ['/workbench.html', 'workbench.html'],
  ['/studio', 'studio.html'],
  ['/studio.html', 'studio.html'],
  ['/studio.js', 'studio.js'],
  ['/studio.css', 'studio.css'],
  ['/app.js', 'app.js'],
  ['/workbench.js', 'workbench.js'],
  ['/style.css', 'style.css'],
  ['/workbench.css', 'workbench.css'],
]);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function handlerFile(pathname) {
  const rel = pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  if (!rel || rel.includes('..') || !/^[a-z0-9_/-]+$/i.test(rel)) return null;
  return path.join(ROOT, 'api', `${rel}.ts`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function makeRes(res) {
  const out = {
    statusCode: 200,
    headers: {},
    status(code) {
      out.statusCode = code;
      return out;
    },
    setHeader(name, value) {
      out.headers[name] = value;
      return out;
    },
    json(value) {
      res.writeHead(out.statusCode, { ...out.headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
      return out;
    },
    end(body = '') {
      res.writeHead(out.statusCode, out.headers);
      res.end(body);
    },
    send(value) {
      res.writeHead(out.statusCode, out.headers);
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    },
  };
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (STATIC.has(pathname)) {
    const file = path.join(ROOT, STATIC.get(pathname));
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  const file = handlerFile(pathname);
  if (file) {
    try {
      const handler = (await import(pathToFileURL(file).href)).default;
      if (typeof handler !== 'function') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No default handler export.' }));
        return;
      }
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        query: Object.fromEntries(url.searchParams.entries()),
        body: req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : undefined,
      };
      await handler(request, makeRes(res));
      return;
    } catch (error) {
      console.error(`[dev] ${pathname} crashed:`, error?.message || error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      }
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`本地控制台：http://localhost:${PORT}`);
  console.log(`工作台：   http://localhost:${PORT}/workbench`);
  console.log(`Studio：   http://localhost:${PORT}/studio`);
  console.log('用 Supabase Auth 的账户登录（与线上同一个账户）。Ctrl+C 退出。');
});
