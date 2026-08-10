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
