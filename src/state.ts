import { AgentError } from "./errors.js";
import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Lineup } from "./lineup.js";

export type State = {
  skill?: {
    text: string;
    etag?: string;
    version?: string;
    contentHash?: string;
  };
  pending?: { contestId: string; key: string; body: Lineup };
  last?: { contestId: string; body: Lineup };
  results?: Record<string, unknown>;
};

export async function loadState(dir: string): Promise<State> {
  try {
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));

    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      (state.pending &&
        (!/^\d{4}-W\d{2}$/.test(state.pending.contestId) ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(state.pending.key) ||
          !state.pending.body)) ||
      (state.last &&
        (!/^\d{4}-W\d{2}$/.test(state.last.contestId) || !state.last.body))
    )
      throw new AgentError("Invalid agent state");

    return state;
  } catch (e: any) {
    if (e.code === "ENOENT") return {};
    throw new AgentError("Unable to read agent state");
  }
}

export async function saveState(dir: string, state: State) {
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const temp = join(dir, `state-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, join(dir, "state.json"));

  const directory = await open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function acquireLock(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const path = join(dir, "run.lock");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();

      return () => unlink(path);
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;

      const pid = Number(await readFile(path, "utf8"));

      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new AgentError("Invalid run lock; inspect before removing");
      try {
        process.kill(pid, 0);
      } catch (e: any) {
        if (e.code === "ESRCH") {
          await unlink(path);
          continue;
        }
      }
      throw new AgentError("Another agent process is running");
    }
  }
  throw new AgentError("Unable to acquire run lock");
}
