"""Unit tests for Phase 1 derived-index engine, reference-price gate, and ETF calendar math."""
from datetime import date, timedelta
import unittest
from pipeline import engine


def make_calendar(start_d, count):
    out = []
    cur = start_d
    while len(out) < count:
        if cur.weekday() < 5:
            out.append(cur)
        cur += timedelta(days=1)
    return out


class EngineTests(unittest.TestCase):
    def test_tri_division_invariance_across_subperiods_with_split_and_dividends(self):
        # 20 trading days: day 5 1-for-4 split, day 10 cash div + stock div
        cal = make_calendar(date(2025, 6, 2), 20)
        quotes = []
        for i, d in enumerate(cal):
            if i < 5:
                px = 100.0 + i
            elif i < 10:
                px = 26.0 + (i - 5) * 0.5
            else:
                px = 25.0 + (i - 10) * 0.4
            quotes.append((d, px))
        events = [
            {'kind': 'split', 'date': cal[5], 'ratio': 4.0},
            {'kind': 'cash', 'date': cal[10], 'cash': 2.0},
            {'kind': 'stock', 'date': cal[10], 'ratio': 1.1},
        ]
        res = engine.build_derived_series(quotes, events, cal)
        self.assertEqual(res['gate_errors'], [])
        # Verify TRI(t)/TRI(s) - 1 matches direct fresh start from s for multiple start dates
        for s_idx in (0, 2, 5, 8, 12):
            sub_quotes = quotes[s_idx:]
            direct = engine.build_derived_series(sub_quotes, events, cal[s_idx:])
            for offset in range(1, len(sub_quotes)):
                t_idx = s_idx + offset
                via_div = engine.range_return_pct(res['tri'], res['breaks'], s_idx, t_idx)
                via_direct = round(direct['tri'][offset] - 100.0, 4)
                self.assertAlmostEqual(via_div, via_direct, places=3)

    def test_cash_and_loss_capital_reductions_preserve_continuity(self):
        cal = make_calendar(date(2022, 9, 1), 10)
        # Cash refund (2603-like: A=80.8, P=187.0 -> C=0.4, F=6.0)
        q_cash = [(d, 80.8 if i < 5 else 187.0) for i, d in enumerate(cal)]
        ev_cash = [engine.parse_capital_reduction(cal[5], 80.8, 187.0, '退還股款')]
        res_cash = engine.build_derived_series(
            q_cash, ev_cash, cal,
            reference_checks=[{'date': cal[5], 'before': 80.8, 'after': 187.0, 'source': 'TWTAUU'}],
        )
        self.assertEqual(res_cash['gate_errors'], [])
        self.assertEqual(res_cash['breaks'], [])
        self.assertAlmostEqual(res_cash['tri'][-1], 100.0, places=3)
        self.assertAlmostEqual(res_cash['pri'][-1], 100.0, places=3)

        # Loss-offset (2609-like: A=6.15, P=13.16 -> C=6.15/13.16, F=0)
        q_loss = [(d, 6.15 if i < 5 else 13.16) for i, d in enumerate(cal)]
        ev_loss = [engine.parse_capital_reduction(cal[5], 6.15, 13.16, '彌補虧損')]
        res_loss = engine.build_derived_series(q_loss, ev_loss, cal)
        self.assertAlmostEqual(res_loss['tri'][-1], 100.0, places=3)
        self.assertAlmostEqual(res_loss['pri'][-1], 100.0, places=3)

    def test_unsupported_reduction_creates_fail_closed_break(self):
        cal = make_calendar(date(2025, 1, 2), 6)
        quotes = [(d, 50.0) for d in cal]
        ev = [engine.parse_capital_reduction(cal[3], 50.0, 60.0, '退還股款', exright=55.0)]
        res = engine.build_derived_series(quotes, ev, cal)
        self.assertEqual(len(res['breaks']), 1)
        # Spanning the break returns None; after the break still works cleanly.
        self.assertIsNone(engine.range_return_pct(res['tri'], res['breaks'], 0, 5))
        self.assertIsNotNone(engine.range_return_pct(res['tri'], res['breaks'], 3, 5))

    def test_official_reference_price_gate_blocks_missing_event(self):
        cal = make_calendar(date(2025, 6, 10), 6)
        quotes = [(d, 100.0 if i < 3 else 25.0) for i, d in enumerate(cal)]
        res = engine.build_derived_series(
            quotes, [], cal,
            reference_checks=[{'date': cal[3], 'before': 100.0, 'after': 25.0, 'source': 'TWSE TWTCAU'}],
        )
        self.assertEqual(len(res['gate_errors']), 1)
        self.assertIn('官方參考價閘門異常', res['gate_errors'][0])

    def test_calendar_returns_restrict_benchmark_comparison_to_eligible_category(self):
        cal = [date(2023, 12, 29), date(2024, 6, 3), date(2024, 12, 31), date(2025, 12, 31)]
        tri = [100.0, 105.0, 120.0, 132.0]
        bench = [100.0, 103.0, 110.0, 140.0]

        eq = engine.compute_calendar_returns(tri, [], cal, [2024, 2025], benchmark_tri=bench, benchmark_eligible=True, as_of=date(2025, 12, 31))
        by_y = {r['year']: r for r in eq}
        self.assertEqual(by_y[2024]['total_ret_pct'], 20.0)
        self.assertEqual(by_y[2024]['excess_pct'], 10.0)
        self.assertTrue(by_y[2024]['beat_benchmark'])
        self.assertFalse(by_y[2025]['beat_benchmark'])

        # Bond ETF must NOT be judged against TAIEX
        bond = engine.compute_calendar_returns(tri, [], cal, [2024, 2025], benchmark_tri=bench, benchmark_eligible=False, as_of=date(2025, 12, 31))
        self.assertIsNone(bond[0]['excess_pct'])
        self.assertIsNone(bond[0]['beat_benchmark'])

    def test_tpex_reduction_html_parser(self):
        html = (
            '<table><tr><th>每壹仟股換發新股票:</th><td>500.00000000&nbsp股</td></tr>'
            '<tr><th>每股退還股款:</th><td>5.00000000&nbsp元/股</td></tr>'
            '<tr><th>現金增資總股數:</th><td>NA</td></tr></table>'
        )
        ratio, cash, has_inc = engine.parse_tpex_reduction_detail_html(html)
        self.assertEqual(ratio, 0.5)
        self.assertEqual(cash, 5.0)
        self.assertFalse(has_inc)

    def test_typhoon_postponed_ex_dividend_uses_next_trading_day_close(self):
        # 2026-07-10 market closed (typhoon); ex-div postponed to next trading day 2026-07-13.
        cal = [date(2026, 7, 9), date(2026, 7, 13), date(2026, 7, 14)]
        quotes = [(date(2026, 7, 9), 69.9), (date(2026, 7, 13), 66.5), (date(2026, 7, 14), 65.0)]
        events = [{'kind': 'cash', 'date': date(2026, 7, 10), 'cash': 2.5}]
        res = engine.build_derived_series(quotes, events, cal)
        self.assertEqual(res['breaks'], [])
        self.assertEqual(res['div_count'], 1)
        # Reinvest 2.5 at 66.5 -> shares = 1 + 2.5/66.5 -> TRI = shares * 66.5 / 69.9 * 100
        expected_day1 = round((1.0 + 2.5 / 66.5) * 66.5 / 69.9 * 100.0, 6)
        self.assertAlmostEqual(res['tri'][1], expected_day1, places=4)

    def test_cash_rights_issue_ex_right_preserves_continuity_and_passes_gate(self):
        # 2882 2022-12-05: pure cash capital-increase subscription (44.00 -> 43.16, zero cash/free-stock div)
        cal = [date(2022, 12, 2), date(2022, 12, 5), date(2022, 12, 6)]
        quotes = [(date(2022, 12, 2), 44.0), (date(2022, 12, 5), 43.16), (date(2022, 12, 6), 45.0)]
        events = [{'kind': 'rights_issue', 'date': date(2022, 12, 5), 'ratio': 44.0 / 43.16}]
        refs = [{'date': date(2022, 12, 5), 'before': 44.0, 'after': 43.16, 'source': 'TWSE TWT49U'}]
        res = engine.build_derived_series(quotes, events, cal, reference_checks=refs)
        self.assertEqual(res['gate_errors'], [])
        self.assertEqual(res['div_count'], 0)
        self.assertAlmostEqual(res['tri'][1], 100.0, places=4)
        self.assertAlmostEqual(res['pri'][1], 100.0, places=4)


if __name__ == '__main__':
    unittest.main()
