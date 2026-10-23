from __future__ import annotations

from dataclasses import dataclass

from .contracts import SourceSpan


@dataclass(frozen=True)
class Token:
    kind: str
    value: str
    span: SourceSpan


class LexError(ValueError):
    def __init__(self, message: str, span: SourceSpan):
        super().__init__(message)
        self.span = span


_TWO_CHAR = {">=", "<=", "<>", "&&", "||", "=="}
_SINGLE = set("(),[]=+-*/^&<>;")


def tokenize(source: str) -> list[Token]:
    tokens: list[Token] = []
    i = 0
    line = 1
    column = 1

    def span(start: int, end: int, start_line: int, start_column: int) -> SourceSpan:
        return SourceSpan(start, end, start_line, start_column)

    while i < len(source):
        ch = source[i]
        if ch in " \t\r":
            i += 1
            column += 1
            continue
        if ch == "\n":
            tokens.append(Token("NEWLINE", "\n", span(i, i + 1, line, column)))
            i += 1
            line += 1
            column = 1
            continue
        if source.startswith("//", i):
            while i < len(source) and source[i] != "\n":
                i += 1
                column += 1
            continue
        if source.startswith("/*", i):
            start, start_line, start_column = i, line, column
            i += 2
            column += 2
            while i < len(source) and not source.startswith("*/", i):
                if source[i] == "\n":
                    line += 1
                    column = 1
                    i += 1
                else:
                    i += 1
                    column += 1
            if i >= len(source):
                raise LexError("Unclosed block comment.", span(start, i, start_line, start_column))
            i += 2
            column += 2
            continue
        if ch == '"':
            start, start_line, start_column = i, line, column
            i += 1
            column += 1
            value: list[str] = []
            while i < len(source):
                if source[i] == '"':
                    if i + 1 < len(source) and source[i + 1] == '"':
                        value.append('"')
                        i += 2
                        column += 2
                        continue
                    i += 1
                    column += 1
                    break
                value.append(source[i])
                i += 1
                column += 1
            else:
                raise LexError("Unclosed string literal.", span(start, i, start_line, start_column))
            tokens.append(Token("STRING", "".join(value), span(start, i, start_line, start_column)))
            continue
        if ch == "'":
            start, start_line, start_column = i, line, column
            i += 1
            column += 1
            value: list[str] = []
            while i < len(source):
                if source[i] == "'":
                    if i + 1 < len(source) and source[i + 1] == "'":
                        value.append("'")
                        i += 2
                        column += 2
                        continue
                    i += 1
                    column += 1
                    break
                value.append(source[i])
                i += 1
                column += 1
            else:
                raise LexError("Unclosed quoted table name.", span(start, i, start_line, start_column))
            tokens.append(Token("QIDENT", "".join(value), span(start, i, start_line, start_column)))
            continue
        if ch == "[":
            start, start_line, start_column = i, line, column
            i += 1
            column += 1
            value: list[str] = []
            while i < len(source):
                if source[i] == "]":
                    if i + 1 < len(source) and source[i + 1] == "]":
                        value.append("]")
                        i += 2
                        column += 2
                        continue
                    i += 1
                    column += 1
                    break
                value.append(source[i])
                i += 1
                column += 1
            else:
                raise LexError("Unclosed [field] reference.", span(start, i, start_line, start_column))
            tokens.append(Token("BRACKET", "".join(value).strip(), span(start, i, start_line, start_column)))
            continue
        if ch.isdigit() or (ch == "." and i + 1 < len(source) and source[i + 1].isdigit()):
            start, start_line, start_column = i, line, column
            seen_dot = False
            while i < len(source) and (source[i].isdigit() or (source[i] == "." and not seen_dot)):
                seen_dot = seen_dot or source[i] == "."
                i += 1
                column += 1
            tokens.append(Token("NUMBER", source[start:i], span(start, i, start_line, start_column)))
            continue
        if ch.isalpha() or ch in "_@":
            start, start_line, start_column = i, line, column
            while i < len(source) and (source[i].isalnum() or source[i] in "_.@"):
                i += 1
                column += 1
            value = source[start:i]
            tokens.append(Token("IDENT", value, span(start, i, start_line, start_column)))
            continue
        two = source[i:i + 2]
        if two in _TWO_CHAR:
            tokens.append(Token("OP", two, span(i, i + 2, line, column)))
            i += 2
            column += 2
            continue
        if ch in _SINGLE:
            kind = {"(": "LPAREN", ")": "RPAREN", ",": "COMMA", ";": "COMMA"}.get(ch, "OP")
            tokens.append(Token(kind, ch, span(i, i + 1, line, column)))
            i += 1
            column += 1
            continue
        raise LexError(f"Unexpected character {ch!r}.", span(i, i + 1, line, column))

    tokens.append(Token("EOF", "", SourceSpan(len(source), len(source), line, column)))
    return tokens
