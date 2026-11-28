-- The acceptance automation's prompt states the mechanism for any directed event (an assignment,
-- an unassignment, an answer, ...), not "this work was assigned to you". Acceptance automations
-- that still carry the old kernel text, unedited, get the new one; a prompt the person edited stays
-- as it is. Past fires keep the text their messages recorded (the event log is never rewritten).

UPDATE automations
SET prompt = 'The events above were directed to you and your agent by their source; your acceptance rule for that source delivers them to this automation. Each one names its type, its subject and the source''s own summary of what happened. Decide from them what, if anything, is now expected of you: do it within what you are allowed to do and report what you did, or say why nothing needs doing.',
    updated_at = now()
WHERE origin = 'acceptance'
  AND prompt = 'This work was assigned to you. Read the assigned item, do what it asks within what you are allowed to do, and report what you did.';
