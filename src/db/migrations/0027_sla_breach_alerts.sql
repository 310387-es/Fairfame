-- A second kind of alert: the deadline lapsed (P2-T7).
--
-- "A review arrived" and "nobody has answered this and the promise has lapsed"
-- are different news. They fire at different times, they are about different
-- people — the customer and the team — and the second has to be able to reach
-- somebody who has already read and dismissed the first.
--
-- Adding an enum value is safe inside a transaction on PostgreSQL 12+ as long
-- as nothing in the same transaction *uses* it, which is why this migration
-- does only this. The sweep that writes rows with it ships as application code.

ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'sla_breach';
