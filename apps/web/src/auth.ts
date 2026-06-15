import NextAuth from 'next-auth';

// Auth.js v5 RP for Discreetly. Signs in via Minister using a generic OIDC
// provider. Minister publishes /.well-known/openid-configuration, so Auth.js
// discovers authorize/token/userinfo/jwks from the issuer URL.
//
// JWT-strategy sessions (no DB). The relevant Minister id_token claims are
// copied onto the session so the browser can forward the id_token to the API
// (the API re-verifies everything) and render the user.
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  providers: [
    {
      id: 'minister',
      name: 'Minister',
      type: 'oidc',
      issuer: process.env.MINISTER_ISSUER,
      clientId: process.env.MINISTER_CLIENT_ID,
      clientSecret: process.env.MINISTER_CLIENT_SECRET,
      authorization: {
        params: {
          scope:
            'openid profile badge:email-domain badge:invite-code badge:oauth-account badge:residency-country badge:age-over-18',
        },
      },
      checks: ['pkce', 'state', 'nonce'],
    },
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
