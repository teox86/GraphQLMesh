# GraphQL Mesh · Kubernetes API Explorer

A web application that **discovers the REST and GraphQL APIs exposed on a
Kubernetes cluster**, lets you **select** any of them, and composes the selected
ones into a **local [GraphQL Mesh](https://the-guild.dev/graphql/mesh)** —
a single unified GraphQL endpoint. You can then **download the unified
GraphQL schema (SDL)**.

It talks to the cluster using your **current kubeconfig** (`~/.kube/config`,
`$KUBECONFIG`, or an in-cluster service account) and needs **no `kubectl`
binary**: in-cluster services are reached through API-server port-forwarding
provided by the official Kubernetes JavaScript client.

```
┌────────────┐    discover     ┌──────────────┐   port-forward    ┌───────────┐
│  Browser   │ ───────────────▶│  Node server │ ─────────────────▶│  K8s API  │
│  (UI)      │◀─── REST/JSON ──│  (Express)   │   (no kubectl)    │  server   │
└────────────┘                 └──────┬───────┘                   └───────────┘
      │  select + "Add to Mesh"       │ spawns
      │  download schema              ▼
      │                        ┌──────────────┐  http://127.0.0.1:<fwd>  upstream
      └───────────────────────▶│ GraphQL Mesh │ ─────────────────────────▶ services
                               │ (local :4000)│
                               └──────────────┘
```

## Quick start

### Option A — download a release (no install)

Grab the bundle for your OS from the
[Releases](https://github.com/teox86/GraphQLMesh/releases) page, unzip it, and
run the launcher. It includes a Node runtime + dependencies, so **nothing needs
to be installed** (no Node, npm, or Docker):

| OS      | Run                                    |
| ------- | -------------------------------------- |
| Windows | double-click `run.cmd`                 |
| macOS   | `./run.sh`                             |
| Linux   | `./run.sh`                             |

It opens <http://localhost:3000> automatically and uses your current
kubeconfig. Set `PORT` to change the port; set `NO_OPEN=1` to skip auto-open.

### Option B — from source

```bash
npm install
npm start
# open http://localhost:3000
```

Make sure a kubeconfig is active first (`kubectl config current-context`
should print your cluster). The header pill shows the connected context.

### Building release bundles

`npm run package` produces a self-contained archive for the current OS in
`dist/` (bundled Node runtime + `node_modules` + launchers). The
[`Release` workflow](.github/workflows/release.yml) builds these on Windows,
macOS and Linux and attaches them to a GitHub Release. It runs when:

- **a PR is merged into `main`** → auto-bumps the version and **publishes** a
  release. The bump is **patch** by default; add a **`release:minor`** or
  **`release:major`** label to the PR for a bigger bump. (Closing a PR without
  merging does nothing.)
- **a `v*` tag is pushed** → publishes a release for that exact tag.
- **run manually** (Actions → Release → Run workflow) → builds the bundles and
  creates a **draft** release.

### Environment variables

| Variable     | Default | Purpose                                   |
| ------------ | ------- | ----------------------------------------- |
| `PORT`       | `3000`  | Port for this web app / API.              |
| `MESH_PORT`  | `4000`  | Port the composed GraphQL Mesh serves on. |
| `KUBECONFIG` | —       | Standard kubeconfig override.             |

## How it works

### 1. Discovery (`server/k8s.js`)

The server lists `Service` objects (optionally scoped to one namespace) and
classifies each as `graphql` or `rest`. Classification order:

1. **Explicit annotations** (most reliable):

   | Annotation                    | Example                     | Meaning                                                                 |
   | ----------------------------- | --------------------------- | ----------------------------------------------------------------------- |
   | `graphql-mesh.io/type`        | `graphql`                   | `graphql` \| `rest`/`openapi` \| `ignore`                               |
   | `graphql-mesh.io/path`        | `/graphql`                  | Endpoint / OpenAPI spec path. Defaults: `/graphql`, REST `/swagger/v1/swagger.json`. |
   | `graphql-mesh.io/browse-path` | `/swagger`                  | Path opened by the port-forward link. Defaults: GraphQL = `path`, REST `/swagger`. |
   | `graphql-mesh.io/port`        | `http`                      | Port name or number to use.                                             |

2. **Heuristics** when no annotation is present: port/service/label names
   containing `graphql`/`gql` → GraphQL; `rest`/`openapi`/`swagger`/`api` (incl.
   names ending in `-api`) or a plain `http`/`https`/`web` named port → REST.
   Services with no naming hint are still listed as REST **if** their port
   number looks like HTTP (80, 443, 3000, 5000, 5001, 8000, 8080, 8081, 8443,
   8888) or the name ends with `-api`; other non-HTTP services (e.g. databases)
   are skipped.

Annotate a service to make it show up exactly as intended, e.g.:

```yaml
metadata:
  annotations:
    graphql-mesh.io/type: graphql
    graphql-mesh.io/path: /graphql
    graphql-mesh.io/port: http
```

### 2. Composition into GraphQL Mesh (`server/mesh.js`)

When you click **Add selected to Mesh**, for each selected API the server:

1. Finds a ready backing **pod** (via the service selector) and opens a local
   TCP **port-forward** through the API server (`127.0.0.1:<random>`).
2. Generates a `.meshrc.yaml` in `.mesh-workspace/` using the
   [`graphql`](https://the-guild.dev/graphql/mesh/docs/handlers/graphql) handler
   for GraphQL sources and the
   [`openapi`](https://the-guild.dev/graphql/mesh/docs/handlers/openapi) handler
   for REST sources.
3. (Re)starts the GraphQL Mesh CLI (`mesh dev`) which serves the unified
   GraphQL API + GraphiQL on `MESH_PORT`.

### Browsing the table

The API table sorts by clicking column headers and has a **live filter box in
each column header** (results update as you type). The **Namespace** box scopes
the cluster query itself and is also live. The top bar shows a **live count of
open port-forward connections** with a **Disconnect all** button.

### Per-service port-forwarding

Each row in the table has a **Port-forward** button that opens a kubectl-free
tunnel (`127.0.0.1:<random>`) to the service behind that API and shows the
local URL; clicking it again tears the tunnel down. This is independent of the
mesh and handy for poking an endpoint directly.

### 3. Schema download

**Download schema (SDL)** introspects the live mesh and returns the unified
schema as `mesh-schema.graphql`.

## API reference

| Method   | Path                | Description                                     |
| -------- | ------------------- | ----------------------------------------------- |
| `GET`    | `/api/cluster`      | Current kube context + reachability.            |
| `GET`    | `/api/apis`         | Discovered APIs (`?namespace=` to scope).       |
| `GET`    | `/api/portforward`  | List active per-service port-forwards.          |
| `POST`   | `/api/portforward`  | Start a forward for `{ api }`; returns local URL.|
| `DELETE` | `/api/portforward`  | Stop a forward for `{ id }`.                     |
| `POST`   | `/api/mesh`         | Compose `{ selected: [...] }` into the mesh.    |
| `GET`    | `/api/mesh`         | Mesh status, sources, and recent logs.          |
| `DELETE` | `/api/mesh`         | Stop the mesh and tear down port-forwards.      |
| `GET`    | `/api/mesh/schema`  | Download unified GraphQL SDL.                   |

## Notes & limitations

- Port-forwarding requires the service to have a **selector** and at least one
  ready pod; headless/external services can't be tunnelled.
- Run the app where it can reach your API server (locally with a kubeconfig, or
  in-cluster with a service account + RBAC for `services`, `pods`, and
  `pods/portforward`).
- The unified schema download requires the mesh to be **running**.
