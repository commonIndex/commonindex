-- `chunks.embedding` was declared vector(1536) in 0001 for a model nobody had
-- chosen, and nothing ever wrote it. The first writer is doc indexing, and the
-- model it ships against is a local one (nomic-embed-text, 768 dimensions), so
-- the column takes the dimension of the model that actually fills it.
--
-- Safe because the column is empty: there is no vector to lose. Changing model
-- later is this statement again plus a re-embed, and the gateway refuses a
-- configured model whose vectors are the wrong length rather than writing them.
drop index if exists chunks_embedding_idx;
alter table chunks alter column embedding type vector(768) using null;
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
