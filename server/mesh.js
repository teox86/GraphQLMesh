'use strict';

/**
 * GraphQL Mesh (https://the-guild.dev/graphql/mesh) lifecycle management.
 *
 * Generates a .meshrc.yaml from the selected API sources and runs the mesh CLI
 * as a child process, serving a unified GraphQL endpoint on a local port.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const {
  getIntrospectionQuery,
  buildClientSchema,
  printSchema,
} = require('graphql');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.join(ROOT, '.mesh-workspace');
const MESH_BIN = path.join(ROOT, 'node_modules', '.bin', 'mesh');

class MeshManager {
  constructor({ port = 4000 } = {}) {
    this.port = port;
    this.proc = null;
    this.status = 'stopped'; // stopped | starting | running | error
    this.sources = []; // last applied sources
    this.logs = [];
    this.startedAt = null;
    this.lastError = null;
  }

  get endpoint() {
    return `http://localhost:${this.port}/graphql`;
  }

  state() {
    return {
      status: this.status,
      port: this.port,
      endpoint: this.endpoint,
      graphiql: `http://localhost:${this.port}/`,
      sources: this.sources,
      startedAt: this.startedAt,
      lastError: this.lastError,
      meshInstalled: fs.existsSync(MESH_BIN),
      logs: this.logs.slice(-200),
    };
  }

  log(line) {
    const entry = `[${new Date().toISOString()}] ${line}`;
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  /**
   * Build a .meshrc.yaml object from resolved sources.
   * @param {Array} sources [{ name, type, endpoint }]
   */
  buildConfig(sources) {
    const meshSources = sources.map((s) => {
      const handlerName = sanitizeName(s.name);
      if (s.type === 'graphql') {
        return {
          name: handlerName,
          handler: { graphql: { endpoint: s.endpoint } },
        };
      }
      // REST / OpenAPI
      return {
        name: handlerName,
        handler: { openapi: { source: s.endpoint } },
      };
    });

    return {
      sources: meshSources,
      serve: {
        port: this.port,
        playground: true,
        hostname: '0.0.0.0',
      },
    };
  }

  writeConfig(config) {
    fs.mkdirSync(WORKSPACE, { recursive: true });
    const file = path.join(WORKSPACE, '.meshrc.yaml');
    fs.writeFileSync(file, yaml.dump(config), 'utf8');
    return file;
  }

  /**
   * Apply a new set of sources: (re)write config and (re)start the mesh.
   * @param {Array} sources [{ name, type, endpoint }]
   */
  async apply(sources) {
    if (!sources || sources.length === 0) {
      throw new Error('No sources selected.');
    }
    if (!fs.existsSync(MESH_BIN)) {
      throw new Error(
        'GraphQL Mesh CLI is not installed. Run `npm install` in the project root.'
      );
    }
    this.sources = sources;
    const config = this.buildConfig(sources);
    const configFile = this.writeConfig(config);
    this.log(`Wrote mesh config with ${sources.length} source(s) to ${configFile}`);

    await this.stop();
    return this.start();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.status = 'starting';
      this.lastError = null;
      this.log(`Starting GraphQL Mesh on port ${this.port}...`);

      // `mesh dev` serves with live GraphiQL; resolves modules from root node_modules.
      this.proc = spawn(MESH_BIN, ['dev', '--port', String(this.port)], {
        cwd: WORKSPACE,
        env: { ...process.env, NODE_OPTIONS: '' },
      });

      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        this.status = 'running';
        this.startedAt = new Date().toISOString();
        this.log('GraphQL Mesh is serving.');
        resolve(this.state());
      };

      const handleData = (buf) => {
        const text = buf.toString();
        text.split(/\r?\n/).forEach((l) => l.trim() && this.log(l.trim()));
        if (/Serving GraphQL|started server|http:\/\/localhost|GraphQL Mesh|listening/i.test(text)) {
          onReady();
        }
      };

      this.proc.stdout.on('data', handleData);
      this.proc.stderr.on('data', handleData);

      this.proc.on('error', (err) => {
        this.status = 'error';
        this.lastError = err.message;
        this.log(`Process error: ${err.message}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.proc.on('exit', (code, signal) => {
        this.log(`Mesh process exited (code=${code}, signal=${signal}).`);
        if (this.status !== 'stopped') {
          this.status = code === 0 ? 'stopped' : 'error';
          if (code !== 0) this.lastError = `Mesh exited with code ${code}.`;
        }
        this.proc = null;
        if (!settled) {
          settled = true;
          reject(new Error(this.lastError || 'Mesh exited before becoming ready.'));
        }
      });

      // Fallback: assume ready after a grace period if no banner matched.
      setTimeout(() => onReady(), 15000);
    });
  }

  async stop() {
    if (!this.proc) {
      this.status = 'stopped';
      return;
    }
    this.status = 'stopped';
    const proc = this.proc;
    this.proc = null;
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
        resolve();
      }, 5000);
    });
    this.log('Mesh stopped.');
  }

  /**
   * Fetch the unified mesh schema as SDL by introspecting the live endpoint.
   */
  async fetchSchemaSDL() {
    if (this.status !== 'running') {
      throw new Error('Mesh is not running. Add sources to the mesh first.');
    }
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
    });
    if (!res.ok) throw new Error(`Introspection failed: HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(`Introspection errors: ${JSON.stringify(json.errors)}`);
    const schema = buildClientSchema(json.data);
    return printSchema(schema);
  }
}

function sanitizeName(name) {
  const cleaned = String(name)
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
  const pascal = cleaned
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return pascal || `Source_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { MeshManager, WORKSPACE, MESH_BIN };
