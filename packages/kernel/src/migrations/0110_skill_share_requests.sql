-- A share request of an agent skill comes from the agent page or the Platform operation and has
-- no trial, so it records no conversation; a version proposal registered on the web has none
-- either. requested_in_conversation becomes optional.
ALTER TABLE skill_change_requests ALTER COLUMN requested_in_conversation DROP NOT NULL;
