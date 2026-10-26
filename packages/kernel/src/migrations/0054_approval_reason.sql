-- UI refresh B (Task 6): the optional reason a person gives when denying a tool call. Shown on the
-- handled approval and appended to the denied call's tool result. 0053 is taken by phase C.
ALTER TABLE capybara.approvals ADD COLUMN IF NOT EXISTS deny_reason text;
