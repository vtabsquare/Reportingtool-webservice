from app.measure_registry import merge_measure_registry


def test_create_ten_measures_preserves_all_previous_measures():
    measures={}
    for i in range(1,11):
        measures,renamed=merge_measure_registry(measures,f'Measure_{i}',f'{i}',None)
        assert not renamed
        assert len(measures)==i
    assert list(measures)==[f'Measure_{i}' for i in range(1,11)]


def test_edit_one_measure_does_not_remove_others():
    measures={'A':'1','B':'2','C':'[A]+[B]'}
    updated,renamed=merge_measure_registry(measures,'B','200','B')
    assert not renamed
    assert updated=={'A':'1','B':'200','C':'[A]+[B]'}


def test_rename_updates_dependencies_without_dropping_registry():
    measures={'Revenue':'1','Profit':'2','Margin':'DIVIDE([Profit],[Revenue])'}
    updated,renamed=merge_measure_registry(measures,'Net_Revenue','1','Revenue')
    assert renamed
    assert set(updated)=={'Net_Revenue','Profit','Margin'}
    assert '[Net_Revenue]' in updated['Margin']
