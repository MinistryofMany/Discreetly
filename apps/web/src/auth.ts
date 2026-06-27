import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@discreetly/db';
import { ministerProvider } from '@minister/client/auth-js';
import { captureDisclosure } from '@discreetly/api/disclosure';
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
    {
      ...ministerProvider({
        issuer: process.env.MINISTER_ISSUER!,
        clientId: process.env.MINISTER_CLIENT_ID!,
        clientSecret: process.env.MINISTER_CLIENT_SECRET,
        // Per-room minimal disclosure: the PROVIDER default discloses NO badges.
        // A global/top-level `signIn('minister')` therefore asks Minister only
        // for `openid profile`. Each room join requests that room's FULL required
        // badge set (model 2b) via the THIRD `signIn` arg in `join-panel.tsx`
        // (`{ scope }`), which Auth.js merges last and so overrides this static
        // default. Do not add badge scopes back here.
        scopes: ['openid', 'profile'],
      }),
      // Disclosure capture (model 2b). `profile(claims, tokens)` fires on EVERY
      // OAuth callback with the fresh `id_token` (`tokens.id_token`), BEFORE
      // account-linking. We use it because next-auth v5 beta.31 does NOT
      // re-`linkAccount` on a second sign-in for an already-linked account, so the
      // session-borne token (read from `Account.id_token`) would otherwise stay
      // frozen at the first sign-in and the gate would never see a second room's
      // freshly-disclosed badges. `captureDisclosure` verifies the fresh token,
      // records its disclosed badge TYPES into the durable `ProvenBadge` store,
      // and refreshes the stored `Account.id_token` - all keyed on the verified
      // `sub` (non-forgeable). It is fail-closed: any error is swallowed so a
      // capture failure never blocks sign-in (the gate then relies on the live
      // token alone, which under 2b still carries the room's full set).
      //
      // The returned object must match Auth.js's default OIDC profile shape so
      // `account.providerAccountId` stays the pairwise `sub` and user
      // creation/linking is unchanged.
      async profile(claims: Record<string, unknown>, tokens: { id_token?: string }) {
        const idToken = tokens.id_token;
        if (idToken) {
          try {
            await captureDisclosure(idToken, {
              issuer: process.env.MINISTER_ISSUER!,
              audience: process.env.MINISTER_CLIENT_ID!,
            });
          } catch (error) {
            // Fail-closed: never block sign-in on a capture failure. Log ONLY a
            // safe summary (the error message) for observability - NEVER the
            // id_token or any badge VC, which may carry token material / PII.
            // Mirrors the verifier's safe-warn style (services/api/src/minister/
            // verify.ts).
            console.warn(
              'disclosure capture failed; proceeding with sign-in:',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return {
          id: (claims.sub as string | undefined) ?? crypto.randomUUID(),
          name: (claims.name as string | undefined) ?? null,
          email: (claims.email as string | undefined) ?? null,
          image: (claims.picture as string | undefined) ?? null,
        };
      },
    },
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
