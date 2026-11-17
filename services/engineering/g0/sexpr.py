"""Minimal reader/writer for KiCad S-expression files.

Bare tokens are parsed as `Sym`, quoted strings as plain `str`, so files
round-trip with the same quoting KiCad expects.
"""
from __future__ import annotations

from typing import Iterator, Union


class Sym(str):
    """An unquoted token such as `symbol`, `yes`, `1.27`."""


Node = Union[str, list]


def parse(text: str) -> list:
    tokens = _tokenize(text)
    node = _read(tokens)
    return node  # type: ignore[return-value]


def _tokenize(text: str) -> Iterator[tuple[str, str]]:
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            i += 1
        elif c in "()":
            yield (c, c)
            i += 1
        elif c == '"':
            j, buf = i + 1, []
            while text[j] != '"':
                if text[j] == "\\":
                    j += 1
                    buf.append({"n": "\n", "t": "\t"}.get(text[j], text[j]))
                else:
                    buf.append(text[j])
                j += 1
            yield ("str", "".join(buf))
            i = j + 1
        else:
            j = i
            while j < n and text[j] not in ' \t\r\n()"':
                j += 1
            yield ("sym", text[i:j])
            i = j


def _read(tokens: Iterator[tuple[str, str]]) -> Node:
    kind, value = next(tokens)
    if kind == "(":
        out: list = []
        for tok in tokens:
            if tok[0] == ")":
                return out
            out.append(_read_from(tok, tokens))
        raise ValueError("unbalanced parentheses")
    return _atom(kind, value)


def _read_from(tok: tuple[str, str], tokens: Iterator[tuple[str, str]]) -> Node:
    kind, value = tok
    if kind == "(":
        out: list = []
        for t in tokens:
            if t[0] == ")":
                return out
            out.append(_read_from(t, tokens))
        raise ValueError("unbalanced parentheses")
    return _atom(kind, value)


def _atom(kind: str, value: str) -> Node:
    return Sym(value) if kind == "sym" else value


def dumps(node: Node, indent: int = 0) -> str:
    if isinstance(node, list):
        if not any(isinstance(x, list) for x in node):
            return "(" + " ".join(dumps(x) for x in node) + ")"
        pad = "\t" * (indent + 1)
        parts = [dumps(x, indent + 1) for x in node]
        head = []
        while parts and not isinstance(node[len(head)], list):
            head.append(parts.pop(0))
        return "(" + " ".join(head) + "".join("\n" + pad + p for p in parts) + "\n" + "\t" * indent + ")"
    if isinstance(node, Sym):
        return str(node)
    if isinstance(node, (int, float)):
        return _num(node)
    return '"' + node.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def _num(v: float) -> str:
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


# --- query helpers ---------------------------------------------------------

def head(node: Node) -> str | None:
    return str(node[0]) if isinstance(node, list) and node else None


def children(node: list, name: str) -> list[list]:
    return [c for c in node if isinstance(c, list) and head(c) == name]


def child(node: list, name: str) -> list | None:
    found = children(node, name)
    return found[0] if found else None


def walk(node: Node) -> Iterator[list]:
    if isinstance(node, list):
        yield node
        for c in node:
            yield from walk(c)
