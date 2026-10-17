"""The platform's own database, registered as a warehouse, is not a window
onto the platform.

"Platform Postgres" is the database the gateway runs on, so a demo workspace has
real tables to chart. Through it, `select count(*) from sign_in_codes` answered,
and introspection listed actor_tokens, sessions and sso_logins beside the demo
tables. On that connection the app's own tables, the server's catalogs and its
admin functions are refused; on any other connection nothing changes.
"""

from __future__ import annotations

import pytest

from commonindex.gateway import authoring
from commonindex.gateway.authoring import BadSQL, app_tables, check_sql, is_platform_db


def test_the_app_tables_come_from_the_migrations():
    t = app_tables()
    assert {"sessions", "sign_in_codes", "actor_tokens", "sso_logins", "email_sign_ins", "shares"} <= t
    assert "demo_orders" not in t


@pytest.mark.parametrize("sql", [
    "select count(*) from public.sign_in_codes",
    "select * from sessions s join actors a on a.id = s.actor_id",
    'select * from "actor_tokens"',
    "select pg_read_file('/etc/passwd')",
    "select * from pg_catalog.pg_authid",
    "select * from information_schema.tables",
    "select * from pg_shadow",
    "select current_setting('data_directory')",
    "select lo_import('/etc/hosts')",
])
def test_the_platform_connection_refuses_the_platforms_own(sql):
    with pytest.raises(BadSQL):
        check_sql(sql, "postgres", app_tables())


@pytest.mark.parametrize("sql", [
    "select channel, count(*) from public.demo_orders group by 1",
    "with sessions as (select 1 as x) select * from sessions",      # a name the author gave a CTE
])
def test_the_platform_connection_still_charts_data(sql):
    check_sql(sql, "postgres", app_tables())


def test_any_other_connection_is_unchanged():
    check_sql("select * from sessions", "postgres")                  # a customer's own `sessions` table


def test_the_platform_database_is_recognised_by_host_port_and_name(monkeypatch):
    from commonindex.gateway import app
    monkeypatch.setattr(app, "DSN", "postgresql://commonindex:x@db:5432/commonindex")
    assert is_platform_db("postgresql+asyncpg://commonindex@db:5432/commonindex")
    assert is_platform_db("postgresql+asyncpg://reader:y@db/commonindex")
    assert not is_platform_db("postgresql+asyncpg://commonindex@db:5432/analytics")
    assert not is_platform_db("postgresql://warehouse.example.com/commonindex")
    assert not is_platform_db(None)


def test_a_hidden_table_is_neither_listed_nor_found():
    from commonindex.core.warehouse import Connection
    from commonindex.core.warehouse.sources.direct import DirectWarehouseSource

    src = DirectWarehouseSource(Connection(id="c", space_id="s", kind="postgres", dsn="x"), None,
                                hidden=app_tables())
    assert src.is_hidden("public.sessions") and src.is_hidden('"sign_in_codes"')
    assert not src.is_hidden("public.demo_orders")

    async def lookup():
        await src._dataset("public.sessions")
    import asyncio
    with pytest.raises(LookupError):
        asyncio.run(lookup())
    assert authoring  # imported for app_tables' module state
