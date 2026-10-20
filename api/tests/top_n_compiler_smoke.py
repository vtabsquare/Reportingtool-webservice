"""Dependency-free smoke check for the Top N SQL contract."""
import sys
import types

local_engine = types.ModuleType("app.local_engine")
local_engine.connect = lambda: None
local_engine.ensure_analytics_ready = lambda: None
sys.modules.setdefault("app.local_engine", local_engine)

from app.semantic_engine import compile_query


MODEL = {
    "tables": {
        "Sales": {
            "physical": "sales",
            "columns": {"Product": "product", "Region": "region", "Sales": "sales"},
        }
    },
    "relationships": [],
    "measures": {"Total Sales": "SUM('Sales'[Sales])"},
}


def main():
    sql, params = compile_query(MODEL, {
        "dimensions": ["Sales.Product"],
        "measures": ["Total Sales"],
        "filters": [
            {"field": "Sales.Region", "operator": "equals", "value": "North"},
            {"field": "Sales.Product", "operator": "top_n", "value": 3,
             "rankingField": "Total Sales", "rankingDirection": "top"},
        ],
        "sort": [{"field": "Sales.Product", "direction": "asc"}],
        "limit": 500,
    })
    assert 'WHERE "Total Sales" IS NOT NULL' in sql
    assert 'ORDER BY "Total Sales" DESC, "Sales.Product" ASC LIMIT 3' in sql
    assert sql.rfind('ORDER BY "Sales.Product" ASC') > sql.find('LIMIT 3')
    assert params == ["North", "North"]
    print("Top N compiler context/tie/sort checks passed")


if __name__ == "__main__":
    main()
