from __future__ import annotations


def merge_measure_registry(existing:dict[str,str] | None, name:str, expression:str, original_name:str|None=None):
    """Return a new measure registry without mutating or dropping existing measures.

    `original_name` is used only for an explicit edit/rename flow. A normal create
    always appends/updates `name` while preserving every other measure.
    """
    name=(name or '').strip()
    original=(original_name or '').strip() or None
    if not name:
        raise ValueError('Measure name is required')
    working=dict(existing or {})
    if original and original!=name and name in working:
        raise ValueError(f"A measure named '{name}' already exists.")
    if original and original in working and original!=name:
        working.pop(original,None)
    working[name]=expression
    if original and original!=name:
        old_ref=f'[{original}]';new_ref=f'[{name}]'
        for measure,expr in list(working.items()):
            if measure!=name and isinstance(expr,str):
                working[measure]=expr.replace(old_ref,new_ref)
    return working, bool(original and original!=name)
