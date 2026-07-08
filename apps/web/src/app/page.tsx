import { auth } from '@/auth';
import { RoomList } from '@/components/room-list';
import { LandingCta } from '@/components/landing-cta';
import { LogoMark } from '@/components/brand/logo';

const FEATURES = [
  {
    title: 'True anonymity',
    body: 'Chat without revealing who you are, backed by Semaphore zero-knowledge proofs.',
  },
  {
    title: 'Spam-resistant',
    body: 'Rate-Limiting Nullifiers stop spam without ever identifying anyone.',
  },
  {
    title: 'You own your identity',
    body: 'Your keys live only in this browser. Back them up - once lost, they are gone.',
  },
  {
    title: 'Gated communities',
    body: 'Rooms can require verifiable credential badges before you can join.',
  },
];

export default async function HomePage() {
  const session = await auth();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 md:py-14">
      <section className="mx-auto flex max-w-2xl flex-col items-center text-center">
        <LogoMark className="h-16 w-auto text-primary" />
        <h1 className="mt-6 text-3xl tracking-tight md:text-4xl">
          Welcome to Discreetly
        </h1>
        <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground md:text-base">
          Anonymous, federated, zero-knowledge group chat. Prove you belong with
          verifiable credential badges, then send rate-limited messages - no
          accounts, no phone numbers, no tracking.
        </p>
        <LandingCta />
      </section>

      <section className="mx-auto mt-10 max-w-3xl rounded-lg border border-border bg-card p-5 md:p-6">
        <h2 className="text-lg">What is Discreetly?</h2>
        <div className="mt-4 h-px bg-border" />
        <ul className="mt-4 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-2.5">
              <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span className="text-sm leading-relaxed">
                <span className="font-medium text-foreground">{f.title}.</span>{' '}
                <span className="text-muted-foreground">{f.body}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {session ? (
        <section className="mx-auto mt-8 max-w-3xl rounded-md border border-border bg-card p-4">
          <p className="text-sm">Signed in.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            You are anonymous - no account name is shown or shared.
          </p>
        </section>
      ) : null}

      <section id="rooms" className="mt-12 scroll-mt-20">
        <div className="mb-4 flex items-center gap-3">
          <h2 className="text-xl">Public rooms</h2>
          <span className="h-px flex-1 bg-border" />
        </div>
        <RoomList />
      </section>
    </div>
  );
}
