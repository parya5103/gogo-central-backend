import assert from 'node:assert/strict';
import { PostgresRateLimitStore } from '../src/server/rate-limit-pg.ts';

const standardStore = new PostgresRateLimitStore(60_000, 'std');
const sensitiveStore = new PostgresRateLimitStore(60_000, 'sens');
const defaultStore = new PostgresRateLimitStore(60_000);

assert.equal(standardStore.prefix, 'std:');
assert.equal(sensitiveStore.prefix, 'sens:');
assert.notEqual(standardStore.prefix, sensitiveStore.prefix);
assert.equal(defaultStore.prefix, '');

console.log('PostgreSQL rate-limit namespace tests passed (4 assertions).');
