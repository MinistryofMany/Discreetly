import { RlnSpike } from './spike-client';

/**
 * De-risk spike for browser RLN proving (Phase 4.2). This route exists only to
 * prove that `rlnjs` / `ffjavascript` / wasm bundle and run under Next, and that
 * a browser-generated proof is server-verifiable. It performs no network calls
 * to the API and reads no user data; it is harmless in any environment.
 */
export const dynamic = 'force-dynamic';

export default function RlnSpikePage() {
  return <RlnSpike />;
}
