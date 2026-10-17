"""Workflow: work items, and the verbs that move them between people and agents.

A task is an object like any other — its history in `revisions`, its
neighbourhood in `edges` — and its state changes only through named verbs
(`tasks.start`, `tasks.hand`, `tasks.submit`, `tasks.accept`, …), each checked
against the relation it needs. The definitions live here; the handlers are
written by hand in `commonindex.gateway.tasks`.
"""
