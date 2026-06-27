/**
 * E2E database lifecycle + seed/query helpers.
 *
 * Uses an isolated `discreetly_e2e` database so the suite never mutates the dev
 * DB. `prepareDatabase()` creates it (idempotent) and runs `prisma migrate
 * deploy`; `getPrisma()` returns a client bound to it for seeding admin users
 * and asserting DB truth from specs.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient } from '@discreetly/db';
import { E2E_DB_NAME, E2E_DATABASE_URL, PG_ADMIN_URL } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const dbPkg = join(repoRoot, 'packages', 'db');

let prisma: PrismaClient | undefined;

/** Create the e2e database if absent, then apply migrations. */
export async function prepareDatabase(): Promise<void> {
  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [E2E_DB_NAME]);
    if (exists.rowCount === 0) {
      // Identifier is a constant, not user input.
      await admin.query(`CREATE DATABASE ${E2E_DB_NAME}`);
    }
  } finally {
    await admin.end();
  }

  // Apply migrations against the e2e database via the db package's prisma CLI.
  execFileSync(join(dbPkg, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    cwd: dbPkg,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: 'inherit',
  });
}

export function getPrisma(): PrismaClient {
  prisma ??= new PrismaClient({ datasources: { db: { url: E2E_DATABASE_URL } } });
  return prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}

/** Remove all mutable rows so each spec file starts clean. Admins are reseeded. */
export async function resetData(): Promise<void> {
  const db = getPrisma();
  // Order respects FKs (messages/leaves/bans -> memberships -> rooms).
  await db.$transaction([
    db.message.deleteMany(),
    db.membershipLeaf.deleteMany(),
    db.ban.deleteMany(),
    db.membership.deleteMany(),
    db.room.deleteMany(),
    db.auditLog.deleteMany(),
    db.adminUser.deleteMany(),
    // Per-room SDK disclosure flow rows: clear in-flight/leftover flows so each
    // spec starts clean. There is NO durable badge store anymore (Path B).
    db.roomAuthFlow.deleteMany(),
    // Auth.js database-session rows (Session -> Account -> User, FK order). The
    // e2e database persists across runs, so a STALE `Account.id_token` from a
    // prior run would otherwise survive: next-auth v5 beta.31 does NOT
    // re-`linkAccount` (does not refresh `Account.id_token`) on a second sign-in
    // for an already-linked account, so a global header sign-in would forward
    // the prior run's token - signed by a now-dead mock-issuer key - and every
    // gated/open join would fail signature verification. Clearing these makes
    // each global sign-in mint and store a FRESH token. (Phase 3 removed the
    // `captureDisclosure` profile() workaround that used to refresh the token.)
    db.session.deleteMany(),
    db.account.deleteMany(),
    db.user.deleteMany(),
  ]);
}

export async function seedAdmin(pairwiseSub: string, label = 'e2e-admin'): Promise<void> {
  const db = getPrisma();
  await db.adminUser.upsert({
    where: { pairwiseSub },
    update: { label },
    create: { pairwiseSub, label },
  });
}
