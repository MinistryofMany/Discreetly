import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@discreetly/db';
import { ministerProvider } from '@minister/client/auth-js';
import { decodeMinisterClaims } from '@/lib/minister-claims';

// Auth.js v5 RP for Discreetly. Signs in via Minister using the
// `@minister/client` provider helper, which returns the same generic OIDC
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
  // NOTE: the forwarded Minister id_token is short-lived (~10 min) and has no
  // refresh path, so gated API calls fail once it expires until re-auth - a
  // pre-existing limitation, documented in docs/auth-session-model.md.
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
  }
}
