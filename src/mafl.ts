import { AgentError } from "./errors.js";
import { setTimeout as delay } from "node:timers/promises";
import { object } from "./lineup.js";
import { observeSkill } from "./compatibility.js";

export class MaflError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`MAFL request failed (${status}, ${code})`);
    this.name = "MaflError";
  }
}

export class MaflClient {
  constructor(
    private key: string,
    private timeoutMs: number,
    private fetcher: typeof fetch = fetch,
    private wait = (ms: number, signal: AbortSignal) =>
      delay(ms, undefined, { signal }),
  ) {}
  async request(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<any> {
    if (
      !/^\/(contests|agents|scoring)(\/|$)/.test(path) ||
      path.includes("..") ||
      path.includes("#")
    )
      throw new AgentError("Invalid MAFL path");

    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(`https://api.mafl.ai/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
      });

      if (attempt === 0 && response.status >= 500) {
        await response.body?.cancel();
        await this.wait(60000, signal);
        continue;
      }

      if (attempt === 0 && response.status === 429) {
        const retry = Date.parse(response.headers.get("Retry-After") ?? "");
        const ms = retry - Date.now();

        if (Number.isFinite(ms) && ms > 0 && ms <= 120000) {
          await response.body?.cancel();
          await this.wait(ms, signal);
          continue;
        }
      }

      let data: any;
      try {
        data = object(await response.json());
      } catch {
        throw new MaflError(response.status, "invalid_response");
      }

      if (!response.ok)
        throw new MaflError(
          response.status,
          typeof data.code === "string" && /^[a-z_]+$/.test(data.code)
            ? data.code
            : "unknown_error",
        );

      return data;
    }
  }
  async skill(signal: AbortSignal, cached?: { text: string; etag?: string }) {
    const response = await this.fetcher("https://mafl.ai/skill.md", {
      redirect: "error",
      headers:
        typeof cached?.etag === "string" && cached.etag
          ? { "If-None-Match": cached.etag }
          : {},
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    });

    const text =
      response.status === 304 && typeof cached?.text === "string"
        ? cached.text
        : response.ok
          ? await response.text()
          : undefined;

    if (!text) throw new AgentError("Unable to read MAFL skill");

    return {
      text,
      etag:
        response.headers.get("ETag") ??
        (response.status === 304 ? cached?.etag : undefined),
      ...observeSkill(text),
    };
  }
}
