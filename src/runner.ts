export function createRunner<T>(work: (signal: AbortSignal) => Promise<T>) {
  let active: Promise<T> | undefined;
  let controller: AbortController | undefined;
  let stopping = false;

  return {
    async run(): Promise<T | undefined> {
      if (stopping || active) return undefined;
      controller = new AbortController();
      active = Promise.resolve().then(() => work(controller!.signal));
      try {
        return await active;
      } finally {
        active = undefined;
        controller = undefined;
      }
    },
    async stop() {
      stopping = true;
      controller?.abort();
      await active?.catch(() => undefined);
    },
  };
}
