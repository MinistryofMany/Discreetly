import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@discreetly/db';
import { ministerProvider } from '@ministryofmany/client/auth-js';
import { decodeMinisterClaims } from '@/lib/minister-claims';
import { refreshMinisterAccountTokens } from '@/lib/minister-account';

// Auth.js v5 RP for Discreetly. Signs in via Minister using the
// `@ministryofmany/client` provider helper, which returns the same generic OIDC
// provider config Discreetly hand-rolled before (id 'minister', EdDSA, PKCE +
// state + nonce). Minister publishes /.well-known/openid-configuration, so
// Auth.js discovers authorize/token/userinfo/jwks from the issuer URL.
//
// Database-strategy sessions: the login session is an opaque session-id cookie
// backed by a `Session` row in Postgres (via the Prisma adapter). The adapter
// also persists the Minister OAuth account - including its `id_token` - in the
// `Account` table at sign-in. The browser still forwards that id_token to the
// API (the API re-verifies everything; it is the sole verification authority);
// the session callback reads it back from the Account row and decodes its
// payload for display only. Sign-out deletes the Session row server-side
// (Auth.js core calls `adapter.deleteSession` under database strategy), so the
// session is revoked, not merely cookie-cleared.
const MINISTER_PROVIDER_ID = 'minister';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // Database strategy: opaque cookie -> Session row. maxAge keeps the Auth.js
  // default of 30 days (30 * 24 * 60 * 60 s) so login lifetime is unchanged.
  // NOTE: the forwarded Minister id_token is short-lived (~10 min). Each sign-in
  // now re-persists the fresh token (see `events.signIn` below), so re-auth
  // always yields a fresh `session.idToken`. Mid-session (a login held longer
  // than the token lifetime) the header token still expires; the JOIN path
  // already mints a fresh per-room token, and refreshing the admin path
  // mid-session (offline_access refresh or on-demand mint) is a tracked
  // follow-up - see docs/auth-session-model.md.
  session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60 },
  providers: [
    ministerProvider({
      issuer: process.env.MINISTER_ISSUER!,
      clientId: process.env.MINISTER_CLIENT_ID!,
      clientSecret: process.env.MINISTER_CLIENT_SECRET,
      // F-3 (a): `ministerProvider` owns ONLY the badge-free GLOBAL header login
      // (`openid profile`). Per-room disclosure no longer rides Auth.js's
      // third-arg merge - it runs the SDK auth-code+PKCE flow at dedicated RP
      // routes (`/api/room-auth/start` + `/api/room-auth/callback`), which carry
      // `minister_policy` and mint a fresh per-room id_token handed straight to
      // the gate. The global login carries no badges, so its session token is
      // irrelevant to gating; there is no disclosure capture here anymore.
      scopes: ['openid', 'profile'],
    }),
  ],
  events: {
    // The Prisma adapter persists the Minister id_token via `linkAccount` only
    // on the FIRST account-link; on every later sign-in Auth.js core finds the
    // account and returns without re-persisting, so the stored token goes stale.
    // `events.signIn` fires on every sign-in (new and returning) AFTER the
    // Account row exists, with the fresh `account` from the token endpoint, so
    // re-persist the fresh tokens here. This is the only path that reaches the
    // fresh id_token under database strategy (no jwt callback runs). A missing
    // account (e.g. non-OAuth event) is a no-op.
    async signIn({ account }) {
      if (account?.provider === MINISTER_PROVIDER_ID) {
        await refreshMinisterAccountTokens(account);
      }
    },
  },
  callbacks: {
    // Under database strategy the session callback receives the adapter `user`
    // (not a JWT token). The Minister id_token was persisted on the Account row
    // at sign-in; read it back, expose it for the API-bound Authorization
    // header, and decode its payload (display only) to recover sub / name /
    // picture / minister_badges. Decoding never verifies - the API is the sole
    // verifier - so a malformed token must fail closed to empty display values.
    async session({ session, user }) {
      const account = await prisma.account.findFirst({
        where: { userId: user.id, provider: MINISTER_PROVIDER_ID },
        select: { id_token: true },
      });
      const idToken = account?.id_token ?? null;
      session.idToken = idToken;

      const claims = decodeMinisterClaims(idToken);
      session.sub = claims.sub;
      session.name = claims.name;
      session.picture = claims.picture;
      session.ministerBadges = claims.ministerBadges;
      session.anonEpoch = claims.anonEpoch;
      return session;
    },
  },
});

declare module 'next-auth' {
  interface Session {
    idToken: string | null;
    sub: string | null;
    name: string | null;
    picture: string | null;
    ministerBadges: string[];
    anonEpoch: number | null;
  }
}
