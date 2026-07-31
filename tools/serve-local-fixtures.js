#!/usr/bin/env node
'use strict';

// Small, dependency-free server used only for the local browser harness. It
// intentionally exposes the current workspace rather than any user profile
// directories and rejects path traversal.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || process.env.FRIBERG_FIXTURE_PORT || 4176);
const mimeByExtension = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const relative = decoded === '/' ? 'tests/fixtures/live-assist-extension-harness.html' : decoded.replace(/^[/\\]+/, '');
  const target = path.resolve(root, relative);
  return target.startsWith(`${root}${path.sep}`) || target === root ? target : null;
}

http.createServer((request, response) => {
  const filePath = safePath(request.url);
  if (!filePath) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': mimeByExtension[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    fs.createReadStream(filePath).pipe(response);
  });
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`fixture-server http://127.0.0.1:${port}/\n`);
});
