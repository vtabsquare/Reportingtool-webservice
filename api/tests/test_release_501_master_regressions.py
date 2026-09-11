from app.connectors import import_file
from app.transform_engine import preview


def test_append_retains_matching_calculated_column_and_values():
    left = import_file('append_calc_left.csv', b'Id,Amount\n1,10\n')
    right = import_file('append_calc_right.csv', b'Id,Amount\n2,20\n')
    calculated = {
        'type': 'calculated_column',
        'name': 'DoubleAmount',
        'expression': '[Amount] * 2',
    }
    rows, sql, columns, _ = preview(
        left['table'],
        [
            calculated,
            {
                'type': 'append',
                'queryOutputs': [
                    {'source': right['table'], 'steps': [calculated]},
                ],
            },
        ],
        limit=20,
    )
    assert columns == ['Id', 'Amount', 'DoubleAmount']
    assert sorted((row['Id'], row['DoubleAmount']) for row in rows) == [(1, 20), (2, 40)]
    assert 'UNION ALL' in sql


def test_top_n_is_not_overridden_by_preview_default():
    payload = 'Id,Amount\n' + '\n'.join(f'{i},{10000-i}' for i in range(1, 651)) + '\n'
    source = import_file('top_650.csv', payload.encode())
    rows, sql, _, _ = preview(
        source['table'],
        [{'type': 'top_n', 'value': 500}],
        limit=500,
    )
    assert len(rows) == 500
    assert 'LIMIT 500' in sql


def test_conditional_builder_supports_else_if_and_else():
    source = import_file('conditional_cases.csv', b'Id,Amount\n1,1200\n2,700\n3,100\n')
    rows, sql, columns, _ = preview(
        source['table'],
        [{
            'type': 'conditional_column',
            'name': 'Band',
            'rules': [
                {'conditions': [{'field': 'Amount', 'operator': 'gte', 'value': 1000}], 'result': 'High'},
                {'conditions': [{'field': 'Amount', 'operator': 'gte', 'value': 500}], 'result': 'Medium'},
            ],
            'elseValue': 'Low',
        }],
        limit=20,
    )
    assert 'Band' in columns
    assert [row['Band'] for row in rows] == ['High', 'Medium', 'Low']
    assert sql.count('WHEN') == 2 and 'ELSE' in sql


def test_text_transformations_apply_to_the_selected_column():
    source = import_file('text_transform_release.csv', b'Id,Text\n1,"  Ab\tCD  "\n')
    operations = [
        {'type': 'text_transform', 'field': 'Text', 'operation': 'trim', 'outputName': 'Trimmed'},
        {'type': 'text_transform', 'field': 'Trimmed', 'operation': 'upper', 'outputName': 'Upper'},
        {'type': 'text_transform', 'field': 'Upper', 'operation': 'lower', 'outputName': 'Lower'},
        {'type': 'text_transform', 'field': 'Trimmed', 'operation': 'clean', 'outputName': 'Clean'},
        {'type': 'text_transform', 'field': 'Clean', 'operation': 'replace', 'argument': 'Ab', 'argument2': 'XY', 'outputName': 'Replaced'},
        {'type': 'text_transform', 'field': 'Replaced', 'operation': 'extract_start', 'argument': '2', 'outputName': 'FirstTwo'},
        {'type': 'text_transform', 'field': 'Replaced', 'operation': 'extract_end', 'argument': '2', 'outputName': 'LastTwo'},
        {'type': 'text_transform', 'field': 'Replaced', 'operation': 'range', 'argument': '2', 'argument2': '3', 'outputName': 'Range'},
    ]
    rows, _, columns, _ = preview(source['table'], operations, limit=10)
    row = rows[0]
    assert {'Trimmed','Upper','Lower','Clean','Replaced','FirstTwo','LastTwo','Range'} <= set(columns)
    assert row['Trimmed'] == 'Ab\tCD'
    assert row['Upper'] == 'AB\tCD'
    assert row['Lower'] == 'ab\tcd'
    assert row['Clean'] == 'Ab CD'
    assert row['Replaced'] == 'XY CD'
    assert row['FirstTwo'] == 'XY' and row['LastTwo'] == 'CD' and row['Range'] == 'Y C'
