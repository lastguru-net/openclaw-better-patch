import type { ObservedState } from "./verification.js";

export function contentByteLimit(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("returnContents must be a non-negative safe integer byte budget");
  }
  return value;
}
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
  byteLimit: number,
): ReturnedContents {
  const files: ReturnedFile[] = [];
  let remaining = byteLimit;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const [path, { label }] of paths) {
    const entry = { path: label, status: statuses.get(label)! };
    const state = observed.get(path)!;
    if (!state || state.kind === "directory") {
      files.push({ ...entry, omitted: state ? "directory" : "absent" });
      continue;
    }
    const data = state.data!;
    // Count persisted UTF-8 bytes, without decoding files that cannot fit.
    if (data.byteLength > remaining) {
      files.push({ ...entry, byteLength: data.byteLength, omitted: "size-limit" });
      continue;
    }
    const content = decoder.decode(data);
    remaining -= data.byteLength;
    files.push({ ...entry, byteLength: data.byteLength, content });
  }
  return { byteLimit, files };
}
