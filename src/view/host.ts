/**
 * What the view asks of the platform and its backend: the backend's tools,
 * which keep the meetings and run the recording, and the events the
 * backend sends while it records and writes.
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import { hostCall, type ViewCall } from '@hearthscale/app/view';
import type { HostSlotNotification, ViewExtensionNotification } from '@hearthscale/app';

/** Why something failed, in the platform's words without the SDK's or the
 *  platform's code before them. */
export const words = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .replace(/^MCP error -?\d+: /, '')
    .replace(/^[a-z][a-z.-]*: /, '');

type Handler = (data: never) => void;

/** The platform's notifications to the view, by their method. */
type Notification = ViewExtensionNotification | HostSlotNotification;
type Params<M extends Notification['method']> = Extract<Notification, { method: M }>['params'];

export class Host {
  private readonly handlers = new Map<string, Set<Handler>>();
  /** Sends a request of the platform's bridge, typed by its method. */
  readonly call: ViewCall;

  constructor(readonly app: App) {
    this.call = hostCall(app as never);
    app.fallbackNotificationHandler = async ({ method, params }) => {
      if (method === 'hearthscale/events/event') {
        const { name, data } = params as { name: string; data: never };
        for (const fn of this.handlers.get(name) ?? []) fn(data);
      } else {
        for (const fn of this.handlers.get(method) ?? []) fn(params as never);
      }
    };
  }

  /** Calls a tool of the backend and answers its structured result; a
   *  failure rejects with the tool's words. `label` names the control
   *  the person pressed, for a card that asks them. */
  async tool<T>(name: string, args: object = {}, label?: string): Promise<T> {
    const result = await this.app.callServerTool({
      name,
      arguments: args as Record<string, unknown>,
      ...(label && { _meta: { 'hearthscale/label': label } }),
    });
    if (result.isError) {
      const text = result.content?.find((c) => c.type === 'text');
      throw new Error(text && 'text' in text ? text.text : `${label ?? 'The action'} could not be done. Try again.`);
    }
    return result.structuredContent as T;
  }

  /** Hears a notification of the platform by its method, typed by the
   *  SDK, or one of the backend's events by its name, until the answer is
   *  called. */
  on<M extends Notification['method']>(method: M, fn: (data: Params<M>) => void): () => void;
  on<T>(name: string, fn: (data: T) => void): () => void;
  on(name: string, fn: (data: never) => void): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(fn as Handler);
    this.handlers.set(name, set);
    return () => set.delete(fn as Handler);
  }
}
