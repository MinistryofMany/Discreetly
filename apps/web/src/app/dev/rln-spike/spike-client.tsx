'use client';

import { useState } from 'react';
import { Identity } from '@semaphore-protocol/identity';
import type { AppIdentity } from '@/lib/identity';
import {
  SPIKE_CONTENT,
  SPIKE_DECOY_LEAVES,
  SPIKE_EPOCH,
  SPIKE_IDENTITY_SEED,
  SPIKE_MESSAGE_ID,
  SPIKE_RLN_IDENTIFIER,
  SPIKE_USER_MESSAGE_LIMIT,
} from './fixture';

interface SpikeWindow extends Window {
  __rlnSpikeProof?: string;
  __rlnSpikeError?: string;
}

function seededIdentity(): AppIdentity {
  const id = new Identity(SPIKE_IDENTITY_SEED);
  return { serialized: id.toString(), secret: id.secret, commitment: id.commitment };
}

export function RlnSpike() {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState<string>('');

  async function run() {
    setStatus('running');
    setDetail('');
    const w = window as SpikeWindow;
    try {
      // Lazy-load the RLN module in the browser only: rlnjs touches `Worker` at
      // module load, which is undefined during SSR.
      const { proveMessage, rateCommitmentFor } = await import('@/lib/rln');
      const identity = seededIdentity();
      const leaf = rateCommitmentFor(identity, SPIKE_USER_MESSAGE_LIMIT);
      // This identity's leaf plus decoys, in a fixed order the node verifier mirrors.
      const leaves = [leaf.toString(), ...SPIKE_DECOY_LEAVES];

      const proof = await proveMessage({
        rlnIdentifier: SPIKE_RLN_IDENTIFIER,
        leaves,
        identity,
        content: SPIKE_CONTENT,
        userMessageLimit: SPIKE_USER_MESSAGE_LIMIT,
        messageId: SPIKE_MESSAGE_ID,
        epoch: SPIKE_EPOCH,
      });

      // Serialize with bigint -> string so the proof survives JSON transport.
      const json = JSON.stringify(proof, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      w.__rlnSpikeProof = json;
      setStatus('done');
      setDetail(json);
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      w.__rlnSpikeError = msg;
      setStatus('error');
      setDetail(msg);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: 'monospace' }}>
      <h1>RLN browser-proving spike</h1>
      <button id="run-spike" onClick={run} disabled={status === 'running'}>
        Generate proof
      </button>
      <p id="spike-status">status: {status}</p>
      <pre
        id="spike-detail"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxWidth: 900 }}
      >
        {detail}
      </pre>
    </main>
  );
}
