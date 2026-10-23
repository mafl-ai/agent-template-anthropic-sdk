import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunner } from "../src/runner.js";

test("skip overlapping work and allow a later run", async () => {
  let release!: (value: string) => void;
  const runner = createRunner(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );

  const first = runner.run();
  assert.equal(await runner.run(), undefined);
  release("done");
  assert.equal(await first, "done");

  const second = runner.run();
  await Promise.resolve();
  release("again");
  assert.equal(await second, "again");
});

test("failure releases the guard", async () => {
  let count = 0;
  const runner = createRunner(async () => {
    if (++count === 1) throw new Error("offline");

    return "recovered";
  });
  await assert.rejects(runner.run(), /offline/);
  assert.equal(await runner.run(), "recovered");
});

test("shutdown aborts in-flight work and prevents further runs", async () => {
  const runner = createRunner(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  );

  const active = runner.run();
  await Promise.resolve();

  const rejected = assert.rejects(active, /aborted/);
  await runner.stop();
  await rejected;
  assert.equal(await runner.run(), undefined);
});
