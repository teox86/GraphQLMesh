'use strict';

/**
 * Kubernetes integration:
 *  - loads the active kubeconfig (~/.kube/config, $KUBECONFIG, or in-cluster)
 *  - discovers Services and classifies them as GraphQL / REST APIs
 *  - sets up kubectl-free port-forwards (via the API server) so a locally
 *    running GraphQL Mesh can reach in-cluster services over 127.0.0.1.
 */

const net = require('net');
const k8s = require('@kubernetes/client-node');

// Annotation keys a service author can set to describe their API explicitly.
const ANNO = {
  type: 'graphql-mesh.io/type', // "graphql" | "rest" | "openapi" | "ignore"
  path: 'graphql-mesh.io/path', // endpoint path, e.g. /graphql or /openapi.json
  port: 'graphql-mesh.io/port', // port name or number to use
};

const GRAPHQL_DEFAULT_PATH = '/graphql';
const OPENAPI_DEFAULT_PATH = '/openapi.json';

class K8sClient {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.loaded = false;
    this.loadError = null;
    try {
      // Honours $KUBECONFIG, then ~/.kube/config, then in-cluster service account.
      this.kc.loadFromDefault();
      this.core = this.kc.makeApiClient(k8s.CoreV1Api);
      this.forward = new k8s.PortForward(this.kc);
      this.loaded = true;
    } catch (err) {
      this.loadError = err;
    }
    // key `${namespace}/${pod}/${port}` -> { server, localPort }
    this.tunnels = new Map();
  }

  context() {
    if (!this.loaded) return { connected: false, error: String(this.loadError) };
    const current = this.kc.getCurrentContext();
    const ctx = this.kc.getContextObject(current);
    const cluster = ctx ? this.kc.getCluster(ctx.cluster) : null;
    return {
      connected: true,
      context: current,
      cluster: cluster ? cluster.name : null,
      server: cluster ? cluster.server : null,
    };
  }

  /** Quick connectivity check against the API server. */
  async ping() {
    if (!this.loaded) throw this.loadError;
    await this.core.listNamespace();
    return true;
  }

  /**
   * Discover candidate APIs across the cluster.
   * @param {object} opts { namespace?: string }
   * @returns {Promise<Array>} list of API descriptors
   */
  async discover(opts = {}) {
    if (!this.loaded) throw this.loadError;
    const ns = opts.namespace;
    const list = ns
      ? await this.core.listNamespacedService({ namespace: ns })
      : await this.core.listServiceForAllNamespaces();

    const apis = [];
    for (const svc of list.items) {
      const meta = svc.metadata || {};
      const spec = svc.spec || {};
      const annotations = meta.annotations || {};

      if (annotations[ANNO.type] === 'ignore') continue;
      // Skip headless / non-routable infra services without ports.
      const ports = spec.ports || [];
      if (ports.length === 0) continue;

      const explicitType = normaliseType(annotations[ANNO.type]);
      const chosenPort = pickPort(ports, annotations[ANNO.port]);
      if (!chosenPort) continue;

      const guessed = explicitType || guessType(meta, chosenPort);
      if (!guessed) continue; // not an obvious API surface

      const path =
        annotations[ANNO.path] ||
        (guessed === 'graphql' ? GRAPHQL_DEFAULT_PATH : OPENAPI_DEFAULT_PATH);

      apis.push({
        id: `${meta.namespace}/${meta.name}/${chosenPort.port}`,
        name: meta.name,
        namespace: meta.namespace,
        type: guessed, // 'graphql' | 'rest'
        servicePort: chosenPort.port,
        targetPort: chosenPort.targetPort,
        portName: chosenPort.name || null,
        path,
        source: explicitType ? 'annotation' : 'heuristic',
        clusterUrl: `http://${meta.name}.${meta.namespace}.svc.cluster.local:${chosenPort.port}${path}`,
        labels: meta.labels || {},
      });
    }
    apis.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
    return apis;
  }

  /** Find a ready pod backing a service (via its selector). */
  async podForService(namespace, serviceName) {
    const svc = await this.core.readNamespacedService({ name: serviceName, namespace });
    const selector = svc.spec && svc.spec.selector;
    if (!selector || Object.keys(selector).length === 0) {
      throw new Error(`Service ${namespace}/${serviceName} has no selector (headless/external); cannot port-forward.`);
    }
    const labelSelector = Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const pods = await this.core.listNamespacedPod({ namespace, labelSelector });
    const ready =
      pods.items.find((p) =>
        (p.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True')
      ) || pods.items[0];
    if (!ready) throw new Error(`No pods found for service ${namespace}/${serviceName}.`);
    return { pod: ready, service: svc };
  }

  /**
   * Resolve the numeric container port to forward to, given a service port's
   * targetPort (which may be a name or a number).
   */
  resolveContainerPort(pod, targetPort, fallbackPort) {
    if (typeof targetPort === 'number') return targetPort;
    if (typeof targetPort === 'string') {
      // numeric string
      if (/^\d+$/.test(targetPort)) return parseInt(targetPort, 10);
      // named port -> look it up on the pod's containers
      for (const c of pod.spec?.containers || []) {
        for (const p of c.ports || []) {
          if (p.name === targetPort) return p.containerPort;
        }
      }
    }
    return fallbackPort;
  }

  /**
   * Ensure a local TCP tunnel to a pod port exists; returns the local port.
   * The tunnel proxies 127.0.0.1:<localPort> -> pod:<containerPort> through
   * the Kubernetes API server (no kubectl binary required).
   */
  async ensureTunnel(namespace, podName, containerPort) {
    const key = `${namespace}/${podName}/${containerPort}`;
    if (this.tunnels.has(key)) return this.tunnels.get(key).localPort;

    const server = net.createServer((socket) => {
      this.forward
        .portForward(namespace, podName, [containerPort], socket, null, socket)
        .catch((err) => {
          socket.destroy();
          // eslint-disable-next-line no-console
          console.error(`[port-forward] ${key} error:`, err.message);
        });
    });
    server.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[tunnel] ${key} server error:`, err.message);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const localPort = server.address().port;
    this.tunnels.set(key, { server, localPort });
    return localPort;
  }

  /**
   * Given an API descriptor, establish a tunnel and return a localhost URL the
   * mesh can use to reach it.
   */
  async localEndpointFor(api) {
    const { pod, service } = await this.podForService(api.namespace, api.name);
    const svcPort = (service.spec.ports || []).find((p) => p.port === api.servicePort) ||
      (service.spec.ports || [])[0];
    const containerPort = this.resolveContainerPort(pod, svcPort.targetPort, svcPort.port);
    const localPort = await this.ensureTunnel(api.namespace, pod.metadata.name, containerPort);
    return `http://127.0.0.1:${localPort}${api.path}`;
  }

  closeTunnels() {
    for (const { server } of this.tunnels.values()) {
      try {
        server.close();
      } catch (_) {
        /* ignore */
      }
    }
    this.tunnels.clear();
  }
}

function normaliseType(t) {
  if (!t) return null;
  const v = String(t).toLowerCase();
  if (v === 'graphql' || v === 'gql') return 'graphql';
  if (v === 'rest' || v === 'openapi' || v === 'swagger') return 'rest';
  return null;
}

/** Choose which service port to expose. */
function pickPort(ports, preferred) {
  if (preferred) {
    const match = ports.find(
      (p) => p.name === preferred || String(p.port) === String(preferred)
    );
    if (match) return match;
  }
  // Prefer a port whose name hints at an API; otherwise the first http-ish one.
  const byName = ports.find((p) => /graphql|http|rest|api|web/i.test(p.name || ''));
  return byName || ports[0];
}

/** Heuristic classification when no annotation is present. */
function guessType(meta, port) {
  const name = `${meta.name} ${port.name || ''}`.toLowerCase();
  const labels = Object.values(meta.labels || {}).join(' ').toLowerCase();
  const hay = `${name} ${labels}`;
  if (/graphql|gql/.test(hay)) return 'graphql';
  if (/rest|openapi|swagger|\bapi\b/.test(hay)) return 'rest';
  // An http(s) named port with no other hint -> treat as a REST candidate.
  if (/^(http|https|web)$/i.test(port.name || '')) return 'rest';
  return null;
}

module.exports = { K8sClient, ANNO };
