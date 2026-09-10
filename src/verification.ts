import type { PatchFileSystem } from "./filesystem.js";

export type ExpectedState = { kind: "file"; data: Uint8Array; allowOther?: boolean } | { kind: "directory" } | null;
export type ObservedState = { kind: "file" | "directory" | "other"; data?: Uint8Array } | null;
export type VerificationFailure = { path: string; status: "mismatch" | "unreadable" | "not-checked"; message: string };
export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Read once per final file, sharing the observation with net-change reporting. */
export async function verifyFinalState(
  paths: Map<string, { label: string }>,
  expected: Map<string, ExpectedState>,
  fs: PatchFileSystem,
): Promise<{ observed: Map<string, ObservedState>; failures: VerificationFailure[] }> {
  const observed = new Map<string, ObservedState>();
  const failures: VerificationFailure[] = [];
  let cancelled = false;
  for (const [path, { label }] of paths) {
    if (cancelled) {
      failures.push({ path: label, status: "not-checked", message: "Verification stopped after cancellation" });
      continue;
    }
    try {
      if (!expected.has(path)) throw new Error("Expected final state is unavailable");
      await fs.checkPath(path);
      const info = await fs.inspect(path);
      const state = expected.get(path)!;
      observed.set(path, info);
      let mismatch: string | undefined;
      if (state === null) {
        if (info) mismatch = "Expected absence, but the path is still present";
      } else if (state.kind === "directory") {
        if (info?.kind !== "directory") mismatch = "Expected a directory";
      } else if (!info || info.kind !== "file" && !(state.allowOther && info.kind === "other")) {
        mismatch = "Expected a readable file";
      } else {
        const data = await fs.read(path);
        observed.set(path, { ...info, data });
        if (!equalBytes(state.data, data)) mismatch = "Final file bytes differ from the expected result";
      }
      if (mismatch) failures.push({ path: label, status: "mismatch", message: mismatch });
    } catch (cause) {
      failures.push({ path: label, status: "unreadable", message: String((cause as Error)?.message ?? cause) });
      cancelled = (cause as Error)?.name === "AbortError";
    }
  }
  return { observed, failures };
}
