-- Making a request answerable after the fact.
--
-- Meridian returns an `x-request-id` on every response and writes it onto every
-- usage row, and until now nothing could look one up: there was no index and no
-- query that selected on it. A user handed a request id had no way to ask what
-- happened, and neither did the product.
--
-- Three specific holes, each with a consequence rather than a tidiness argument.

-- 1. Which agent step produced this call.
--
-- The usage row recorded WHICH ROLE ran, not WHICH STEP, and those stopped being
-- the same thing when a failing check began appending a repair attempt: a
-- pipeline can now run `tester` twice. The verification verdict was matched to
-- usage rows by role, so a successful repair retroactively credited the FIRST,
-- failing tester's model with a pass it never earned — corrupting the learned
-- quality score in the one place that was built to be honest about it.
ALTER TABLE usage ADD COLUMN step_id TEXT;

-- 2. Why this model was chosen.
--
-- The decision was computed in full, returned to the caller, and dropped. For
-- anything in the past, "why did this request pick that model" was unanswerable
-- — including for the request that just spent money. Stored per attempt rather
-- than per request, because a fallback re-routes and each attempt has its own
-- answer. A compact snapshot, not the whole reason object: the applied mode, the
-- winner's score, the runners-up and the top rejections are what a person needs.
ALTER TABLE usage ADD COLUMN routing TEXT;

-- 3. What optimisation saved on this call.
--
-- The agent loop measures the tokens it kept out of a prompt, carefully, and
-- then sends the number to a debug log. It never reached the database, so the
-- product could not report the savings it makes.
ALTER TABLE usage ADD COLUMN context_tokens_saved INTEGER;

-- Lookup by request id is the whole point of returning one.
CREATE INDEX IF NOT EXISTS idx_usage_request ON usage(request_id);
CREATE INDEX IF NOT EXISTS idx_usage_step ON usage(step_id);
