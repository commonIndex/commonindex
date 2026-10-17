"""Video suggestions: no database, browser, provider credentials or writes."""

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from commonindex.gateway import video_assist as ai
from commonindex.gateway.llm import LlmTruncated

HTML = ('<!doctype html><html><head><style>h1{color:red}</style></head><body>'
        '<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">'
        '<section class="clip" data-start="0" data-duration="4"><h1>Hello</h1></section></div></body></html>')
ANSWER = {"summary": "Shortened the heading.", "edits": [{"find": "<h1>Hello</h1>", "replace": "<h1>Hi</h1>"}]}


class Pool:
    @asynccontextmanager
    async def acquire(self):
        # No database methods: an accidental write/read beyond _item fails.
        yield object()


class Req:
    def __init__(self, body=None, llm=None, **state):
        self.body = {"video_id": "v1", "instruction": "shorten the heading", "composition": HTML,
                     "context": "Scene 1: Hello (0s–4s)", "title": "Launch", "brief": "A launch"} if body is None else body
        self.app = SimpleNamespace(state=SimpleNamespace(commonindex={"pool": Pool(), "llm": llm, **state}))

    async def json(self):
        return self.body


@pytest.fixture(autouse=True)
def access(monkeypatch):
    item = AsyncMock(return_value=({"id": "v1"}, {"state": "draft"}, None))
    monkeypatch.setattr(ai, "_item", item)
    return item


def model(answer=ANSWER):
    return SimpleNamespace(model="test-model", complete=AsyncMock(return_value=json.dumps(answer)))


async def test_sends_current_draft_and_context_returns_unsaved_validated_suggestion(access):
    llm = model()
    result = await ai.videos_assist(Req(llm=llm))
    assert result["composition"] == HTML.replace("Hello", "Hi")
    assert result["summary"] == ANSWER["summary"]
    assert result["model"] == "test-model"
    assert "Nothing was saved" in result["note"]
    assert access.call_args.args[-1] == "edit"
    args, kwargs = llm.complete.call_args
    prompt = json.loads(args[0][1]["content"])
    assert prompt["composition"] == HTML and prompt["context"].startswith("Scene 1")
    assert kwargs["require_finished"] is True


async def test_access_refusal_prevents_model_call(access):
    refused = ai._error(404, "unknown_video", "not visible")
    access.return_value = (None, None, refused)
    llm = model()
    assert await ai.videos_assist(Req(llm=llm)) is refused
    llm.complete.assert_not_called()


async def test_rendering_refuses_edits_before_model_call(access):
    access.return_value = ({"id": "v1"}, {"state": "rendering"}, None)
    llm = model()
    assert (await ai.videos_assist(Req(llm=llm))).status_code == 409
    llm.complete.assert_not_called()


@pytest.mark.parametrize("field,value", [
    ("instruction", " "), ("instruction", []), ("instruction", "x" * 4001),
    ("composition", {}), ("composition", "x" * 400001), ("context", "x" * 2001),
    ("title", "x" * 501), ("brief", []), ("video_id", 42),
])
async def test_bad_input_never_reaches_provider(field, value, access):
    req = Req(llm=model())
    req.body[field] = value
    assert (await ai.videos_assist(req)).status_code == 422
    req.app.state.commonindex["llm"].complete.assert_not_called()
    access.assert_not_called()


async def test_truncated_or_invalid_response_cannot_be_applied():
    llm = model()
    llm.complete.side_effect = LlmTruncated("too long")
    result = await ai.videos_assist(Req(llm=llm))
    assert json.loads(result.body)["error"]["code"] == "model_truncated"
    llm.complete.side_effect = None
    llm.complete.return_value = "not json"
    assert (await ai.videos_assist(Req(llm=llm))).status_code == 502


async def test_configured_design_generator_is_a_fallback():
    gen = AsyncMock(return_value=(ANSWER, {"model": "design-model"}))
    result = await ai.videos_assist(Req(generate=gen))
    assert result["model"] == "design-model"
    assert result["composition"] == HTML.replace("Hello", "Hi")
    assert gen.call_args.kwargs["schema"] == ai.SCHEMA


async def test_no_provider_is_actionable(monkeypatch):
    monkeypatch.delenv("COMMONINDEX_MODEL_PROVIDER", raising=False)
    result = await ai.videos_assist(Req())
    assert result.status_code == 503
    assert "COMMONINDEX_LLM_BASE_URL" in json.loads(result.body)["error"]["message"]


async def test_provider_error_does_not_expose_secrets(caplog):
    llm = model()
    llm.complete.side_effect = RuntimeError("secret-credential-and-private-prompt")
    result = await ai.videos_assist(Req(llm=llm))
    assert result.status_code == 502
    assert "secret-credential" not in result.body.decode() + caplog.text


@pytest.mark.parametrize("edits", [
    [{"find": "not in this draft", "replace": "Oops"}],
    [{"find": "4", "replace": "5"}],  # repeated, must not guess
    [{"find": "", "replace": "Oops"}],
    [{"find": "<h1>Hello</h1>", "replace": '<iframe src="https://evil.invalid"></iframe>'}],
    [{"find": "data-duration=\"4\"><h1>", "replace": "data-duration=\"40\"><h1>"}],
    [{"find": "data-width=\"1920\"", "replace": "data-width=\"NaN\""}],
    [{"find": "Hello", "replace": 4}],
])
def test_ambiguous_unsafe_or_invalid_patches_are_refused(edits):
    with pytest.raises(ValueError):
        ai.apply_edits(HTML, {"summary": "test", "edits": edits})


def test_questions_preserve_the_draft_and_blank_drafts_can_be_generated():
    assert ai.apply_edits(HTML, {"summary": "Try a shorter heading.", "edits": []}) == (HTML, "Try a shorter heading.")
    assert ai.apply_edits("", {"summary": "Created an intro.", "edits": [{"find": "", "replace": HTML}]})[0] == HTML


def test_a_blank_draft_takes_the_one_edit_whatever_it_claims_to_find():
    """A small model writing a first draft put the root tag in `find`; there is
    nothing in a blank draft for it to match, so the replacement is the draft —
    and is still held to every check a draft is."""
    root = '<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">'
    assert ai.apply_edits("", {"summary": "Created.", "edits": [{"find": root, "replace": HTML}]})[0] == HTML
    with pytest.raises(ValueError):
        ai.apply_edits("", {"summary": "x", "edits": [{"find": root, "replace": HTML.replace('data-duration="4">', 'data-duration="2">', 1)}]})
    with pytest.raises(ValueError):
        ai.apply_edits("", {"summary": "x", "edits": [{"find": "", "replace": HTML}, {"find": "Hello", "replace": "Hi"}]})


def test_assist_is_registered_as_non_writing_operation():
    from commonindex.core.ops import Registry
    from commonindex.core.render.ops import register

    reg = Registry()
    register(reg)
    op = reg.get("videos.assist")
    assert op and not op.mutating and op.relation == "read"


async def test_a_blank_draft_answered_with_only_a_summary_is_asked_once_more():
    # "Created a 3-scene composition…" with no edits: the editor showed the
    # claim and an empty video. Asked again, the model sends the HTML.
    llm = model()
    llm.complete.side_effect = [json.dumps({"summary": "Created a 3-scene video.", "edits": []}),
                                json.dumps({"summary": "Created it.", "edits": [{"find": "", "replace": HTML}]})]
    result = await ai.videos_assist(Req({**Req().body, "composition": ""}, llm=llm))
    assert result["composition"] == HTML and llm.complete.call_count == 2
    assert 'find=""' in llm.complete.call_args.args[0][1]["content"]


async def test_a_blank_draft_still_left_blank_does_not_claim_a_video():
    llm = model({"summary": "Created a 3-scene video.", "edits": []})
    result = await ai.videos_assist(Req({**Req().body, "composition": ""}, llm=llm))
    assert result["composition"] == ""
    assert result["summary"].startswith("No composition was suggested")


async def test_a_question_about_a_draft_is_asked_once():
    llm = model({"summary": "Scene 1 shows the heading.", "edits": []})
    result = await ai.videos_assist(Req(llm=llm))
    assert result["composition"] == HTML and llm.complete.call_count == 1
    assert result["summary"] == "Scene 1 shows the heading."


def test_a_model_call_waits_as_long_as_the_model_is_configured_to_take(monkeypatch):
    # A local model drafting a video took 126s and was cut at a fixed 120s
    # while it was configured to be given 420.
    from commonindex.gateway.llm import budget

    assert budget(SimpleNamespace(timeout_seconds=420)) == 435
    monkeypatch.setenv("COMMONINDEX_MODEL_TIMEOUT_SECONDS", "600")
    assert budget(None) == 615


HIDDEN = ('<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">'
          '<style>.clip { opacity: 0; transition: opacity .5s } .clip.active { opacity: 1 }</style>'
          '<section class="clip" data-start="0" data-duration="4"><h1>Hello</h1></section></div>')


def test_scenes_hidden_by_their_own_css_are_refused():
    # A local model wrote `.clip { opacity: 0 }` waiting for a script to add
    # `.active`; no script runs, and the video was black end to end.
    with pytest.raises(ValueError, match="hidden by its own CSS"):
        ai.apply_edits("", {"summary": "made it", "edits": [{"find": "", "replace": HIDDEN}]})
    shown = HIDDEN.replace(".clip { opacity: 0; transition: opacity .5s }", ".clip h1 { opacity: 0; animation: in .5s forwards }")
    assert ai.apply_edits("", {"summary": "ok", "edits": [{"find": "", "replace": shown}]})[0] == shown


async def test_a_refused_suggestion_is_sent_back_once_with_why():
    llm = model()
    good = {"summary": "made it", "edits": [{"find": "", "replace": HTML}]}
    llm.complete.side_effect = [json.dumps({"summary": "made it", "edits": [{"find": "", "replace": HIDDEN}]}), json.dumps(good)]
    result = await ai.videos_assist(Req({**Req().body, "composition": ""}, llm=llm))
    assert result["composition"] == HTML and llm.complete.call_count == 2
    assert "hidden by its own CSS" in llm.complete.call_args.args[0][1]["content"]


async def test_unreadable_output_is_asked_for_once_more_and_the_schema_goes_to_the_model():
    llm = model()
    llm.complete.side_effect = ["Sure! Here is your video: <div>…", json.dumps(ANSWER)]
    result = await ai.videos_assist(Req(llm=llm))
    assert result["composition"] == HTML.replace("Hello", "Hi") and llm.complete.call_count == 2
    assert llm.complete.call_args.kwargs["response_schema"] == ai.SCHEMA
