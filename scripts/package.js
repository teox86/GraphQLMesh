'use strict';

/**
 * Builds a self-contained, ready-to-run bundle for the *current* OS/arch:
 *
 *   dist/GraphQLMesh/
 *     runtime/node[.exe]      bundled Node.js runtime (no install needed)
 *     app/                    server, public, package.json, node_modules
 *     run.cmd / run.sh        one-click launchers
 *   dist/GraphQLMesh-<os>-<arch>.(zip|tar.gz)
 *
 * Run on each OS (locally or in a CI matrix) to produce that platform's asset.
 * No Node, npm, Docker or network is needed by the end user — they unzip and
 * run the launcher.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'GraphQLMesh');

const NODE_VERSION = process.version; // bundle the same runtime we build with
const PLATFORM = { win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform];
const ARCH = process.arch; // x64 | arm64
if (!PLATFORM) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[package] ${msg}`);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function download(url, dest) {
  log(`Downloading ${url}`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
  });
}

async function fetchNodeRuntime() {
  const isWin = PLATFORM === 'win';
  const ext = isWin ? 'zip' : 'tar.gz';
  const dirName = `node-${NODE_VERSION}-${PLATFORM}-${ARCH}`;
  const archive = path.join(DIST, `${dirName}.${ext}`);
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${dirName}.${ext}`;

  await download(url, archive);

  log('Extracting Node runtime');
  // `tar` ships on Windows 10+ (bsdtar, handles zip) as well as macOS/Linux.
  execFileSync('tar', ['-xf', archive, '-C', DIST], { stdio: 'inherit' });

  const runtimeDir = path.join(STAGE, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (isWin) {
    fs.copyFileSync(path.join(DIST, dirName, 'node.exe'), path.join(runtimeDir, 'node.exe'));
  } else {
    const nodeBin = path.join(runtimeDir, 'node');
    fs.copyFileSync(path.join(DIST, dirName, 'bin', 'node'), nodeBin);
    fs.chmodSync(nodeBin, 0o755);
  }
  rmrf(path.join(DIST, dirName));
  rmrf(archive);
}

function copyApp() {
  log('Copying application + node_modules');
  const appDir = path.join(STAGE, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const entry of ['server', 'public', 'package.json', 'package-lock.json', 'node_modules']) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(appDir, entry), { recursive: true });
  }
}

function writeLaunchers() {
  log('Writing launchers');
  const sh = `#!/bin/sh
# Self-contained launcher: uses the bundled Node runtime, no install required.
DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "$DIR/runtime/node" "$DIR/app/server/index.js" "$@"
`;
  const cmd = `@echo off
rem Self-contained launcher: uses the bundled Node runtime, no install required.
"%~dp0runtime\\node.exe" "%~dp0app\\server\\index.js" %*
`;
  const shPath = path.join(STAGE, 'run.sh');
  fs.writeFileSync(shPath, sh);
  fs.chmodSync(shPath, 0o755);
  fs.writeFileSync(path.join(STAGE, 'run.cmd'), cmd.replace(/\n/g, '\r\n'));

  fs.writeFileSync(
    path.join(STAGE, 'README.txt'),
    [
      'GraphQL Mesh - Kubernetes API Explorer',
      '',
      'Ready to run - nothing to install.',
      '',
      '  Windows : double-click run.cmd',
      '  macOS   : ./run.sh   (or: sh run.sh)',
      '  Linux   : ./run.sh',
      '',
      'It opens http://localhost:3000 in your browser and uses your current',
      'kubeconfig (~/.kube/config or %USERPROFILE%\\.kube\\config, or $KUBECONFIG).',
      '',
      'Override the port with the PORT env var; set NO_OPEN=1 to skip auto-open.',
    ].join('\n') + '\n'
  );
}

function archive() {
  const isWin = PLATFORM === 'win';
  const name = `GraphQLMesh-${PLATFORM}-${ARCH}`;
  if (isWin) {
    const out = path.join(DIST, `${name}.zip`);
    rmrf(out);
    // bsdtar on Windows writes a real .zip with `-a` (auto from extension).
    execFileSync('tar', ['-a', '-c', '-f', out, '-C', DIST, 'GraphQLMesh'], { stdio: 'inherit' });
    log(`Created ${out}`);
  } else {
    const out = path.join(DIST, `${name}.tar.gz`);
    rmrf(out);
    execFileSync('tar', ['-czf', out, '-C', DIST, 'GraphQLMesh'], { stdio: 'inherit' });
    log(`Created ${out}`);
  }
}

async function main() {
  rmrf(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });
  await fetchNodeRuntime();
  copyApp();
  writeLaunchers();
  archive();
  rmrf(STAGE);
  log('Done.');
}

main().catch((err) => {
  console.error('[package] FAILED:', err.message);
  process.exit(1);
});
