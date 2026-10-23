// Only locally authored, credential-free messages may be printed to logs.

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}
