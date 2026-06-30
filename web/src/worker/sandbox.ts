/* The "hands" on Cloudflare Containers. One instance per run (keyed by runId).
   Carries the model keys + the public ingest origin as container env (from Worker
   secrets); the in-container server.mjs receives the per-job body and runs
   agent.mjs. sleepAfter is long so a ~30-min run isn't reaped while it works. */
import { Container } from "@cloudflare/containers";
import type { Env } from "./index";

export class SandboxContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "45m";

  constructor(ctx: Container<Env>["ctx"], env: Env) {
    super(ctx, env);
    this.envVars = {
      INGEST_BASE: env.PUBLIC_ORIGIN ?? "",
      ...(env.BEDROCK_API_KEY
        ? {
            BEDROCK_API_KEY: env.BEDROCK_API_KEY,
            BEDROCK_MODEL: env.BEDROCK_MODEL ?? "us.anthropic.claude-opus-4-8",
            BEDROCK_REGION: env.BEDROCK_REGION ?? "us-east-1",
          }
        : {}),
      ...(env.CEREBRAS_API_KEY
        ? { CEREBRAS_API_KEY: env.CEREBRAS_API_KEY, CEREBRAS_MODEL: env.CEREBRAS_MODEL ?? "gemma-4-31b" }
        : {}),
    };
  }

  override onError(error: unknown) {
    console.log("[sandbox container] error:", error);
  }
}
