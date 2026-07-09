'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useIdentity } from '@/lib/identity-context';
import { currentEpoch, nextMessageId } from '@/lib/rln';
import { encryptContent } from '@/lib/crypto-box';
import { getSessionColor, identiconDataUri, sessionHandle } from '@/lib/session-color';
import { getLocalMembership } from '@/lib/local-membership';
import type { PublicRoom } from '@/lib/room-types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send } from '@/components/icons';

interface SendOutcome {
  status?: string;
  ok?: boolean;
  reason?: string;
}

function describeSend(result: SendOutcome): { ok: boolean; message: string } {
  // Typed bad-proof failure carries `{ ok: false, reason: 'bad-proof' }` with no
  // `status` field.
  if (result.ok === false && result.reason === 'bad-proof') {
    return { ok: false, message: 'Rejected: invalid proof' };
  }
  switch (result.status) {
    case 'sent':
      return { ok: true, message: 'Message sent.' };
    case 'duplicate':
      return { ok: false, message: 'Duplicate message ignored.' };
    case 'banned':
      return {
        ok: false,
        message: 'You have been banned in this room (rate-limit collision detected).',
      };
    case 'rejected':
      return { ok: false, message: `Rejected: ${result.reason ?? 'invalid proof'}` };
    default:
      return { ok: false, message: `Unexpected result: ${result.status}` };
  }
}

export function MessageComposer({
  room,
  leaves,
  aesKey,
  onSent,
}: {
  room: PublicRoom;
  leaves: readonly string[];
  aesKey: CryptoKey | null;
  onSent: () => void;
}) {
  const trpc = useTRPC();
  const { identity } = useIdentity();
  const [content, setContent] = React.useState('');
  const [sending, setSending] = React.useState(false);
  // The session display identity (name + icon). Read after mount only: it lives
  // in sessionStorage, so reading it during SSR would mismatch on hydration.
  const [sessionSeed, setSessionSeed] = React.useState<string | null>(null);
  React.useEffect(() => {
    setSessionSeed(getSessionColor());
  }, []);

  const sendMutation = useMutation(trpc.message.send.mutationOptions());

  const userMessageLimit = BigInt(room.userMessageLimit);

  const aesRequired = room.encryption === 'AES';
  const aesReady = !aesRequired || aesKey !== null;

  async function handleSend() {
    if (!identity) {
      toast.error('Unlock your identity to send.');
      return;
    }
    const text = content.trim();
    if (text.length === 0) return;
    if (aesRequired && !aesKey) {
      toast.error('Enter the room password to send encrypted messages.');
      return;
    }

    setSending(true);
    try {
      // Sample the epoch ONCE, fresh, at send time and use it for both the
      // messageId reservation and the proof. A frozen mount-time epoch goes
      // stale and the server rejects the message as `bad-epoch`.
      const epoch = currentEpoch(room.rateLimit);

      // Reserve the next messageId for this (room, epoch). Throws if exhausted -
      // sending again this epoch would self-collide and trigger a ban.
      let messageId: bigint;
      try {
        messageId = nextMessageId(room.id, epoch, userMessageLimit);
      } catch {
        toast.error(
          'Rate limit reached for this epoch. Wait for the next window before sending again.',
        );
        return;
      }

      const wire = aesKey ? await encryptContent(aesKey, text) : text;

      // Lazy-load the prover (rlnjs touches Worker at module load - browser only).
      const { proveMessage } = await import('@/lib/rln');
      const proof = await proveMessage({
        rlnIdentifier: BigInt(room.rlnIdentifier),
        leaves,
        identity,
        content: wire,
        userMessageLimit,
        messageId,
        epoch,
      });

      // Serialize bigints -> strings so the proof survives JSON transport.
      const proofJson = JSON.parse(
        JSON.stringify(proof, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );

      // Author link for operator moderation (ban-author). The stock client
      // attaches its own random membership secret recorded at join time;
      // absent (older join, cleared storage) the send still goes through - the
      // RLN proof alone authorizes it.
      const authorToken = getLocalMembership(room.id)?.authorToken;

      const result = (await sendMutation.mutateAsync({
        roomId: room.id,
        content: wire,
        proof: proofJson,
        sessionColor: getSessionColor(),
        ...(authorToken ? { authorToken } : {}),
      })) as SendOutcome;

      const outcome = describeSend(result);
      if (outcome.ok) {
        setContent('');
        onSent();
      } else {
        toast.error(outcome.message);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const disabled = sending || !identity || !aesReady;

  return (
    <div className="mt-3 space-y-2">
      {sessionSeed ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={identiconDataUri(sessionSeed, getSessionColor())}
            alt=""
            className="h-5 w-5 shrink-0 rounded-full border"
          />
          <span>
            You appear as{' '}
            <span className="font-medium text-foreground">{sessionHandle(sessionSeed)}</span> in
            this room. This name and icon stay the same while this tab is open (a page refresh
            keeps them); open a new tab or session to get a fresh one.
          </span>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            aesReady ? 'Type a message (Enter to send)' : 'Enter the room password to chat'
          }
          rows={2}
          disabled={disabled}
          className="resize-none"
        />
        <Button
          onClick={handleSend}
          disabled={disabled || content.trim().length === 0}
          size="icon"
          className="h-[60px] w-12 shrink-0"
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {sending
          ? 'Generating proof and sending...'
          : `RLN-protected - up to ${room.userMessageLimit} message(s) per ${Math.round(room.rateLimit / 1000)}s window.`}
      </p>
    </div>
  );
}
