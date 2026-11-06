/**
 * What the history asks of its backend: the backend's tools, and the events it
 * sends when the history changes.
 */
import type { App } from '@modelcontextprotocol/ext-apps';

/** Why something failed, in the platform's words without the SDK's or the
 *  platform's code before them. */
export const words = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .replace(/^MCP error -?\d+: /, '')
    .replace(/^[a-z][a-z.-]*: /, '');

export class Host {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  constructor(private readonly app: App) {
    app.fallbackNotificationHandler = async ({ method, params }) => {
      if (method !== 'hearthscale/events/event') return;
      const { name, data } = params as { name: string; data?: unknown };
      for (const fn of this.handlers.get(name) ?? []) fn(data);
    };
  }

  /** Calls a tool of the backend and answers its structured result; a
   *  failure rejects with the tool's words. */
  async tool<T>(name: string, args: object = {}): Promise<T> {
    const result = await this.app.callServerTool({
      name,
      arguments: args as Record<string, unknown>,
    });
    if (result.isError) {
      const text = result.content?.find((c) => c.type === 'text');
      throw new Error(text && 'text' in text ? text.text : 'The action could not be done.');
    }
    return result.structuredContent as T;
  }

  /** Hears one of the backend's events by its name, until the answer is
   *  called. */
  on(name: string, fn: (data: unknown) => void): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(fn);
    this.handlers.set(name, set);
    return () => set.delete(fn);
  }
}
