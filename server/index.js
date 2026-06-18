'use strict';

const path = require('path');
const express = require('express');
const { K8sClient } = require('./k8s');
const { MeshManager } = require('./mesh');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MESH_PORT = parseInt(process.env.MESH_PORT || '4000', 10);

const app = express();
app.use(express.json());

const k8s = new K8sClient();
const mesh = new MeshManager({ port: MESH_PORT });

// ---- API ------------------------------------------------------------------

// Cluster connection info.
app.get('/api/cluster', async (req, res) => {
  const ctx = k8s.context();
  if (!ctx.connected) return res.status(503).json(ctx);
  try {
    await k8s.ping();
    res.json({ ...ctx, reachable: true });
  } catch (err) {
    res.status(502).json({ ...ctx, reachable: false, error: err.message });
  }
});

// Discover exposed REST/GraphQL APIs.
app.get('/api/apis', async (req, res) => {
  try {
    const apis = await k8s.discover({ namespace: req.query.namespace || undefined });
    res.json({ apis });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Compose the selected APIs into the local GraphQL Mesh.
// Body: { selected: [{ id, name, namespace, type, servicePort, path }] }
app.post('/api/mesh', async (req, res) => {
  const selected = (req.body && req.body.selected) || [];
  if (selected.length === 0) {
    return res.status(400).json({ error: 'No APIs selected.' });
  }
  try {
    const resolved = [];
    for (const api of selected) {
      // Establish a kubectl-free tunnel and get a localhost endpoint the mesh can use.
      const endpoint = await k8s.localEndpointFor(api);
      resolved.push({ name: api.name, type: api.type, endpoint, source: api });
      mesh.log(`Tunnel ready for ${api.namespace}/${api.name} -> ${endpoint}`);
    }
    const state = await mesh.apply(resolved);
    res.json({ ok: true, mesh: state });
  } catch (err) {
    res.status(500).json({ error: err.message, mesh: mesh.state() });
  }
});

// ---- Per-service port-forwarding -----------------------------------------

// List active user-initiated port-forwards.
app.get('/api/portforward', (req, res) => res.json({ forwards: k8s.listForwards() }));

// Start a port-forward to the service backing an API. Body: { api: {...} }
app.post('/api/portforward', async (req, res) => {
  const apiDesc = req.body && req.body.api;
  if (!apiDesc || !apiDesc.id) {
    return res.status(400).json({ error: 'Missing api descriptor.' });
  }
  try {
    const forward = await k8s.openForward(apiDesc);
    res.json({ ok: true, forward });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop a port-forward. Body: { id }
app.delete('/api/portforward', (req, res) => {
  const id = req.body && req.body.id;
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const stopped = k8s.closeForward(id);
  res.json({ ok: stopped });
});

// Mesh status.
app.get('/api/mesh', (req, res) => res.json(mesh.state()));

// Stop the mesh and tear down tunnels.
app.delete('/api/mesh', async (req, res) => {
  await mesh.stop();
  k8s.closeTunnels();
  res.json({ ok: true, mesh: mesh.state() });
});

// Download the unified mesh schema as SDL.
app.get('/api/mesh/schema', async (req, res) => {
  try {
    const sdl = await mesh.fetchSchemaSDL();
    res.setHeader('Content-Type', 'application/graphql');
    res.setHeader('Content-Disposition', 'attachment; filename="mesh-schema.graphql"');
    res.send(sdl);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ---- Static frontend ------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  // eslint-disable-next-line no-console
  console.log(`GraphQL Mesh K8s Explorer listening on ${url}`);
  const ctx = k8s.context();
  if (ctx.connected) {
    // eslint-disable-next-line no-console
    console.log(`Kube context: ${ctx.context} (${ctx.server})`);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`No kubeconfig loaded: ${ctx.error}`);
  }
  if (process.env.NO_OPEN !== '1') openBrowser(url);
});

// Open the default browser at startup (best-effort, never fatal).
function openBrowser(url) {
  const { spawn } = require('child_process');
  try {
    const cmd =
      process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '""', url] }
        : process.platform === 'darwin'
        ? { command: 'open', args: [url] }
        : { command: 'xdg-open', args: [url] };
    const child = spawn(cmd.command, cmd.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch (_) {
    /* ignore — the URL is printed above */
  }
}

async function shutdown() {
  // eslint-disable-next-line no-console
  console.log('\nShutting down...');
  await mesh.stop();
  k8s.closeTunnels();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
