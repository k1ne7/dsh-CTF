import copy
import unittest

from scripts.ctf_eval import compare


class EvaluationTests(unittest.TestCase):
    def test_reject_invalid_container(self):
        for rows in [None, {}, [], ['invalid']]:
            with self.assertRaises(ValueError):
                compare(rows)

    def rows(self):
        return [{'case': 'fixture', 'trial': 1, 'config': c, 'environment': 'fixed',
                 'success': ok, 'verification': 'fixture-checker', 'elapsed_s': 5,
                 'budget_s': 10, 'total_tokens': 100} for c, ok in [('native', True), ('ctf', False)]]

    def test_failures_are_not_filtered_out(self):
        r = compare(self.rows())['configs']['ctf']
        self.assertEqual(r['success_rate'], 0)
        self.assertIsNone(r['median_solved_s'])
        self.assertEqual(r['mean_budget_penalized_s'], 10)

    def test_reject_unpaired_and_duplicates(self):
        for rows in [self.rows()[:1], self.rows() + [self.rows()[0]]]:
            with self.assertRaises(ValueError):
                compare(rows)

    def test_reject_mismatched_controls(self):
        for key, value in [('environment', 'different'), ('budget_s', 12)]:
            rows = self.rows()
            rows[1][key] = value
            with self.assertRaises(ValueError):
                compare(rows)

    def test_reject_invalid_metrics(self):
        for key, value in [('elapsed_s', float('nan')), ('total_tokens', -1),
                           ('success', 'yes'), ('elapsed_s', 11), ('trial', True)]:
            rows = copy.deepcopy(self.rows())
            rows[1][key] = value
            with self.assertRaises(ValueError):
                compare(rows)

    def test_repetitions_stay_paired(self):
        rows = self.rows()
        more = copy.deepcopy(rows)
        for row in more:
            row['trial'] = 2
        self.assertEqual(compare(rows + more)['paired_trials'], 2)
