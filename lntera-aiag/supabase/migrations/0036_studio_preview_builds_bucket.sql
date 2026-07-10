-- Durable holding spot for a webapp project's latest built zip, between the browser producing it
-- (BrowserPod's buildZip) and the deploy-studio-preview Inngest function shipping it to EdgeOne —
-- the zip only ever lives in browser memory otherwise, and the durable job needs to read it back
-- even if it runs (or retries) after the triggering browser tab/session is long gone. One object per
-- project, always overwritten (upsert) — only the latest build is ever needed, no history kept.
-- Private bucket, accessed only via the service-role backend, same as tenant-knowledge-docs.
insert into storage.buckets (id, name, public, file_size_limit)
values ('studio-preview-builds', 'studio-preview-builds', false, 52428800)
on conflict (id) do nothing;
