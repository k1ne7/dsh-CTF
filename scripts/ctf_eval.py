"""Validate paired CTF run records; summarize observations, never run a model."""
import argparse
import json
import math
import statistics
from pathlib import Path


def compare(records):
    if not isinstance(records, list) or not records or not all(isinstance(r, dict) for r in records):
        raise ValueError('records must be a nonempty array of objects')
    groups = {}
    configs = set()
    for row in records:
        for field in ('case', 'config', 'environment', 'verification'):
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError(f'{field} must be a nonempty string')
        if type(row.get('trial')) is not int or row['trial'] < 1:
            raise ValueError('trial must be a positive integer')
        if type(row.get('success')) is not bool:
            raise ValueError('success must be a verifier boolean')
        for key in ('elapsed_s', 'budget_s', 'total_tokens'):
            n = row.get(key)
            if type(n) not in (int, float) or not math.isfinite(n) or n < 0:
                raise ValueError(f'invalid {key}')
        if row['budget_s'] <= 0 or row['elapsed_s'] > row['budget_s']:
            raise ValueError('elapsed must be within the declared observation budget')
        if type(row['total_tokens']) is not int:
            raise ValueError('total_tokens must be an integer including teammates')
        key = (row['case'], row['trial'])
        group = groups.setdefault(key, {})
        if row['config'] in group:
            raise ValueError('duplicate case/trial/config')
        group[row['config']] = row
        configs.add(row['config'])
    if len(configs) < 2:
        raise ValueError('at least two configurations required')
    for group in groups.values():
        if set(group) != configs:
            raise ValueError('unpaired runs: include failures and timeouts')
        if len({(r['environment'], r['budget_s']) for r in group.values()}) != 1:
            raise ValueError('paired environment or time budget differs')
    summaries = {}
    for config in sorted(configs):
        rows = [g[config] for g in groups.values()]
        solved = [r['elapsed_s'] for r in rows if r['success']]
        summaries[config] = {
            'runs': len(rows), 'solved': len(solved), 'success_rate': len(solved)/len(rows),
            'median_solved_s': statistics.median(solved) if solved else None,
            'mean_budget_penalized_s': statistics.mean(
                r['elapsed_s'] if r['success'] else r['budget_s'] for r in rows),
            'total_tokens_including_teammates': sum(r['total_tokens'] for r in rows),
        }
    return {'paired_trials': len(groups), 'configs': summaries,
            'note': 'Descriptive observations, not causal proof. Verification and environment identifiers are supplied by the evaluator; this tool does not independently check flags or settings.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('records', type=Path)
    args = parser.parse_args()
    try:
        result = compare(json.loads(args.records.read_text(encoding='utf-8')))
    except (ValueError, TypeError, KeyError, OSError) as exc:
        parser.exit(2, f'invalid evaluation records: {exc}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
