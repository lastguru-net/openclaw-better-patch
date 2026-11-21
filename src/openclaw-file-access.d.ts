// The SDK exports this runtime entry without declarations. Use the same
// root type that the pinned OpenClaw package re-exports at runtime.
declare module "openclaw/plugin-sdk/file-access-runtime" {
  export { root } from "@openclaw/fs-safe/root";
}
