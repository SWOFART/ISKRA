# PostgreSQL migrations

`0001_p0_core.sql` is the reviewed P0 schema baseline. SQL migrations are the database schema authority; no ORM schema-push or Worker-startup migration is enabled. Once applied to any persistent database, a migration file is immutable. Follow-up schema changes use a new additive numbered file.

## Migration inventory and checksums

| Migration | SHA-256 |
|---|---|
| `0001_p0_core.sql` | `bae5a68906a6e4ba971d06a7cae1e02a3b989e81dba0d00551a3d6fb945aeaa8` |
| `0002_yellow_missions.sql` | `46cf4facaae417e4b0d1cbae7a19fc1a9a398f851a8a51d4d63109bf1769b334` |
| `0003_red_assistance_drafts.sql` | `0a6f043f37f758f791cc721c80765739598d4a5bc0316558fdc0b9cf261b5663` |
| `0004_demo_rewards.sql` | `6a0d7b3777ae58fa847e7849dd766487ec15635967e609e1ab305b513e004295` |
| `0005_demo_rewards_runtime_privileges.sql` | `bc14453b6b39a63aa88f99909ac0bcd4439365e11b06a778431a82f41a0de339` |

Verify a migration's checksum against this reviewed inventory before applying it. PowerShell: `Get-FileHash migrations/0001_p0_core.sql -Algorithm SHA256`. Linux/macOS: `sha256sum migrations/0001_p0_core.sql`. After review, record the verified checksum with the migration run and backup identity. Never edit an applied migration to make its checksum match; create a new migration instead.

## Database roles and application boundary

- **Migration role** (planned name `iskra_migrator`): owns the application schema and has the DDL rights needed to apply reviewed migrations. Use only from the controlled migration job/operator path after a verified backup and checksum check. It is never bound to the Worker.
- **Runtime role** (name `iskra_runtime` in staging): does not own the schema and has no `CREATE`, `ALTER`, or `DROP` rights. Grant only the table/sequence access required by the runtime. The runtime must not update or delete reward-ledger rows or cascade-delete reports and evidence.
- **Integration-test role** (`iskra_test`): disposable loopback-only trust-auth identity used by CI/local PostgreSQL tests. It is not a product identity and must never receive Cloud SQL credentials.

These names describe the required separation; this migration does not provision database roles or grant cloud privileges. D10 resource permissions and the real Cloud SQL identity remain unverified. Runtime and migration connection values must come from Google Secret Manager/Hyperdrive as documented in [the runbook](../infra/runbook.md); no values belong in this repository or GitHub settings.

## P0 schema notes

- `report_photos.ordinal` is zero-based (`0..4`) in SQL. The v1 response contract exposes one-based ordinals (`1..5`); adapters translate at the boundary.
- `reports.existence_verified_at` is the first three-YES threshold time. `last_existence_confirmed_at` advances on each later accepted existence YES and is not a replacement for the first timestamp.
- `ai_analyses` intentionally has no unique constraint on `(owner_user_id, kind, input_hash)`. `analysis_leases` has one mutable slot for that key and points to the current attempt, allowing a new attempt after expiry/failure without making an old result publishable.
- A report's fixed `analysis_kind = REPORT` discriminator participates in a composite foreign key, so its analysis must belong to the report author and be a report analysis. Cleanup submissions similarly bind analysis owner and target report.
- Cross-row lifecycle and voter-role rules (such as requiring a GREEN report before cleanup, or preventing self-votes) are checked in transaction services; SQL `CHECK` constraints only use columns from their own row.
- Cleanup coordinates are private audit fields. Public report DTOs expose only the report point.
- Migration `0002_yellow_missions.sql` adds the bounded Yellow mission and participant tables; it intentionally adds no attendance, completion, vote, payout or award path. The migration's verified-YELLOW rule is reinforced by a composite FK from mission report ID/route to the report's ID/route, while VERIFIED status is serialized and enforced by the transaction service.
- Migration `0003_red_assistance_drafts.sql` stores one private Red draft per report owner and an empty-by-default verified contact allowlist. No authority contact is seeded; manually verify source provenance before adding any active contact. The sent declaration stores a resident-reported timestamp only and never changes report lifecycle, votes or rewards. Integration tests apply it only to a disposable schema; no cloud database was migrated.
- Migration `0004_demo_rewards.sql` adds a catalog with three clearly fictional 5/15/40 RP examples, owner-scoped `RECEIVED` vouchers, voucher-linked negative redemption ledger entries and the `REDEMPTION`/`REVERSAL` ledger kinds. Prices reuse the selected earning amounts. Catalog/voucher demo markers and the fixed no-value disclaimer are database-enforced; the voucher code is not a merchant credential. Positive earning kinds remain positive, while redemption/reversal kinds are negative. The examples provide no real goods or services and add no partner/QR/expiry/payout/fulfillment path. Integration tests apply it only to disposable schemas; no cloud database was migrated.
- Migration `0005_demo_rewards_runtime_privileges.sql` grants `iskra_runtime` catalog reads and voucher reads/inserts only. It does not allow catalog or voucher updates/deletes. Apply it only after confirming migration0004 has created both tables.

The migration contains no data backfill or destructive operation. The integration suite applies it only inside a generated disposable schema; no cloud database was migrated by this task.
