# dDoc × Swarm — demo links

**Latest demo: `1a1c8011…`** — built 2026-08-17 from commit `0b1fb41`, head
of `feat/swarm-storage-on-main`: the **split-PR build** — PR 1
(storage-agnostic props) + PR 2 (Swarm modules + demo) rebased onto upstream
`main` (`2896abd`, includes TEC-2515's editor chrome + flat schema v2) —
plus the boot-retry fix from the Freedom field test: the boot screen now
retries up to four times with a widening gap, shows the attempt count,
recovers when the reload navigation itself hangs at a warming node, and
offers a Reload button in every failure state. Every earlier reference in
this file is history; the two links below are the current ones.

Verification state: **verified end to end 2026-08-17** — works in Freedom
Browser and Brave, with the boot retry recovering by itself on a cold
node. All Swarm suites pass against a live Bee 2.8.1 node (91 tests), the
sample document's pre-TEC-2515 snapshot renders under the new editor
schema (text, table, photograph), and `/stewardship` confirms
network-wide retrievability.

Previous builds remain deployed and read the same document feed:
`a770f6af…` (split-PR build without the boot fix) and `9d2e0955…`
(the v4.3.9-based build, verified in Freedom).

## Sample document (start here)

A written-up demo page — explaining what is stored where, and what happens
when you edit it — with a photograph embedded, everything on Swarm:

```
http://localhost:1633/bzz/1a1c8011091fdbc72838fa58865a7bde5b48e4d5ab85ecd6f8339b81e13a2d97/?doc=sample-mswwageg#skey=0xb20adf09ff7a371c55404d6ce60918006f6dd4c9564de15dfd12cd7dfe410336:l7sC66hH5M5d5xMnZenZ7ouVQ1%2F%2FCaX6tMVbWrs%2FFSk%3D
```

For Freedom Browser, replace `http://localhost:1633/bzz/` with `bzz://` —
see `FREEDOM-LINK.txt`, which holds that form ready to copy.

Everything in it — app, text, image, versions — comes off the network.
**The link carries write access** (see the warning below), so anyone you
send it to can edit the sample; their edits become version 1, 2, … while
version 0 stays exactly as published.

| Part | Reference |
| --- | --- |
| Document snapshot (v0) | `a2327967c081654b8e70f077ef0353c1f591b38c0c2842175b828282959c1464` |
| Embedded photograph | `7e5d6b378e0438126dc5fb130b7b951731e50c7ab59aec386c4609d1e7cba65e` |
| Document id | `sample-mswwageg` |

Republished 2026-08-17: the earlier sample (`sample-msq2z48c`) was stored as
a bare `/bytes` chunk tree, which `bzz://` cannot resolve and the provider
API cannot reassemble — so it was unreadable in a browser-embedded node,
however warm. Documents now go through `/bzz`, and the same reference
resolves both ways. The old link still opens against your own Bee node.

## Live deployment (2026-08-17, split-PR build + boot-retry fix)

Swarm reference:

```
1a1c8011091fdbc72838fa58865a7bde5b48e4d5ab85ecd6f8339b81e13a2d97
```

Built from `feat/swarm-storage-on-main` @ `0b1fb41` — the two split PRs
combined: `feat/storage-agnostic-image-props` (PR 1, on upstream `main`
`2896abd`) plus the rebased Swarm/demo commits (PR 2), and on top the
boot-retry fix prompted by the first Freedom test of the split build,
where a single silent retry left the visitor stranded on a frozen
"Retrying…" screen. Compared to the v4.3.9-era build it additionally
carries everything upstream merged since, most visibly TEC-2515's editor
chrome and flat schema v2. The document feed, keys and links are
unchanged — only the app hash moved.

Previous builds — still deployed, still work, same document feed:

```
a770f6af02a4d9f35f058a4e49e38d6789d8de03b4b714f4c134c1441d4d789f   split-PR build, no boot fix
9d2e0955adf4144ff6eb6af2164cbcbeff647a5e751fe50a13e969a3ae483192   base v4.3.9, verified in Freedom
```

The reference is network-global: anyone running a Bee node opens that same
path on *their* node and gets the app, because the API URL the app talks to
is localhost-relative to each viewer. No web server involved — app code,
images, documents and version history all come from Swarm.

Uploaded synchronously and confirmed with `/stewardship`
(`isRetrievable: true`), then every eager chunk fetched complete.

What this build contains (the Swarm feature set as of `08b8849`, carried
unchanged through the rebase):

- Asks for no permission to read. A document opened from a link reads under
  that link's key, which needs no consent from a provider — and publishing
  obstacles are suppressed for it entirely, since its feed can only ever be
  signed by its owner.
- Retries the document restore up to five times with a widening gap while a
  freshly started node finds peers, and resumes a restore that was deferred
  for permission once access is granted.
- Survives a Swarm node that is still starting: it answers HTTP before it
  has peers and returns 502 for a second or more
  ([solardev-xyz/ant#78](https://github.com/solardev-xyz/ant/issues/78)),
  which permanently kills a page's scripts because browsers never retry
  them. The boot screen retries once by itself, then explains.
- Documents and images are stored through `/bzz`, so one reference works
  from a node's API *and* as `bzz://<reference>/`.
- Opens a shared document in a Swarm-aware browser: a document's feed
  belongs to the key in its link, so that is what gets read. Reading no
  longer asks for a signing identity, so viewing a link does not trigger a
  consent prompt.
- Works in Swarm-aware browsers: an injected `window.swarm` provider is
  preferred over a node URL, so the demo runs where raw access to port 1633
  is blocked. Postage controls are hidden there (the browser manages
  postage) and the provider's own reason codes are explained instead.
- Diagnostics for every unavailable state — offline, node down, no postage
  batch, batch expired / expiring / full — shown in a bar pinned to the
  bottom of the window, each explaining what it means for your text and
  offering a remedy.
- Postage purchase, top-up and dilution from inside the app, quoting the
  exact cost from live pricing and the node's own wallet first.
- Edits held while Swarm is unwritable and flushed automatically when a node
  returns or a batch is bought.
- Staged restore progress, elapsed time, and a "Continue without restoring"
  escape.
- Vendor/app chunk split, so a rebuild re-uploads ~32% of the site instead
  of ~83%.
- Bounded requests — no operation can hang indefinitely.

To open an existing document, append its id and keys to the URL, e.g.
`…/bzz/<reference>/?doc=<id>#skey=<owner-key>:<doc-key>`.
**Treat that fragment as a secret** — it grants read *and* write.

## What this postage batch has paid for

Swarm has no "list the contents of a batch" API — a stamp is spent per
chunk and leaves no index, so the only record is the one kept here. Batch
`c931c8a5ee8def22…` (depth 19, immutable) has stamped, from this project:

| Content | Reference |
| --- | --- |
| Demo site, first upload (2026-08-11) | `1b8165e2600b36d4a4fc22562913ddffe51e42e8219a9ae117d1b87ed156bc0e` |
| Demo site via `deploy-swarm.sh` (2026-08-11) | `783558e4ef2f0dac15f3d7343542e95d5940fd64bbbf56ceff30ed79078ca597` |
| Demo site with the hang fixes (2026-08-12) | `6a68ec565eb4ab8ce7e8717062d42604e02235939ddb5b3b2a0dac662159db1c` |
| Demo site, blank-page build (2026-08-12) | `f5a886fe5d0944f6041c59112674858551bbffba70bb14a95b1f57fe32bfe2d2` |
| Demo site, hidden-notice build (2026-08-12) | `e440f795ac5a45eba43d809c21c6fce2b2ef21b05ef4aa96433801c3f6710160` |
| Demo site, pre-provider build (2026-08-12) | `065ca78cade341d0f0ccf1e1ce58f08a5ccfe70b21867167fb1657ca5e10f3ab` |
| Demo site, provider build (2026-08-16) | `70a886df12e6622f111a3f94d6aa2cb1422c1b1d80cfd70c8e6ea913e0b26868` |
| Demo site, provider-fix build (2026-08-17) | `f016a9c3e0959ca792b4bfecf0a30ffdf9ee545607400f374271aa9d19c97632` |
| Demo site, feed-owner-fix build (2026-08-17) | `90dd179caa528cb1111203ccef5f92d1fb1dd90475184edbbde950137935470f` |
| Demo site, /bzz storage build (2026-08-17) | `8f5345744eb4f4d18617b7c0720d2bdc5094d32e1d0c13ec48a1f6e4f116c463` |
| Demo site, browse-only-hint build (2026-08-17) | `f79856e396b740dbe949a9552a1f6cda6896d87ff4d964767c0e0dd84bf0e465` |
| Demo site, progress-naming build (2026-08-17) | `36a579f96eeb5da4fab548d0c2c4f55ce5cf4a4eeb4c5860376a5ca6f286b663` |
| Demo site, restore-retry build (2026-08-17) | `34f4d1caaf697181628a9d81b9ebc4cf43a82e3396639ac4f65f2bf767121d98` |
| Demo site, current (2026-08-17) | `9d2e0955adf4144ff6eb6af2164cbcbeff647a5e751fe50a13e969a3ae483192` |
| Sample document, current | `a2327967…` and image `7e5d6b37…` |
| Sample document, first (2026-08-12) | `7fe4bfc7…` and image `ecb4d591…` |
| Document snapshots + feed updates | reachable through each document's feed (needs its keys) |
| Test uploads from the integration suites | random payloads, not referenced anywhere |

Each site upload is a full ~11 MB copy. Content addressing means an
unchanged file keeps its reference and is not re-paid for; with the chunk
split, a rebuild re-uploads roughly a third of the site. Uploads use
`swarm-deferred-upload: false` so the call returns only once chunks are on
the network, and `deploy-swarm.sh` then checks `/stewardship`. Utilization
was 75% with ~19.7 days TTL at the last check; `checkStampHealth()` reports
both.

Note: fetching all six eager chunks in parallel from a node with few peers
can return the largest one short (HTTP 200 with a body smaller than its
`Content-Length`) — seen three times, always on the 2.4 MB chunk, always
under parallel load on a partially-warmed node, never once warm. The boot
screen's automatic retry covers it.

## Code

- Branch: https://github.com/petfold/fileverse-ddoc/tree/feat/swarm-storage
- Diff vs upstream (what the PR will show):
  https://github.com/fileverse/fileverse-ddoc/compare/main...petfold:fileverse-ddoc:feat/swarm-storage
- Handoff page for colleagues (several deployments stale):
  https://claude.ai/code/artifact/0accbe51-e565-4b8a-a94e-5c14a6c96dde
- Node issue found along the way:
  https://github.com/solardev-xyz/ant/issues/78

## Redeploying

From `demo/`, with a Bee node that has a usable postage batch:

```bash
./deploy-swarm.sh          # prints the new /bzz/<reference>/ URL
```

Requires Node.js ≥ 20.19 (the JavaScript build toolchain — unrelated to Bee
nodes). On Node.js 18 this repo's ESM `postcss.config.js` cannot be loaded;
the workaround used for these builds is an untracked
`demo/vite.node18.local.ts` declaring the PostCSS plugins inline, then:

```bash
npx vite build --config vite.node18.local.ts --base ./
tar -C dist -cf site.tar .
curl -X POST http://localhost:1633/bzz \
  -H "content-type: application/x-tar" \
  -H "swarm-postage-batch-id: <batch>" \
  -H "swarm-index-document: index.html" \
  -H "swarm-collection: true" \
  -H "swarm-deferred-upload: false" \
  --data-binary @site.tar
```

## Previous deployments

- `34f4d1ca…` (2026-08-17) — superseded: demanded a publishing grant to
  read a document that can never be published from a provider browser.
- `36a579f9…` (2026-08-17) — superseded: no retry when a freshly started
  node could not serve the document yet, and a restore deferred for
  permission never resumed.
- `f79856e3…` (2026-08-17) — superseded: restore progress named the postage
  step while the feed lookup was the step actually running.
- `8f534574…` (2026-08-17) — superseded: browse-only mode gave no hint where
  the node's mode is changed.
- `90dd179c…` (2026-08-17) — superseded: documents stored as raw chunk
  trees, unreadable through a browser-embedded node.
- `f016a9c3…` (2026-08-17) — superseded: a document shared by link opened
  empty in a provider browser, looked up under the wrong feed owner.
- `70a886df…` (2026-08-16) — superseded: no recovery when a just-started
  Swarm node refuses the app's scripts; sat on the loading screen forever.
- `065ca78c…` (2026-08-12) — superseded: node API only, so it could not run
  in a browser that blocks raw node access.
- `e440f795…` (2026-08-12) — superseded: the Swarm notice rendered under the
  editor's fixed toolbar, so failure states showed no explanation.
- `f5a886fe…` (2026-08-12) — broken: blank page (a callback was read before
  its initialiser, crashing React on mount). Fixed in `06e33a4`.
- `6a68ec56…` (2026-08-12) — superseded: no diagnostics, no postage
  purchase, single bundle.
- `783558e4…` (2026-08-11) — superseded: hangs indefinitely on a node
  without a postage batch.
- `1b8165e2…` (2026-08-11) — first upload, same limitation.
