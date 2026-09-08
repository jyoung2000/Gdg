-- Capability evidence, so that what Meridian has established about a model
-- survives a restart.
--
-- Before this, `models` stored the flat `capabilities` array and nothing else.
-- Every claim about *where a capability came from* — a provider's own listing,
-- a guess from the model's name, an operator who tested it, a live probe — was
-- computed in memory, used, and dropped on write.
--
-- That had a worse consequence than losing provenance. An operator marking a
-- capability unsupported removed it from the array, and on the next boot
-- `enrich()` re-ran the name heuristic and put it straight back. A deliberate,
-- tested "this model cannot see images" came back as "inferred: it can" — the
-- weakest possible evidence silently overwriting the strongest, once per
-- restart, in the direction that makes the router pick a model that will fail.
--
-- Nullable so existing rows are valid as they stand: a model with no recorded
-- claims is in exactly the state it was in before this migration, and the next
-- discovery pass fills it in.
ALTER TABLE models ADD COLUMN capability_claims TEXT;

-- When Meridian first saw this model, and when it last confirmed it exists.
-- Both were already on ModelDescriptor and neither had anywhere to live, so a
-- model's age reset on every restart and no staleness rule could ever fire.
ALTER TABLE models ADD COLUMN discovered_at INTEGER;
ALTER TABLE models ADD COLUMN last_verified_at INTEGER;
