# dDoc on swarm-collaborative-docs: plan (proposal, 2026-10-09)

The shared plan, its reasons and its open decisions live in swarmtyp: `../swarmtyp/docs/plan.md`, section "Alongside swarmtyp". The encryption design is draft 17 in `../swarmtyp/docs/upstream/swarm-collaborative-docs.md`. This file holds what is specific to dDoc.

**Where dDoc stands.** Documents and images can live on Swarm already (this fork's storage modules: encrypted snapshots with version history on a single-writer feed, encrypted images, stamp helpers, a transport for a Bee node or `window.swarm`). The storage-agnostic props went upstream as fileverse/fileverse-ddocs#562 (open, pinged 2026-10-09); the Swarm modules' own pull request was never opened. Live editing still goes through Fileverse's Socket.IO server: `package/sync-local` (`SyncManager`, `socketClient`, `presence`, `floor`, `session-tools`), with every update ECIES-encrypted to the room's `roomKey`.

**What changes in the fork.**
- A `SwarmSyncManager` next to `SyncManager`, chosen by a collaboration prop: it opens a `SwarmDoc` session (SwarmRtc transport) and hands its `Y.Doc` to the editor. Tiptap's collaboration extension binds to the document at editor creation, so the editor is built on `swarmDoc.doc` itself, as swarmtyp does with CodeMirror, not on a copy.
- Carets: `package/extensions/sync-cursor.ts` reads a Yjs Awareness (`yjsSetup.awareness`, user name and colour through `setLocalStateField('user', …)`). Feed a local Awareness from the library's presence events and publish the local state through it. ProseMirror carets are Yjs relative positions, which the library's `CursorPosition { anchor, head, scope }` cannot carry: this needs the free-form presence payload proposed for swarm-collaborative-docs.
- Keep the single-writer feed module for explicit saved versions and publishing; live editing uses the library's per-session feeds.
- Links: the library's invite (`v=1&k=…&h=…` in the fragment) in place of Fileverse's room key in the link; key derivation then follows draft 17.
- Encryption: today's ECIES-to-`roomKey` disappears with the server. Its replacement is the library's encryption option (draft 17), so this step waits for it, or for the storage interface of swarm-collaborative-docs#20, which gives the fork a place to encrypt in the meantime.

**Steps here.** F0: a spike in the demo, two browsers on one document through the Swarm Desktop node, carets through the Awareness bridge, snapshot sizes measured. F1: `SwarmSyncManager` behind the existing interface. F2 encryption, F3 Freedom, as in the shared plan.

**Licence and naming.** AGPL-3.0, as upstream; every deployment links its source; not presented as a Fileverse product.
