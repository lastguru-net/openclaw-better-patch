// OpenClaw 2026.9.2 exports this runtime entry without declarations.
// Its root export delegates directly to @openclaw/fs-safe 0.8.1.
declare module "openclaw/plugin-sdk/file-access-runtime" {
  export { root } from "@openclaw/fs-safe/root";
}
