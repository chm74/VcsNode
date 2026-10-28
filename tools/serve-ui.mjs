/* 本地预览 ui/ 的极简静态服务器（零依赖）
   用法：node tools/serve-ui.mjs [port]
   只为看页面，不参与生产。 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('../ui/', import.meta.url);
const port = Number(process.argv[2] || 47830);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = join(root.pathname.replace(/^\//, ''), rel === '/' ? 'index.html' : normalize(rel).replace(/^([/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(port, () => {
  console.log(`ui preview: http://localhost:${port}/`);
});
