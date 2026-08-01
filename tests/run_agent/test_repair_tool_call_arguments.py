"""Tests for _repair_tool_call_arguments — malformed JSON repair pipeline."""

import json

from run_agent import _repair_tool_call_arguments


class TestRepairToolCallArguments:
    """Verify each repair stage in the pipeline."""

    # -- Stage 1: empty / whitespace-only --

    def test_empty_string_returns_empty_object(self):
        assert _repair_tool_call_arguments("", "t") == "{}"

    def test_whitespace_only_returns_empty_object(self):
        assert _repair_tool_call_arguments("   \n\t  ", "t") == "{}"

    def test_none_type_returns_empty_object(self):
        """Non-string input (e.g. None from a broken model response)."""
        assert _repair_tool_call_arguments(None, "t") == "{}"

    # -- Stage 2: Python None literal --

    def test_python_none_literal(self):
        assert _repair_tool_call_arguments("None", "t") == "{}"

    def test_python_none_with_whitespace(self):
        assert _repair_tool_call_arguments("  None  ", "t") == "{}"

    # -- Stage 3: trailing comma repair --

    def test_trailing_comma_in_object(self):
        result = _repair_tool_call_arguments('{"key": "value",}', "t")
        assert json.loads(result) == {"key": "value"}

    def test_trailing_comma_in_array(self):
        result = _repair_tool_call_arguments('{"a": [1, 2,]}', "t")
        parsed = json.loads(result)
        assert parsed == {"a": [1, 2]}

    def test_multiple_trailing_commas(self):
        result = _repair_tool_call_arguments('{"a": 1, "b": 2,}', "t")
        parsed = json.loads(result)
        assert parsed["a"] == 1
        assert parsed["b"] == 2

    # -- Stage 4: unclosed brackets --

    def test_unclosed_brace(self):
        result = _repair_tool_call_arguments('{"key": "value"', "t")
        parsed = json.loads(result)
        assert parsed == {"key": "value"}

    def test_unclosed_bracket_and_brace(self):
        result = _repair_tool_call_arguments('{"a": [1, 2', "t")
        # Bracket counting adds ']' then '}', producing {"a": [1, 2]}
        # which is valid JSON.  But the naive count can't always recover
        # complex nesting — verify we at least get valid JSON.
        json.loads(result)

    # -- Stage 5: excess closing delimiters --

    def test_extra_closing_brace(self):
        result = _repair_tool_call_arguments('{"key": "value"}}', "t")
        parsed = json.loads(result)
        assert parsed == {"key": "value"}

    def test_extra_closing_bracket(self):
        result = _repair_tool_call_arguments('{"a": [1]]}', "t")
        # Should produce valid JSON
        json.loads(result)

    # -- Stage 6: last resort --

    def test_unrepairable_garbage_returns_empty_object(self):
        assert _repair_tool_call_arguments("totally not json", "t") == "{}"

    def test_unrepairable_partial_returns_empty_object(self):
        # Truncated in the middle of a string key — bracket closing won't help
        assert _repair_tool_call_arguments('{"truncated": "val', "t") == "{}"

    # -- Valid JSON passthrough (this path is via except, but still works) --

    def test_already_valid_json_passes_through(self):
        """When json.loads fails for a non-JSON reason (shouldn't normally
        happen), but the repair pipeline still produces valid output."""
        raw = '{"path": "/tmp/foo", "content": "hello"}'
        result = _repair_tool_call_arguments(raw, "t")
        parsed = json.loads(result)
        assert parsed["path"] == "/tmp/foo"

    # -- Combined repairs --

    def test_trailing_comma_plus_unclosed_brace(self):
        result = _repair_tool_call_arguments('{"a": 1, "b": 2,', "t")
        # Trailing comma stripped first, then closing brace added.
        # May or may not fully recover — verify valid JSON at minimum.
        json.loads(result)

    def test_real_world_glm_truncation(self):
        """Simulates GLM-5.1 truncating mid-argument."""
        raw = '{"command": "ls -la /tmp", "timeout": 30, "background":'
        result = _repair_tool_call_arguments(raw, "terminal")
        # Should at least be valid JSON, even if background is lost
        json.loads(result)

    # -- Stage 0: strict=False (literal control chars in strings) --
    # llama.cpp backends sometimes emit literal tabs/newlines inside JSON
    # string values. strict=False accepts these; we re-serialise to the
    # canonical wire form (#12068).

    def test_literal_newline_inside_string_value(self):
        raw = '{"summary": "line one\nline two"}'
        result = _repair_tool_call_arguments(raw, "t")
        parsed = json.loads(result)
        assert parsed == {"summary": "line one\nline two"}

    def test_literal_tab_inside_string_value(self):
        raw = '{"summary": "col1\tcol2"}'
        result = _repair_tool_call_arguments(raw, "t")
        parsed = json.loads(result)
        assert parsed == {"summary": "col1\tcol2"}

    def test_literal_control_char_reserialised_to_wire_form(self):
        """After repair, the output must parse under strict=True."""
        raw = '{"msg": "has\tliteral\ttabs"}'
        result = _repair_tool_call_arguments(raw, "t")
        # strict=True must now accept this
        parsed = json.loads(result)
        assert parsed["msg"] == "has\tliteral\ttabs"

    # -- Stage 4: control-char escape fallback --

    def test_control_chars_with_trailing_comma(self):
        """strict=False fails due to trailing comma, but brace-count pass
        + control-char escape rescues it."""
        raw = '{"msg": "line\none",}'
        result = _repair_tool_call_arguments(raw, "t")
        parsed = json.loads(result)
        assert "line" in parsed["msg"]



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
