# Vendored Minecraft 26.3 data

`mc-data-26.3/` holds the Minecraft **26.3 (protocol 777)** data set that no
released PrismarineJS package ships. It is installed into `minecraft-data` by
`scripts/install-263-compat.mjs` (run automatically on `npm install`).

## Provenance

| | |
|---|---|
| Source | [PrismarineJS/minecraft-data](https://github.com/PrismarineJS/minecraft-data), branch `pc-26.3-support` (PR [#1300](https://github.com/PrismarineJS/minecraft-data/pull/1300), [#1301](https://github.com/PrismarineJS/minecraft-data/pull/1301)) |
| License | MIT (same as minecraft-data); this repository is MIT as well |
| Files | `version.json`, `protocol.json`, `blocks.json`, `items.json`, `entities.json`, `blockCollisionShapes.json`, `foods.json`, `recipes.json` |
| Fetched | `node tools/mcdata263/sync-263.mjs` (re-runs the download and the checks below) |

Upstream has not published 26.3 to npm: minecraft-data 3.117.0, node-minecraft-protocol
1.68.0, mineflayer 4.39.0 and prismarine-chunk 1.41.0 all stop at 26.1/26.2. The data
is vendored so the plugin does not depend on unreleased branches at install time.

## What we verified (not taken on trust)

1. **Packet ids** come from Mojang's own server jar, not from the branch.
   `node tools/mcdata263/run-reports.mjs <server.jar> <out>` runs the vanilla data
   generator; `verify-263.mjs` then learns protodef-name ↔ Mojang-name pairs from
   26.1 and checks every installed id against that report. Current result:
   **253 packets match, 6 new packets (`post_effects` ×2, `add_transient_block`,
   `swing_animation`, `punch`, `spectator_action`), 0 problems.**
   The two report files used offline live in `tools/mcdata263/reports/`.
2. **Data tables** match the official registry dump: 1286 blocks / 1658 items /
   161 entity types / 35723 block states / dataVersion 5023.
3. **Behaviour** was checked against a live Paper 26.3 server: login +
   configuration, chunk and light decoding, position sync, chat, block placement
   and read-back, schematic build (9/9 blocks), survival past the tick
   enforcement window, and entity tracking of a second moving bot.

## Local modifications (applied at install time, not stored here)

`protocol.json` is corrected by `fixProtocol263()` while copying:

* `punch` (serverbound `0x2e`) is redefined as **fieldless** — 26.3 dropped the
  hand field that 26.1's `arm_animation` carried;
* `0x3f` is renamed from `arm_animation` to `spectator_action` (entity id);
* `teleport_confirm` gains/keeps the echoed position and rotation, with the
  `yRot`/`xRot` fields renamed to `yaw`/`pitch` to match mineflayer's call site.

Everything else in the repository (`scripts/`, `tools/`) is original work; the
server jars used for extraction are build artifacts and are **not** committed.
