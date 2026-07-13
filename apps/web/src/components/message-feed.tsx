'use client';

import * as React from 'react';
import { decryptContent, isEncryptedEnvelope } from '@/lib/crypto-box';
import { avatarDataUri, sessionHandle } from '@/lib/session-color';
import type { ChatBroadcast, FeedItem } from '@/lib/broadcast-types';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Decrypt (if needed) and render a single chat message. For AES rooms `aesKey`
 * is provided; plaintext rooms pass null and content is shown verbatim.
 */
function ChatRow({
  msg,
  aesKey,
  onDelete,
  onBanAuthor,
}: {
  msg: ChatBroadcast;
  aesKey: CryptoKey | null;
  /** Operator-only: tombstone this message. Absent for non-operators. */
  onDelete?: (id: string) => void;
  /** Operator-only: ban this message's author (server resolves the link). */
  onBanAuthor?: (id: string) => void;
}) {
  const color = msg.sessionColor ?? '#64748b';
  const seed = msg.sessionColor ?? msg.id;
  // A tombstoned row carries the operator marker as its content (not ciphertext);
  // never run AES decryption on it.
  const [text, setText] = React.useState<string>(() =>
    !msg.deleted && aesKey && isEncryptedEnvelope(msg.content) ? '' : msg.content,
  );
  const [decryptFailed, setDecryptFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (!msg.deleted && aesKey && isEncryptedEnvelope(msg.content)) {
      decryptContent(aesKey, msg.content)
        .then((plain) => {
          if (!cancelled) {
            setText(plain);
            setDecryptFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) setDecryptFailed(true);
        });
    } else {
      setText(msg.content);
      setDecryptFailed(false);
    }
    return () => {
      cancelled = true;
    };
  }, [aesKey, msg.content, msg.deleted]);

  if (msg.deleted) {
    return (
      <div className="flex items-start gap-3 px-1 py-1.5" data-deleted="true">
        <Avatar className="h-8 w-8 border border-muted">
          <AvatarFallback className="bg-muted" />
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="text-sm italic text-muted-foreground">{text}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3 px-1 py-1.5">
      <Avatar className="h-8 w-8 border" style={{ borderColor: color }}>
        <AvatarImage src={avatarDataUri(seed)} alt="" />
        <AvatarFallback style={{ backgroundColor: color }} />
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium" style={{ color }}>
            {sessionHandle(seed)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {formatTime(msg.createdAt)}
          </span>
          {onDelete || onBanAuthor ? (
            <span className="ml-auto flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
              {onDelete ? (
                <button
                  type="button"
                  aria-label="Remove message"
                  className="text-[10px] text-destructive hover:underline"
                  onClick={() => onDelete(msg.id)}
                >
                  remove
                </button>
              ) : null}
              {onBanAuthor ? (
                <button
                  type="button"
                  aria-label="Ban message author"
                  className="text-[10px] text-destructive hover:underline"
                  onClick={() => onBanAuthor(msg.id)}
                >
                  ban author
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
        {decryptFailed ? (
          <p className="text-sm italic text-destructive">
            [unable to decrypt - wrong room password?]
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
        )}
      </div>
    </div>
  );
}

function SystemRow({ text, createdAt }: { text: string; createdAt: string }) {
  return (
    <div className="my-1 flex items-center gap-2 px-1">
      <div className="h-px flex-1 bg-border" />
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        {text}
        <span className="ml-1 opacity-60">{formatTime(createdAt)}</span>
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function MessageFeed({
  items,
  aesKey,
  loading,
  ephemeral = false,
  onDelete,
  onBanAuthor,
}: {
  items: FeedItem[];
  aesKey: CryptoKey | null;
  loading: boolean;
  /** EPHEMERAL room: keeps no history, so the empty state says so. */
  ephemeral?: boolean;
  /** Operator-only: tombstone a message by id. Absent for non-operators. */
  onDelete?: (id: string) => void;
  /** Operator-only: ban a message's author by message id. */
  onBanAuthor?: (id: string) => void;
}) {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items.length]);

  return (
    <ScrollArea className="h-full rounded-md border bg-card">
      <div className="flex flex-col gap-0.5 p-3">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {loading
              ? 'Connecting...'
              : ephemeral
                ? 'This room keeps no history. Messages appear here only while you are in the room.'
                : 'No messages yet. Say something.'}
          </p>
        ) : (
          items.map((item) => {
            // A tombstone is applied in place by RoomView (never stored as a
            // feed item), so items only ever hold 'message' or 'system'.
            if (item.broadcast.kind === 'message') {
              return (
                <ChatRow
                  key={item.key}
                  msg={item.broadcast}
                  aesKey={aesKey}
                  onDelete={item.broadcast.deleted ? undefined : onDelete}
                  onBanAuthor={item.broadcast.deleted ? undefined : onBanAuthor}
                />
              );
            }
            if (item.broadcast.kind === 'system') {
              return (
                <SystemRow
                  key={item.key}
                  text={item.broadcast.text}
                  createdAt={item.broadcast.createdAt}
                />
              );
            }
            return null;
          })
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
