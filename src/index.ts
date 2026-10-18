// Worker entry: only handler exports are allowed here (workerd rejects other named exports).
import type { Env } from './config/env.ts';
import { handleFetch, handleScheduled } from './app.ts';
import { logError } from './security/redaction.ts';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      handleScheduled(env).catch((e) => {
        logError('scheduled', e);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
