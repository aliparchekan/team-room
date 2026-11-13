// A local model through Ollama, for work that should not use Claude or Codex:
// finding the questions agents ask the human, and summarizing discussions.
// Optional: when Ollama isn't running, callers fall back to rule-based results.
export type LocalModelStatus = { available: boolean; model: string | null; detail: string | null };

const STATUS_TTL_MS = 30_000;

export class OllamaClient {
  private cache: { at: number; status: LocalModelStatus } | null = null;

  constructor(
    readonly base = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    /** TEAM_ROOM_LOCAL_MODEL picks a model; "off" disables the local model entirely. */
    readonly preferred = process.env.TEAM_ROOM_LOCAL_MODEL ?? null,
  ) {}

  async status(force = false): Promise<LocalModelStatus> {
    if (this.preferred === "off") return { available: false, model: null, detail: "Turned off (TEAM_ROOM_LOCAL_MODEL=off)" };
    if (!force && this.cache && Date.now() - this.cache.at < STATUS_TTL_MS) return this.cache.status;
    let status: LocalModelStatus;
    try {
      const r = await fetch(`${this.base}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const models: any[] = (await r.json()).models ?? [];
      // Chat-capable models only (not embedding models).
      const usable = models.filter((m) => !Array.isArray(m.capabilities) || m.capabilities.includes("completion")).map((m) => String(m.name));
      const model = this.preferred && usable.includes(this.preferred) ? this.preferred : (usable[0] ?? null);
      status = model
        ? { available: true, model, detail: null }
        : { available: false, model: null, detail: this.preferred ? `${this.preferred} is not installed in Ollama` : "Ollama has no chat model installed" };
    } catch {
      status = { available: false, model: null, detail: "Ollama is not running" };
    }
    this.cache = { at: Date.now(), status };
    return status;
  }

  async chat(input: { system: string; user: string; json?: boolean; numCtx?: number; temperature?: number; timeoutMs?: number }): Promise<string> {
    const { model } = await this.status();
    if (!model) throw new Error("No local model available");
    const r = await fetch(`${this.base}/api/chat`, {
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs ?? 240_000),
      body: JSON.stringify({
        model,
        stream: false,
        ...(input.json ? { format: "json" } : {}),
        options: { temperature: input.temperature ?? 0.2, num_ctx: input.numCtx ?? 16384 },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const out = await r.json();
    return String(out.message?.content ?? "").trim();
  }
}
