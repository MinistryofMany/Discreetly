import { publisher, makeSubscriber, roomChannel } from './redis.js';

export interface BroadcastMessage {
  id: string;
  roomId: string;
  epoch: string;
  content: string;
  sessionColor?: string;
  createdAt: string;
}

export async function publishMessage(msg: BroadcastMessage): Promise<void> {
  await publisher().publish(roomChannel(msg.roomId), JSON.stringify(msg));
}

/** Async iterator yielding messages published to a room until the signal aborts. */
export async function* roomMessages(
  roomId: string,
  signal: AbortSignal,
): AsyncGenerator<BroadcastMessage> {
  const sub = makeSubscriber();
  const queue: BroadcastMessage[] = [];
  let wake: (() => void) | undefined;
  sub.on('message', (_ch, payload) => {
    queue.push(JSON.parse(payload) as BroadcastMessage);
    wake?.();
  });
  await sub.subscribe(roomChannel(roomId));
  try {
    while (!signal.aborted) {
      while (queue.length) yield queue.shift()!;
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      wake = undefined;
    }
  } finally {
    await sub.quit();
  }
}
