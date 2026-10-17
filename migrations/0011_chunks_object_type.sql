-- Closes the gap `commonindex/core/retrieval/__init__.py`'s `Chunk` dataclass has
-- flagged since it was written: "Carried so half-structural filters do not
-- need a join back to objects on every hit. context-plane.md specifies it;
-- the Go migration omitted it." code.query is the first caller that actually
-- needs the filter — "code chunks only" is exactly the half-structural
-- question context-plane.md says pure similarity search cannot answer.
alter table chunks add column object_type text;

update chunks c set object_type = o.type
  from objects o where o.id = c.object_id and c.object_type is null;

alter table chunks alter column object_type set not null;

create index on chunks (space_id, object_type);
