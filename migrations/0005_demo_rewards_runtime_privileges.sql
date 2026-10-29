-- Grant only the operations required by the deployed demo Rewards service.
-- Migration 0004 must have created these tables before this file is applied.
GRANT SELECT ON reward_catalog TO iskra_runtime;
GRANT SELECT, INSERT ON user_vouchers TO iskra_runtime;
