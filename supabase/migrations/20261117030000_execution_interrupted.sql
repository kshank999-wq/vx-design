-- G2: an execution that stopped at a checkpoint (pause, cancel, budget stop, shutdown, lost
-- heartbeat) and can be resumed. Kept in its own migration: a new enum value cannot be used
-- in the transaction that adds it.
alter type public.execution_status add value if not exists 'interrupted';
