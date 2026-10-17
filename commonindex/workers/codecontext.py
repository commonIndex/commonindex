"""Code-file chunking owned by the ingestion side of Code Query.

The gateway never manufactures searchable code.  A pull writes the current
file object and its replaceable, line-addressable chunks in one transaction,
so a search result can always cite the exact revision it read.
"""

from dataclasses import dataclass

MAX_CHUNK_CHARS = 4_800


@dataclass(frozen=True, slots=True)
class CodeChunk:
    body: str
    start_line: int
    end_line: int


def split_code(body: str, max_chars: int = MAX_CHUNK_CHARS) -> list[CodeChunk]:
    """Split on line boundaries, preserving a stable, human-readable citation."""
    if not body:
        return []
    chunks: list[CodeChunk] = []
    lines = body.splitlines(keepends=True)
    current: list[str] = []
    current_size = 0
    start_line = 1
    for line_number, line in enumerate(lines, start=1):
        if current and current_size + len(line) > max_chars:
            chunks.append(CodeChunk("".join(current), start_line, line_number - 1))
            current = []
            current_size = 0
            start_line = line_number
        # A minified/generated line may itself exceed the limit. It remains one
        # chunk: splitting it makes a line citation misleading.
        current.append(line)
        current_size += len(line)
    if current:
        chunks.append(CodeChunk("".join(current), start_line, len(lines)))
    return chunks


async def replace_code_chunks(conn, *, object_id: str, space_id: str, rev: int,
                              body: str, acl_keys: list[str]) -> None:
    """Replace all searchable chunks for a file's current revision."""
    await conn.execute("delete from chunks where object_id = $1", object_id)
    for ordinal, chunk in enumerate(split_code(body)):
        await conn.execute(
            "insert into chunks (object_id, space_id, object_type, rev, ord, body, "
            "acl_keys, start_line, end_line) "
            "values ($1,$2,'code_file',$3,$4,$5,$6,$7,$8)",
            object_id, space_id, rev, ordinal, chunk.body, acl_keys,
            chunk.start_line, chunk.end_line,
        )
