# Demo

`npm run build`

## Ethereum Swarm image storage (optional)

By default the demo inlines images into the document. To store them
encrypted on [Ethereum Swarm](https://www.ethswarm.org/) instead, point the
demo at a Bee node before starting it — run from this directory (`demo/`),
which is its own vite project:

```bash
cd demo && npm i
VITE_BEE_API_URL=http://localhost:1633 npm run dev
```

The first usable postage batch on the node is auto-discovered; pin a
specific one with `VITE_SWARM_POSTAGE_BATCH_ID=<batch id>`. For local
development without a full node, `bee dev` provides an in-memory node with
free stamps.

## Hosting the demo itself on Swarm

The demo is a static bundle, so the *app* can live on Swarm alongside the
data — no web server at all:

```bash
./deploy-swarm.sh
```

This builds with relative paths, uploads the bundle as a Swarm website
(manifest + index document) and prints a `/bzz/<reference>/` URL served by
your Bee node. App code, images, document snapshots and version history
then all come from the Swarm network. Point an ENS `contenthash` (or a
feed) at the reference for a stable, human-readable address.
