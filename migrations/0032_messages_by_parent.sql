-- A page of a conversation is its newest top-level messages and every reply to
-- them, fetched by parent: without an index that was a scan of the table.
create index if not exists messages_by_parent on messages (parent_id) where parent_id is not null;
