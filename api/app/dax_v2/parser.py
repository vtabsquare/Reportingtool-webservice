from __future__ import annotations

from .ast_nodes import Binary, Call, ColumnRef, Literal, MeasureDefinition, MeasureRef, Name, Node, QuotedName, TableRef, Unary, Variable, VarBlock
from .contracts import SourceSpan
from .lexer import LexError, Token, tokenize


class ParseError(ValueError):
    def __init__(self, message: str, span: SourceSpan):
        super().__init__(message)
        self.span = span


_PRECEDENCE = {"||": 1, "OR": 1, "&&": 2, "AND": 2, "=": 3, "==": 3, "<>": 3, "<": 3, ">": 3, "<=": 3, ">=": 3, "&": 4, "+": 5, "-": 5, "*": 6, "/": 6, "^": 7}
_ENUMS = {"ASC", "DESC", "DENSE", "SKIP", "DAY", "MONTH", "QUARTER", "YEAR", "WEEK", "HOUR", "MINUTE", "SECOND"}


def split_measure_definition(source: str) -> tuple[str, str, int]:
    depth = 0
    quote = ""
    for index, character in enumerate(source):
        if quote:
            if character == quote:
                if index + 1 < len(source) and source[index + 1] == quote:
                    continue
                quote = ""
            continue
        if character in "\"'":
            quote = character
        elif character in "([":
            depth += 1
        elif character in ")]":
            depth = max(0, depth - 1)
        elif character == "=" and depth == 0:
            name = source[:index].strip()
            expression = source[index + 1:].strip()
            if not name or not expression:
                break
            return name, expression, index + 1
    raise ParseError("Start with a measure name followed by =, for example: Total Sales = SUM ( Sales[Amount] ).", SourceSpan(0, max(1, len(source)), 1, 1))


class Parser:
    def __init__(self, source: str, offset: int = 0):
        self.source = source
        self.offset = offset
        self.tokens = tokenize(source)
        self.index = 0

    @property
    def current(self) -> Token:
        return self.tokens[self.index]

    def advance(self) -> Token:
        token = self.current
        self.index += 1
        return token

    def skip_newlines(self) -> None:
        while self.current.kind == "NEWLINE":
            self.advance()

    def match(self, kind: str, value: str | None = None) -> Token | None:
        self.skip_newlines()
        token = self.current
        if token.kind == kind and (value is None or token.value.upper() == value.upper()):
            return self.advance()
        return None

    def expect(self, kind: str, value: str | None = None) -> Token:
        token = self.match(kind, value)
        if token is None:
            expected = value or kind.lower()
            raise ParseError(f"Expected {expected}; found {self.current.value or 'end of formula'}.", self.current.span)
        return token

    def parse(self) -> Node:
        self.skip_newlines()
        if self.current.kind == "IDENT" and self.current.value.upper() == "VAR":
            result = self.parse_var_block()
        else:
            result = self.parse_expression()
        self.skip_newlines()
        if self.current.kind != "EOF":
            raise ParseError(f"Unexpected token {self.current.value}.", self.current.span)
        return result

    def parse_var_block(self) -> VarBlock:
        variables: list[Variable] = []
        start = self.current.span
        while True:
            self.skip_newlines()
            if not (self.current.kind == "IDENT" and self.current.value.upper() == "VAR"):
                break
            self.advance()
            name = self.expect("IDENT")
            self.expect("OP", "=")
            expression = self.parse_expression(stop_keywords={"VAR", "RETURN"})
            variables.append(Variable(name.span, name.value, expression))
        self.expect("IDENT", "RETURN")
        result = self.parse_expression()
        return VarBlock(SourceSpan(start.start, result.span.end, start.line, start.column), variables, result)

    def parse_expression(self, minimum: int = 0, stop_keywords: set[str] | None = None) -> Node:
        self.skip_newlines()
        left = self.parse_prefix()
        while True:
            self.skip_newlines()
            token = self.current
            if stop_keywords and token.kind == "IDENT" and token.value.upper() in stop_keywords:
                break
            operator = token.value.upper() if token.kind in {"OP", "IDENT"} else ""
            precedence = _PRECEDENCE.get(operator)
            if precedence is None or precedence < minimum:
                break
            self.advance()
            right = self.parse_expression(precedence + (0 if operator == "^" else 1), stop_keywords)
            left = Binary(SourceSpan(left.span.start, right.span.end, left.span.line, left.span.column), operator, left, right)
        return left

    def parse_prefix(self) -> Node:
        self.skip_newlines()
        token = self.current
        # VAR/RETURN blocks are valid scalar expressions inside iterators and
        # function arguments, not only at the root of a measure.  Treating VAR
        # as an ordinary name made the following identifier look like a stray
        # token and produced the misleading "Expected paren" diagnostic.
        if token.kind == "IDENT" and token.value.upper() == "VAR":
            return self.parse_var_block()
        if token.kind == "OP" and token.value in {"+", "-"}:
            self.advance()
            operand = self.parse_expression(8)
            return Unary(SourceSpan(token.span.start, operand.span.end, token.span.line, token.span.column), token.value, operand)
        if token.kind == "IDENT" and token.value.upper() == "NOT":
            self.advance()
            operand = self.parse_expression(8)
            return Unary(SourceSpan(token.span.start, operand.span.end, token.span.line, token.span.column), "NOT", operand)
        if token.kind == "LPAREN":
            start = self.advance()
            value = self.parse_expression()
            end = self.expect("RPAREN")
            value.span = SourceSpan(start.span.start, end.span.end, start.span.line, start.span.column)
            return value
        if token.kind == "NUMBER":
            self.advance()
            value = float(token.value) if "." in token.value else int(token.value)
            return Literal(token.span, value, "decimal" if "." in token.value else "integer")
        if token.kind == "STRING":
            self.advance()
            return Literal(token.span, token.value, "text")
        if token.kind == "BRACKET":
            self.advance()
            return MeasureRef(token.span, token.value)
        if token.kind in {"IDENT", "QIDENT"}:
            self.advance()
            name = token.value
            upper = name.upper()
            self.skip_newlines()
            if self.current.kind == "LPAREN" and token.kind == "IDENT":
                self.advance()
                arguments: list[Node] = []
                self.skip_newlines()
                if self.current.kind != "RPAREN":
                    while True:
                        # DAX permits an omitted argument in forms such as RANKX(..., , DESC).
                        if self.current.kind == "COMMA":
                            arguments.append(Literal(self.current.span, None, "blank"))
                        else:
                            arguments.append(self.parse_expression())
                        self.skip_newlines()
                        if not self.match("COMMA"):
                            break
                end = self.expect("RPAREN")
                return Call(SourceSpan(token.span.start, end.span.end, token.span.line, token.span.column), upper, arguments)
            if self.current.kind == "BRACKET":
                column = self.advance()
                return ColumnRef(SourceSpan(token.span.start, column.span.end, token.span.line, token.span.column), name, column.value)
            # VTAB legacy reports used Table.Column bindings. Accept them at
            # the compatibility boundary and render canonical DAX Table[Column].
            if token.kind == "IDENT" and "." in name:
                table_name, column_name = name.rsplit(".", 1)
                if table_name and column_name:
                    return ColumnRef(token.span, table_name, column_name)
            if upper == "TRUE":
                return Literal(token.span, True, "boolean")
            if upper == "FALSE":
                return Literal(token.span, False, "boolean")
            if upper in _ENUMS:
                return Literal(token.span, upper, "enum")
            if token.kind == "QIDENT":
                # A single-quoted DAX token normally identifies a table. Older
                # VTAB reports also used SQL-style single-quoted strings; the
                # binder distinguishes them using the current model catalog.
                return QuotedName(token.span, name)
            return Name(token.span, name)
        raise ParseError(f"Expected an expression; found {token.value or 'end of formula'}.", token.span)


def parse_measure(source: str) -> MeasureDefinition:
    name, expression, offset = split_measure_definition(source)
    parsed = Parser(expression, offset).parse()
    return MeasureDefinition(SourceSpan(0, len(source), 1, 1), name, parsed)
