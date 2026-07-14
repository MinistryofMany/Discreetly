/**
 * GET /api/minister-anon/rp-mix - deliver the signed-in user's Minister
 * pairwise `sub` and the operator-provisioned MINISTER_ANON_RP_MIX_SECRET to
 * the browser for the Ministry anonymous-identity handoff (anon-identity
 * master spec 9.2). Served per request by our own server so the secret is
 * never baked into the public bundle (and never captured at image build time
 * by static prerendering).
 *
 * A signed-in user reading their own app's mix secret is the spec's intended
 * posture: the mix secret alone derives nothing (the per-app secret never
 * reaches any server, this one included), and it does not help one user
 * attack another. Signed-out requests get 401 - there is no sub to key the
 * seed cache by.
 *
 * FAIL-CLOSED: when the env var is unset, malformed, or shorter than 32
 * bytes, `mixSecret` is null (the client then derives nothing and keeps
 * existing behavior); a SET-but-invalid value additionally warns in the
 * server log so the operator can see the misconfiguration. The secret value
 * itself is never logged.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';

/** >= 32 bytes, hex-encoded (>= 64 hex chars, even length). See .env.example. */
function validMixSecret(raw: string): boolean {
  return /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 && raw.length >= 64;
}

export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.sub) {
    return new Response(null, { status: 401 });
  }

  const raw = process.env.MINISTER_ANON_RP_MIX_SECRET;
  let mixSecret: string | null = null;
  if (raw !== undefined && raw !== '') {
    if (validMixSecret(raw)) {
      mixSecret = raw;
    } else {
      console.warn(
        'MINISTER_ANON_RP_MIX_SECRET is set but is not >= 32 bytes of hex; ' +
          'the Ministry anonymous-identity handoff is disabled (fail-closed).',
      );
    }
  }

  return NextResponse.json(
    { sub: session.sub, mixSecret },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
