/// <reference types="vite/client" />
/// <reference types="@iwsdk/vite-plugin-dev/client" />

/**
 * Build stamp injected by `define` in vite.config.ts. Used to version public
 * assets so a cached copy from a previous deploy cannot be paired with a new
 * bundle.
 */
declare const __BUILD_ID__: string;
