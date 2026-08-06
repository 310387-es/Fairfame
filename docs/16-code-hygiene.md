# 16 — Code hygiene

Two automated checks guard against rot, both wired into `pnpm check` and therefore into CI.

## `pnpm knip` — dead code

Finds unused files, unused dependencies and unused exports.

**CI gates on files, dependencies, unlisted imports and duplicate exports.** Those are high-signal: an unreferenced file or a dependency nobody imports is rot with no upside.

**It does not gate on unused *exports*.** That list needs a human who knows whether a given export is scaffolding for planned work or genuinely abandoned — `getStripeClient` is deliberately unused until billing is built, and `vaultTokenReader` should probably be wired up rather than deleted. Run `pnpm knip:all` to see it.

Mark a deliberate export with `@public` in its JSDoc and say why:

```ts
/**
 * Releases the shared queue. For scripts and tests, not for request handlers.
 *
 * @public — lifecycle API for callers outside the request path.
 */
```

### What is deliberately ignored, and why

| Path | Reason |
|---|---|
| `src/components/ui/**` | shadcn primitives. They ship a full variant surface on purpose; using half of it is normal. |
| `src/components/digest/**`, `src/server/digests.ts` | **Unshipped, not dead.** The weekly digest is generated, stored and tested — the workers run and `tests/db/digest.test.ts` covers it. Only the `/weekly-plan` route was never built; `docs/14-digest-surfaces.md` is the plan. Delete none of it. |
| `shadcn`, `tailwindcss`, `tw-animate-css` | Imported from `globals.css`, which knip does not follow. |
| `pino-pretty` | Loaded by name at runtime when `LOG_PRETTY=true`, never imported. |

## `pnpm check:i18n` — translation parity

Every locale must define exactly the same keys, and every key must be used.

It fails on:

- **A key present in one locale and missing in another.** `next-intl` throws at render for a missing key, so this is a crash waiting for whichever language nobody tested.
- **A key defined but never referenced.** Dead strings cost translator time and imply the product does something it does not.

It deliberately tolerates keys that look dynamic. `t(\`newItem.${type}\`)` cannot be resolved statically, so any key whose parent namespace is referenced with a template literal is treated as used — a checker that forces every string to be reachable by grep would push people into flattening perfectly good message groups.

## Migrations are written by hand — there is no `db:generate`

`drizzle-kit generate` diffs `schema.ts` against the newest snapshot in
`src/db/migrations/meta/` and emits the difference. That works only if every
migration was itself generated. Here they are not: they are written and
reviewed by hand, because RLS policies, partial indexes, backfills and check
constraints are the parts most worth reading and the ones a generator is
least able to express.

Mixing the two is how you get a duplicate migration. Snapshots stopped being
written at `0026` while migrations continued to `0029`, so anyone running
`generate` would have received one migration re-containing everything since —
a plausible-looking file that reapplies changes already live.

So the script is gone and the orphaned snapshots with it, rather than left as
a half-truth. `drizzle.config.ts` stays for `db:studio`.

**To add a migration:** write the `.sql` file, add its entry to
`meta/_journal.json` (`idx`, `tag`, and a `when` after the previous one), and
run `pnpm db:migrate`. The journal is what `migrate()` reads; snapshots are
not involved. A fresh database applies the full sequence — verified by
migrating an empty one from `0001`.

**Every tenant-owned table needs its RLS block in the same migration.** A table
created without one is readable across tenants until somebody notices, and
`tests/db/tenant-isolation.test.ts` is what notices.
