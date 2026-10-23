from app.server import _rename_semantic_table


def test_table_rename_updates_quoted_and_unquoted_measure_references_and_metadata():
    project = {
        "model": {
            "tables": {"OldTable": {"physical": "source_table", "columns": {"Amount": "Amount"}}},
            "columnTypes": {"OldTable.Amount": "double"},
            "columnFormats": {"OldTable.Amount": {"decimals": 2}},
            "relationships": [],
            "hierarchies": [],
            "measures": {
                "Quoted": "Quoted = SUM ( 'OldTable'[Amount] )",
                "Plain": "Plain = SUM ( OldTable[Amount] )",
            },
            "measureDefinitions": {
                "Quoted": {"formula": "Quoted = SUM ( 'OldTable'[Amount] )", "dependencies": {"columns": ["OldTable.Amount"]}}
            },
            "semanticCatalog": {"tables": {"OldTable": {"name": "OldTable"}}},
        },
        "report": {"pages": [{"visuals": [{"bindings": {"axis": ["OldTable.Amount"]}, "format": {"fieldFormats": {"OldTable.Amount": {}}}}]}]},
    }

    _rename_semantic_table(project, "OldTable", "Renamed Table")

    model = project["model"]
    assert "Renamed Table" in model["tables"] and "OldTable" not in model["tables"]
    assert "'Renamed Table'[Amount]" in model["measures"]["Quoted"]
    assert "'Renamed Table'[Amount]" in model["measures"]["Plain"]
    quoted_definition = model["measureDefinitions"]["Quoted"]
    assert quoted_definition["formula"] == model["measures"]["Quoted"]
    assert quoted_definition["formulaHash"]
    assert all(item["table"] == "Renamed Table" for item in quoted_definition["dependencies"]["columns"])
    assert model["semanticCatalog"]["measures"]["Quoted"]["formulaRevision"] == quoted_definition["formulaHash"]
    visual = project["report"]["pages"][0]["visuals"][0]
    assert visual["bindings"]["axis"] == ["Renamed Table.Amount"]
    assert "Renamed Table.Amount" in visual["format"]["fieldFormats"]
