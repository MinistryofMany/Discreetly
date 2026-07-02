// One-off test-data seeder: creates two rooms (idempotent by slug).
//   - general-lobby : open (admit-all) — no badge required
//   - invite-holders: gated on a Minister `invite-code` badge
// Run: DATABASE_URL=... pnpm --filter @discreetly/api exec tsx scripts/seed-rooms.ts
import { prisma } from "@discreetly/db";
import { genId, randomBigInt } from "@ministryofmany/rln";

const rooms = [
  {
    name: "General Lobby",
    slug: "general-lobby",
    description: "Open room. Anyone signed in via Minister can join. No badge required.",
    rateLimit: 60_000,
    userMessageLimit: 10,
    accessPolicy: { allOf: [] as unknown[] },
  },
  {
    name: "Invite Holders",
    slug: "invite-holders",
    description: "Gated room. Requires a Minister invite-code badge to join.",
    rateLimit: 60_000,
    userMessageLimit: 10,
    accessPolicy: { badge: { type: "invite-code" } },
  },
];

async function main() {
  for (const r of rooms) {
    const existing = await prisma.room.findUnique({ where: { slug: r.slug } });
    if (existing) {
      console.log(`exists: ${r.slug} (${existing.id})`);
      continue;
    }
    const created = await prisma.room.create({
      data: {
        name: r.name,
        slug: r.slug,
        description: r.description,
        rlnIdentifier: genId(randomBigInt(), r.name).toString(),
        rateLimit: r.rateLimit,
        userMessageLimit: r.userMessageLimit,
        accessPolicy: r.accessPolicy as object,
      },
    });
    console.log(`created: ${created.slug} (${created.id}) policy=${JSON.stringify(r.accessPolicy)}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
