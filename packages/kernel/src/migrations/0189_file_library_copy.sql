-- File library data copy (0188_file_library.sql header): copies every existing chat attachment,
-- delivered artifact and share snapshot, in its own transaction so 0188's DDL locks are not held
-- while it scans.
SELECT file_library_copy('-infinity');
