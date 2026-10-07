/// <reference types="vite/client" />
/// <reference types="@iwsdk/vite-plugin-dev/client" />
declare global {
  const __WEATHER_ROOM_REVISION__: string;
  /** Injected by index.html; shows pre-UI failures instead of a white page. */
  interface Window {
    __showBootError?: (detail: unknown) => void;
  }
}
export {};
