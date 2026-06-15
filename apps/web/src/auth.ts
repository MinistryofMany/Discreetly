import NextAuth from 'next-auth';
import { ministerProvider } from '@minister/client/auth-js';
import { badgeScopes } from '@minister/client/badges';

// Auth.js v5 RP for Discreetly. Signs in via Minister using the
// `@minister/client` provider helper, which returns the same generic OIDC
// provider config Discreetly hand-rolled before (id 'minister', EdDSA, PKCE +
// state + nonce). Minister publishes /.well-known/openid-configuration, so
// Auth.js discovers authorize/token/userinfo/jwks from the issuer URL.
//
// JWT-strategy sessions (no DB). The relevant Minister id_token claims are
// copied onto the session so the browser can forward the id_token to the API
// (the API re-verifies everything) and render the user. The badge VC JWTs in
// `minister_badges` are carried RAW onto the session for the client-side
// preview decoder; the API is the sole verification authority.
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  providers: [
    ministerProvider({
      issuer: process.env.MINISTER_ISSUER!,
      clientId: process.env.MINISTER_CLIENT_ID!,
      clientSecret: process.env.MINISTER_CLIENT_SECRET,
      scopes: [
        'openid',
        'profile',
        ...badgeScopes([
          'email-domain',
          'invite-code',
          'oauth-account',
          'residency-country',
          'age-over-18',
        ]),
      ],
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.id_token) {
        token.idToken = account.id_token;
      }
      // For an OIDC provider, `profile` is the decoded id_token payload.
      if (profile) {
        const p = profile as {
          sub?: unknown;
          name?: unknown;
          picture?: unknown;
          minister_badges?: unknown;
        };
        if (typeof p.sub === 'string') token.ministerSub = p.sub;
        if (typeof p.name === 'string') token.ministerName = p.name;
        if (typeof p.picture === 'string') token.ministerPicture = p.picture;
        if (Array.isArray(p.minister_badges)) {
          token.ministerBadges = p.minister_badges.filter(
            (x): x is string => typeof x === 'string',
          );
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.idToken = (token.idToken as string | undefined) ?? null;
      session.sub = (token.ministerSub as string | undefined) ?? null;
      session.name = (token.ministerName as string | undefined) ?? null;
      session.picture = (token.ministerPicture as string | undefined) ?? null;
      session.ministerBadges =
        (token.ministerBadges as string[] | undefined) ?? [];
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
