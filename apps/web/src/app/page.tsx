import { auth } from '@/auth';
import { RoomList } from '@/components/room-list';
import { LandingCta } from '@/components/landing-cta';
import { LogoMark } from '@/components/brand/logo';

const FEATURES = [
  {
    title: 'A pseudonym, not a profile',
    body: "The room can tell you belong there. It can't tell who you are, so what you say stands on its own.",
  },
  {
    title: 'Spam-resistant',
    body: 'Every room has a built-in speed limit on messages, so a flooder gets removed without anyone being unmasked.',
  },
  {
    title: 'You own your identity',
    body: "Your keys are created in this browser and never leave it. Back them up - if they're lost, we can't recover them, because we never had them.",
  },
  {
    title: 'Gated communities',
    body: 'A room can require a badge before you join, so everyone inside has cleared the same bar.',
  },
];

export default async function HomePage() {
  const session = await auth();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 md:py-14">
      <section className="mx-auto flex max-w-2xl flex-col items-center text-center">
        <LogoMark className="h-16 w-auto text-primary" />
        <h1 className="mt-6 text-3xl tracking-tight md:text-4xl">
          Prove you belong. Speak freely.
        </h1>
        <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground md:text-base">
          Each room sets its own bar for entry - a verified email, an invite, or being over 21 - and
          that&apos;s the only thing it ever learns about you. Once you&apos;re in, you take part
          under a pseudonym. No phone numbers, no real names, and some rooms keep no history at all.
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
            Rooms know you as a pseudonym - your account name is never shown or shared.
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
