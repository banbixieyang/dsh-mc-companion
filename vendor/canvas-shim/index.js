/**
 * `canvas` compatibility shim for prismarine-viewer.
 *
 * prismarine-viewer builds its block texture atlas with node-canvas, which needs
 * a native build (blocked in this environment). @napi-rs/canvas is a prebuilt
 * N-API implementation exposing the same createCanvas / Canvas / Image API, so
 * this module is installed as `canvas` and simply re-exports it.
 *
 * Installed by scripts/install-viewer.mjs; not imported by the plugin itself.
 */
module.exports = require('@napi-rs/canvas')
