-- 0029 — İYS upload worker: record which gateway accepted each consent.
--
-- `iys_uploaded_at` on its own asserts that the İYS registry holds a
-- permission. In development that assertion is false: the `local` adapter
-- accepts every row without leaving the machine, so a dev or staging database
-- would carry consents indistinguishable from registered ones.
--
-- Storing the adapter's name keeps "which of these did a real registry accept"
-- answerable forever. Nullable and additive: existing rows predate any upload,
-- and there are none to backfill because nothing has ever drained the queue.

alter table consent_records
  add column if not exists iys_uploaded_via text;

comment on column consent_records.iys_uploaded_via is
  'Name of the İYS gateway that accepted this consent. `local` means a development adapter, not the registry.';
