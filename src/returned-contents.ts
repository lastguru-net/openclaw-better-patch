import type { ObservedState } from "./verification.js";

export const CONTENT_BYTE_LIMIT = 64 * 1024;
type Status = "A" | "M" | "D" | "N";
export type ReturnedFile = { path: string; status: Status } & (
  | { content: string; byteLength: number }
  | { omitted: "size-limit"; byteLength: number }
  | { omitted: "absent" | "directory" }
);
export type ReturnedContents = { byteLimit: number; files: ReturnedFile[] };

/** Package verified observations only; no additional filesystem access. */
export function returnedContents(
  paths: Map<string, { label: string }>,
  observed: Map<string, ObservedState>,
  statuses: Map<string, Status>,
): ReturnedContents {
  const files: ReturnedFile[] = [];
  let remaining = CONTENT_BYTE_LIMIT;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();
  for (const [path, { label }] of paths) {
    const entry = { path: label, status: statuses.get(label)! };
    const state = observed.get(path)!;
    if (!state || state.kind === "directory") {
      files.push({ ...entry, omitted: state ? "directory" : "absent" });
      continue;
    }
    const data = state.data!;
    // JSON strings cannot be smaller than their UTF-8 data plus two quotes.
    // Avoid decoding huge files that cannot fit even before JSON escaping.
    if (data.byteLength + 2 > remaining) {
      files.push({ ...entry, byteLength: data.byteLength, omitted: "size-limit" });
      continue;
    }
    const content = decoder.decode(data);
    const cost = encoder.encode(JSON.stringify(content)).byteLength;
    if (cost > remaining) {
      files.push({ ...entry, byteLength: data.byteLength, omitted: "size-limit" });
      continue;
    }
    remaining -= cost;
    files.push({ ...entry, byteLength: data.byteLength, content });
  }
  return { byteLimit: CONTENT_BYTE_LIMIT, files };
}
