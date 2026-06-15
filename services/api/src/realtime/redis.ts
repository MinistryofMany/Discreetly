import Redis from 'ioredis';
import { getConfig } from '../config.js';

let pub: Redis | undefined;
export function publisher(): Redis {
  return (pub ??= new Redis(getConfig().REDIS_URL));
}
export function makeSubscriber(): Redis {
  return new Redis(getConfig().REDIS_URL);
}
export const roomChannel = (roomId: string): string => `room:${roomId}`;
