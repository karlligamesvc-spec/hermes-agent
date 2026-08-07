"""Tests for _repair_tool_call_arguments — malformed JSON repair pipeline."""

import json

from run_agent import _repair_tool_call_arguments


class TestRepairToolCallArguments:
    """Verify each repair stage in the pipeline."""

    # -- Stage 1: empty / whitespace-only --

    def test_empty_string_returns_empty_object(self):
        assert _repair_tool_call_arguments("", "t") == "{}"



    # -- Stage 2: Python None literal --



    # -- Stage 3: trailing comma repair --


    def test_trailing_comma_in_array(self):
        result = _repair_tool_call_arguments('{"a": [1, 2,]}', "t")
        parsed = json.loads(result)
        assert parsed == {"a": [1, 2]}


    # -- Stage 4: unclosed brackets --



    # -- Stage 5: excess closing delimiters --



    # -- Stage 6: last resort --


    def test_unrepairable_partial_returns_empty_object(self):
        # Truncated in the middle of a string key — bracket closing won't help
        assert _repair_tool_call_arguments('{"truncated": "val', "t") == "{}"

    # -- Valid JSON passthrough (this path is via except, but still works) --


    # -- Combined repairs --



    # -- Stage 0: strict=False (literal control chars in strings) --
    # llama.cpp backends sometimes emit literal tabs/newlines inside JSON
    # string values. strict=False accepts these; we re-serialise to the
    # canonical wire form (#12068).




    # -- Stage 4: control-char escape fallback --




class TestUnrepairableDiagnostics:
    """hc-644: the give-up log has to say enough to find the cause.

    It used to log ``raw[:80]`` alone -- the one part of a truncated payload
    that always looks fine. Three unrepairable blobs in a single real desktop
    session (xlsx_file_write / execute_code / write_file, all large) each
    opened with perfectly valid JSON, so nothing in the log distinguished
    "the stream was cut" from "the model emitted garbage".
    """

    @staticmethod
    def _warn_for(raw: str, caplog) -> str:
        import logging

        with caplog.at_level(logging.WARNING):
            assert _repair_tool_call_arguments(raw, "write_file") == "{}"
        unrepairable = [r for r in caplog.records if "Unrepairable" in r.getMessage()]
        assert len(unrepairable) == 1, "expected exactly one give-up warning"
        return unrepairable[0].getMessage()

    def test_truncated_mid_string_is_identifiable(self, caplog):
        """The real shape: a long payload cut off inside a JSON string.

        Appending brackets cannot close a string, so this is precisely the
        case the repair ladder cannot fix -- the log must let you SEE that.
        """
        raw = '{"content": "<!DOCTYPE html>' + "<p>filler</p>" * 200
        msg = self._warn_for(raw, caplog)
        assert "unterminated" in msg.lower(), msg
        assert f"len={len(raw)}" in msg, msg

    def test_tail_is_logged_not_just_head(self, caplog):
        """Where a truncation actually shows."""
        raw = '{"code": "' + "x" * 500 + "UNIQUE_TAIL_MARKER"
        msg = self._warn_for(raw, caplog)
        assert "UNIQUE_TAIL_MARKER" in msg, "the tail is the diagnostic part"

    def test_head_still_logged_for_garbage_from_the_start(self, caplog):
        raw = "not json at all, from byte zero"
        msg = self._warn_for(raw, caplog)
        assert "not json at all" in msg

    def test_excerpts_are_bounded(self, caplog):
        """A log line must stay a log line even for a megabyte of HTML."""
        raw = '{"content": "' + "y" * 1_000_000
        msg = self._warn_for(raw, caplog)
        assert len(msg) < 1000, f"log line grew to {len(msg)} chars"
        assert "len=1000013" in msg, "the true size is still reported"

    def test_decoder_offset_is_reported(self, caplog):
        raw = '{"a": 1,, "b": 2'
        msg = self._warn_for(raw, caplog)
        assert "pos " in msg, msg
