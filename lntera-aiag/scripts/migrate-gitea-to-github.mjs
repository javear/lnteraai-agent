#!/usr/bin/env node
/**
 * ONE-TIME migration: re-host every existing Forge project's git repo from Gitea to the new GitHub
 * org, and update its `tenant_projects.git_repo_url` row to point at the new location. Run this
 * ONCE, before removing GITEA_* from the environment, then delete this file.
 *
 * Usage (from lntera-aiag/, needs both the OLD Gitea creds and the NEW GitHub creds available at once):
 *   node scripts/migrate-gitea-to-github.mjs
 *
 * Env required (loads lntera-aiag/.env automatically, same convention as scripts/mint-open-api-token.mjs):
 *   GITEA_BASE_URL, GITEA_TOKEN       — source (the old Gitea config, kept only for this run)
 *   GITHUB_TOKEN, GITHUB_ORG          — destination
 *   SUPABASE_URL, SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) — to read/update tenant_projects
 *
 * Only touches `single-branch` (main) content, matching how every other part of this codebase already
 * treats these repos (see GitRepo.clone/push, template-seed.ts — both singleBranch: true).
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

function applyEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    val = val.replace(/\r$/, '').trim();
    if (!val) continue;
    if (!process.env[key]?.trim()) process.env[key] = val;
  }
}
applyEnvFile(resolve(process.cwd(), '.env'));
applyEnvFile(resolve(PKG_ROOT, '.env'));

const giteaBaseUrl = process.env.GITEA_BASE_URL?.trim().replace(/\/+$/, '');
const giteaToken = process.env.GITEA_TOKEN?.trim();
const githubToken = process.env.GITHUB_TOKEN?.trim();
const githubOrg = process.env.GITHUB_ORG?.trim();
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseKey = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();

for (const [name, val] of [
  ['GITEA_BASE_URL', giteaBaseUrl],
  ['GITEA_TOKEN', giteaToken],
  ['GITHUB_TOKEN', githubToken],
  ['GITHUB_ORG', githubOrg],
  ['SUPABASE_URL', supabaseUrl],
  ['SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)', supabaseKey],
]) {
  if (!val) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
}

const supabase = createClient(supabaseUrl, supabaseKey);

function githubAuthHeader(token) {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

async function createGithubRepoIfMissing(name) {
  const createRes = await fetch(`https://api.github.com/orgs/${githubOrg}/repos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lntera-forge-migration',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ name, private: true, auto_init: false }), // no auto_init — we push real history
  });
  if (createRes.ok) return await createRes.json();
  if (createRes.status === 422) {
    const getRes = await fetch(`https://api.github.com/repos/${githubOrg}/${name}`, {
      headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'lntera-forge-migration', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (getRes.ok) return await getRes.json();
    throw new Error(`GitHub repo "${name}" exists but could not be fetched (${getRes.status}): ${await getRes.text()}`);
  }
  throw new Error(`GitHub repo create failed (${createRes.status}): ${await createRes.text()}`);
}

async function migrateOne(row) {
  const url = row.git_repo_url;
  const match = /gitea\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url ?? '');
  if (!match) {
    console.log(`  skip ${row.id} — not a gitea.com URL (${url})`);
    return;
  }
  const [, giteaOwner, repoName] = match;
  console.log(`\n→ project ${row.id} (${repoName})`);

  const dir = await mkdtemp(join(tmpdir(), 'forge-migrate-'));
  try {
    console.log(`  cloning from gitea.com/${giteaOwner}/${repoName} ...`);
    await git.clone({
      fs,
      http,
      dir,
      url: `${giteaBaseUrl}/${giteaOwner}/${repoName}.git`,
      headers: { Authorization: `token ${giteaToken}` },
      singleBranch: true,
    });

    console.log(`  creating github.com/${githubOrg}/${repoName} ...`);
    const repo = await createGithubRepoIfMissing(repoName);

    console.log(`  pushing to github.com/${githubOrg}/${repoName} ...`);
    const result = await git.push({
      fs,
      http,
      dir,
      url: repo.clone_url,
      headers: { Authorization: githubAuthHeader(githubToken) },
      remote: 'origin',
      force: true,
    });
    if (!result.ok || result.error) throw new Error(`git push failed: ${result.error ?? 'unknown error'}`);

    const { error } = await supabase.from('tenant_projects').update({ git_repo_url: repo.clone_url }).eq('id', row.id);
    if (error) throw new Error(`Supabase update failed: ${error.message}`);
    console.log(`  ✅ done — git_repo_url now ${repo.clone_url}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const { data: rows, error } = await supabase
  .from('tenant_projects')
  .select('id, git_repo_url')
  .ilike('git_repo_url', '%gitea.com%');
if (error) {
  console.error(`Failed to list tenant_projects: ${error.message}`);
  process.exit(1);
}

console.log(`Found ${rows.length} project(s) still on gitea.com.`);
for (const row of rows) {
  await migrateOne(row);
}
console.log('\nAll done.');
