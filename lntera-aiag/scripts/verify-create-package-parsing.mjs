#!/usr/bin/env node
/**
 * Offline checks for TikTok Create Package response parsing + manual QA checklist.
 *   node scripts/verify-create-package-parsing.mjs
 */
import { pathToFileURL } from 'node:url';

const base = pathToFileURL(process.cwd() + '/src/mastra/integrations/tiktok/').href;
const { extractPackageIdsFromTiktokCreatePackagesData } = await import(base + 'create-package-parse.ts');

let failed = 0;
function check(name, ok, info) {
  const tag = ok ? 'PASS' : 'FAIL';
  if (!ok) failed++;
  console.log(`[${tag}] ${name}${info ? ' — ' + info : ''}`);
}

check('single package_id on data', (() => {
  const ids = extractPackageIdsFromTiktokCreatePackagesData({ package_id: 'p1' });
  return ids.length === 1 && ids[0] === 'p1';
})());

check('packages array with id', (() => {
  const ids = extractPackageIdsFromTiktokCreatePackagesData({
    packages: [{ id: 'a' }, { id: 'b' }],
  });
  return ids.join(',') === 'a,b';
})());

check('dedupes duplicate ids', (() => {
  const ids = extractPackageIdsFromTiktokCreatePackagesData({
    packages: [{ id: 'x' }, { id: 'x' }],
  });
  return ids.length === 1 && ids[0] === 'x';
})());

console.log('');
console.log('Manual QA (real TikTok shop):');
console.log('1. create-fulfillment-package with orders:[{ id: <order_id>, platform: tiktok, shopId? }]');
console.log('2. get-order-details on same order — expect packageIds populated');
console.log('3. confirm-order-fulfillment with same order id or package id');

process.exit(failed > 0 ? 1 : 0);
