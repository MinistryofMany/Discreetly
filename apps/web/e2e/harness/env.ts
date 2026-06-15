/**
 * Central e2e configuration: ports, URLs, and the isolated database. Distinct
 * from the dev ports (3000/3001/3002) so the suite never clashes with running
 * dev servers, and a dedicated `discreetly_e2e` database keeps state isolated.
 */
export const MOCK_OIDC_PORT = 3399;
export const API_PORT = 3398;
export const WEB_PORT = 3397;

export const MOCK_ISSUER = `http://localhost:${MOCK_OIDC_PORT}`;
export const MOCK_JWKS_URL = `${MOCK_ISSUER}/.well-known/jwks.json`;
export const MOCK_VC_ISSUER = 'did:web:mock.minister';
export const MOCK_CLIENT_ID = 'discreetly_dev';
export const MOCK_CLIENT_SECRET = 'e2e_mock_secret';

export const API_URL = `http://localhost:${API_PORT}`;
export const API_WS_URL = `ws://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Base admin connection (to the default `postgres` db) for CREATE DATABASE. */
const PG_USER = 'discreetly';
const PG_PASSWORD = 'discreetly';
const PG_HOST = 'localhost';
const PG_PORT = 5432;
export const E2E_DB_NAME = 'discreetly_e2e';

export const PG_ADMIN_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/postgres`;
export const E2E_DATABASE_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${E2E_DB_NAME}?schema=public`;

export const REDIS_URL = 'redis://localhost:6379';
