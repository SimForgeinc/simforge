#!/usr/bin/env python3
"""Verify and render a stage-separated showcase benchmark report."""

import argparse
import json
import math
import sys
from pathlib import Path


REPORT_SCHEMA = "showcase-benchmark-report/v1"
MARKDOWN_SCHEMA = "showcase-benchmark-markdown/v1"
OUTCOMES = ("accepted", "attempting", "exhausted", "unsupported", "pending")
FUNNEL_STAGES = (
    ("submitted", "00-brief.json"),
    ("author-ok", "20-author/template.json"),
    ("contract-valid", "20-author/contract-verdict.json"),
    ("cells-ok", "40-cells/index.json"),
    ("gate-pass", "50-gate.json"),
    ("eligible", "55-eligibility.json"),
    ("2d-ok", "60-render2d/index.json"),
    ("semantic-reviewed", "60-render2d/quality.json"),
    ("semantic-2d", "62-semantic2d.json"),
    ("3d-ok", "65-render3d/index.json"),
    ("accepted", "75-product.json"),
)


def num(value):
    """Format a measured value without turning missing measurements into zeroes."""
    if value is None:
        return "n/a"
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def pct(rate):
    """Format the value of a rate as a one-decimal percentage."""
    if not isinstance(rate, dict) or rate.get("value") is None:
        return "n/a"
    return f"{rate['value'] * 100:.1f}%"


def interval(rate):
    """Format a rate's authoritative Wilson interval."""
    bounds = rate.get("wilson95") if isinstance(rate, dict) else None
    if bounds is None:
        return "n/a"
    return f"{bounds['low'] * 100:.1f}–{bounds['high'] * 100:.1f}%"


def cell(value):
    """Escape an arbitrary value for a Markdown table cell."""
    if value is None:
        text = "n/a"
    elif isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    else:
        text = num(value)
    return text.replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(cell(value) for value in row) + " |" for row in rows)
    return lines


def walk_dicts(value, path="benchmark"):
    if isinstance(value, dict):
        yield path, value
        for key, child in value.items():
            yield from walk_dicts(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_dicts(child, f"{path}[{index}]")


def verify(block, expect_entries=None):
    """Return violations of the benchmark block's recorded invariants."""
    violations = []

    if block.get("schema") != REPORT_SCHEMA:
        violations.append(f"schema must be {REPORT_SCHEMA!r}; got {block.get('schema')!r}")

    for path, item in walk_dicts(block):
        if "value" not in item:
            continue
        looks_like_rate = (
            "numerator" in item
            or "wilson95" in item
            or "denominator" in item
            or "denominatorHours" in item
        )
        if not looks_like_rate:
            continue
        if "numerator" not in item:
            violations.append(f"{path} reports a rate without a numerator")
            continue
        denominator_key = (
            "denominator"
            if "denominator" in item
            else "denominatorHours"
            if "denominatorHours" in item
            else None
        )
        if denominator_key is None:
            violations.append(f"{path} has numerator and value but no denominator or denominatorHours")
            continue
        denominator = item[denominator_key]
        numerator = item.get("numerator")
        value = item.get("value")
        if denominator in (0, None):
            if value is not None:
                violations.append(f"{path}.value must be null when {denominator_key} is {denominator!r}")
            continue
        if value is None:
            violations.append(f"{path}.value must not be null when {denominator_key} is nonzero")
            continue
        numeric = (int, float)
        if (
            isinstance(numerator, bool)
            or isinstance(denominator, bool)
            or isinstance(value, bool)
            or not isinstance(numerator, numeric)
            or not isinstance(denominator, numeric)
            or not isinstance(value, numeric)
        ):
            violations.append(f"{path} rate numerator, {denominator_key}, and value must be numbers")
            continue
        expected = numerator / denominator
        # The report builder rounds ordinary ratios to 6 decimals and hourly
        # rates to 4, so compare against the tightest matching rounding unit.
        tolerance = 0.00005 if denominator_key == "denominatorHours" else 0.0000005
        if not math.isclose(value, expected, rel_tol=0, abs_tol=tolerance):
            violations.append(
                f"{path}.value {value} disagrees with numerator/{denominator_key} "
                f"({numerator}/{denominator} = {expected})"
            )

    corpus = block.get("corpus") or {}
    entries = corpus.get("entries")
    outcomes = corpus.get("outcomes") or {}
    if corpus.get("accountedFor") is not True:
        violations.append("corpus.accountedFor must be true")
    if corpus.get("reported") != entries:
        violations.append(f"corpus.reported is {corpus.get('reported')}, not corpus.entries {entries}")
    outcome_values = [outcomes.get(name) for name in OUTCOMES]
    if not all(isinstance(value, int) and not isinstance(value, bool) for value in outcome_values):
        violations.append("corpus.outcomes must contain integer counts for all five outcomes")
    elif sum(outcome_values) != entries:
        violations.append(f"corpus.outcomes sum to {sum(outcome_values)}, not corpus.entries {entries}")

    cases = block.get("cases") or []
    if len(cases) != entries:
        violations.append(f"len(cases) is {len(cases)}, not corpus.entries {entries}")
    if expect_entries is not None and entries != expect_entries:
        violations.append(f"corpus.entries is {entries}, expected {expect_entries}")
    case_ids = [case.get("id") for case in cases if isinstance(case, dict)]
    if len(set(case_ids)) != len(case_ids):
        violations.append("cases contains duplicate ids, so corpus entries are not accounted for exactly once")
    actual_outcomes = {
        name: sum(case.get("outcome") == name for case in cases if isinstance(case, dict))
        for name in OUTCOMES
    }
    if all(isinstance(outcomes.get(name), int) and not isinstance(outcomes.get(name), bool) for name in OUTCOMES):
        for name in OUTCOMES:
            if outcomes[name] != actual_outcomes[name]:
                violations.append(
                    f"corpus.outcomes.{name} is {outcomes[name]}, but cases contain {actual_outcomes[name]}"
                )

    funnel = block.get("funnel") or {}
    if funnel.get("monotone") is not True:
        violations.append("funnel.monotone must be true")
    stages = funnel.get("stages") or []
    stage_ids = [stage.get("id") for stage in stages if isinstance(stage, dict)]
    expected_stage_ids = [stage_id for stage_id, _evidence in FUNNEL_STAGES]
    if stage_ids != expected_stage_ids:
        violations.append(
            f"funnel stages must be the eleven canonical ids in order; got {stage_ids!r}"
        )
    stage_by_id = {
        stage.get("id"): stage for stage in stages if isinstance(stage, dict) and stage.get("id") is not None
    }
    denominators = block.get("denominators") or {}
    submitted_attempts = denominators.get("submittedAttempts")
    previous_id = None
    previous_reached = submitted_attempts
    for stage_id, evidence in FUNNEL_STAGES:
        stage = stage_by_id.get(stage_id)
        if stage is None:
            continue
        path = f"funnel.stages[{stage_id!r}]"
        if stage.get("evidence") != evidence:
            violations.append(f"{path}.evidence is {stage.get('evidence')!r}, expected {evidence!r}")
        reached = stage.get("reached")
        denominator = stage.get("denominator")
        censored = stage.get("censoredHere")
        numeric = (int, float)
        if (
            isinstance(reached, bool)
            or isinstance(denominator, bool)
            or not isinstance(reached, numeric)
            or not isinstance(denominator, numeric)
        ):
            violations.append(f"{path} reached and denominator must be numbers")
        elif reached > denominator:
            violations.append(f"{path}.reached ({reached}) exceeds denominator ({denominator})")
        if all(
            isinstance(value, numeric) and not isinstance(value, bool)
            for value in (denominator, censored, previous_reached)
        ):
            if denominator + censored > previous_reached:
                violations.append(
                    f"{path}.denominator + censoredHere ({denominator + censored}) "
                    f"exceeds upstream {previous_id or 'submitted attempts'} reached ({previous_reached})"
                )
            if previous_id is not None and reached > previous_reached:
                violations.append(
                    f"{path}.reached ({reached}) exceeds upstream {previous_id} reached ({previous_reached})"
                )
        else:
            violations.append(f"{path} cannot verify denominator + censoredHere against upstream reached")
        previous_id = stage_id
        previous_reached = reached

    generator_attempts = denominators.get("generatorAttempts")
    product_attempts = denominators.get("productAttempts")
    operational_failures = denominators.get("operationalFailures")
    if isinstance(generator_attempts, (int, float)) and isinstance(product_attempts, (int, float)):
        if generator_attempts < product_attempts:
            violations.append(
                f"denominators.generatorAttempts ({generator_attempts}) is less than productAttempts ({product_attempts})"
            )
    else:
        violations.append("generatorAttempts and productAttempts must be numbers")
    if isinstance(submitted_attempts, (int, float)) and isinstance(generator_attempts, (int, float)):
        censored_at_or_before_eligibility = submitted_attempts - generator_attempts
        if censored_at_or_before_eligibility < 0:
            violations.append(
                "submittedAttempts - generatorAttempts is negative "
                f"({censored_at_or_before_eligibility})"
            )
        if not isinstance(operational_failures, (int, float)):
            violations.append("denominators.operationalFailures must be a number")
        elif censored_at_or_before_eligibility > operational_failures:
            violations.append(
                "submittedAttempts - generatorAttempts "
                f"({censored_at_or_before_eligibility}) exceeds "
                f"denominators.operationalFailures ({operational_failures})"
            )
    else:
        violations.append("submittedAttempts and generatorAttempts must be numbers")

    unsupported_rows = [
        entry for entry in (block.get("unsupported") or []) if isinstance(entry, dict)
    ]
    unsupported_by_id = {entry.get("id"): entry for entry in unsupported_rows}
    cases_by_id = {case.get("id"): case for case in cases if isinstance(case, dict)}
    for index, case in enumerate(cases):
        outcome = case.get("outcome")
        reason = case.get("unsupportedReason")
        case_id = case.get("id")
        if outcome not in OUTCOMES:
            violations.append(f"cases[{index}].outcome {outcome!r} is not a recognized outcome")
        if outcome == "unsupported" and reason is None:
            violations.append(f"cases[{index}] ({case_id}) is unsupported but has no unsupportedReason")
        if reason is not None:
            unsupported = unsupported_by_id.get(case_id)
            if unsupported is None:
                violations.append(f"cases[{index}] ({case_id}) has unsupportedReason but is absent from unsupported")
            elif unsupported.get("reason") != reason:
                violations.append(
                    f"cases[{index}] ({case_id}) unsupportedReason {reason!r} "
                    f"does not match unsupported reason {unsupported.get('reason')!r}"
                )
    for index, unsupported in enumerate(unsupported_rows):
        case = cases_by_id.get(unsupported.get("id"))
        if case is None or case.get("unsupportedReason") != unsupported.get("reason"):
            violations.append(
                f"unsupported[{index}] ({unsupported.get('id')}) has no matching case unsupportedReason"
            )

    if (block.get("operational") or {}).get("excludedFromGenerationDenominator") is not True:
        violations.append("operational.excludedFromGenerationDenominator must be true")

    model_histograms = (block.get("execution") or {}).get("models") or {}
    for name in ("author", "engineRequested", "engineResolved"):
        histogram = model_histograms.get(name) or {}
        populated = [key for key, count in histogram.items() if isinstance(count, (int, float)) and count > 0]
        if len(populated) > 1:
            violations.append(
                f"execution.models.{name} mixes incomparable conditions: {', '.join(sorted(populated))}"
            )

    # The report declares its own defect taxonomy, so the codes it counts must belong to
    # that taxonomy and its `unknownCodes` claim must match what is actually counted.
    # A report that counts a foreign code while claiming none is summarising verdicts
    # produced under a different review contract than the one it names.
    defects = block.get("defects") or {}
    if defects.get("taxonomy"):
        vocabulary = defects.get("vocabulary")
        if not isinstance(vocabulary, list) or not vocabulary:
            violations.append("defects.taxonomy is declared but defects.vocabulary is empty")
        else:
            counted = (defects.get("attemptsByCode") or {}).keys()
            observed_unknown = sorted(code for code in counted if code not in vocabulary)
            declared_unknown = defects.get("unknownCodes")
            if not isinstance(declared_unknown, list):
                violations.append("defects.unknownCodes must be a list when a taxonomy is declared")
            elif sorted(str(code) for code in declared_unknown) != observed_unknown:
                violations.append(
                    "defects.unknownCodes "
                    f"{sorted(str(code) for code in declared_unknown)!r} disagrees with the codes "
                    f"counted outside defects.vocabulary {observed_unknown!r}"
                )

    return violations


def summary_rows(summary):
    return [(key, num(summary.get(key))) for key in ("n", "min", "p50", "p90", "max", "mean", "total")]


def rate_text(rate):
    return f"{num(rate.get('numerator'))}/{num(rate.get('denominator'))} ({pct(rate)})"


def render_throughput(lines, throughput):
    for key, heading in (("generator", "Generator"), ("product", "Product")):
        data = throughput.get(key) or {}
        lines.extend([f"### {heading}", "", str(data.get("boundary") or ""), ""])
        metrics = [("attempts", data.get("attempts"))]
        if key == "generator":
            metrics.extend(
                [
                    ("gate-passed attempts", data.get("gatePassedAttempts")),
                    ("gate-passed cells", data.get("gatePassedCells")),
                    ("eligible attempts", data.get("eligibleAttempts")),
                    ("eligible cells", data.get("eligibleCells")),
                    ("tokens per eligible attempt", data.get("tokensPerEligibleAttempt")),
                ]
            )
        else:
            metrics.extend(
                [
                    ("accepted attempts", data.get("acceptedAttempts")),
                    ("accepted cells", data.get("acceptedCells")),
                    ("tokens per accepted cell", data.get("tokensPerAcceptedCell")),
                ]
            )
        lines.extend(table(["measure", "value"], metrics))
        lines.append("")
        lines.extend([f"Yield: {rate_text(data.get('yield') or {})}", ""])
        if key == "generator":
            lines.extend([f"Gate yield: {rate_text(data.get('gateYield') or {})}", ""])
        wall = data.get("wallS") or {}
        lines.extend(
            table(
                ["wall", "p50 seconds", "p90 seconds", "mean seconds"],
                [("all attempts", wall.get("p50"), wall.get("p90"), wall.get("mean"))],
            )
        )
        lines.append("")
        if key == "product":
            render_wall = data.get("renderWallS") or {}
            lines.extend(
                table(
                    ["wall", "p50 seconds", "p90 seconds", "mean seconds"],
                    [("render", render_wall.get("p50"), render_wall.get("p90"), render_wall.get("mean"))],
                )
            )
            lines.append("")
        per_hour = [
            (name, value)
            for name, value in data.items()
            if name.endswith("PerHour") and isinstance(value, dict)
        ]
        lines.extend(
            table(
                ["per-hour rate", "numerator", "denominatorHours", "value"],
                [
                    (name, rate.get("numerator"), rate.get("denominatorHours"), rate.get("value"))
                    for name, rate in per_hour
                ],
            )
        )
        lines.append("")


def render_execution(lines, execution):
    """Render the recorded execution conditions without deriving new metrics."""
    cold = execution.get("cold") or {}
    resumed = execution.get("resumed") or {}
    concurrency = execution.get("concurrency") or {}
    models = execution.get("models") or {}
    lines.extend(["## Execution", "", f"Attempts: {num(execution.get('attempts'))}", ""])
    lines.extend(
        table(
            ["condition", "numerator/denominator", "rate", "Wilson 95%", "basis"],
            [
                ("cold", rate_text(cold), pct(cold), interval(cold), cold.get("basis")),
                ("resumed", rate_text(resumed), pct(resumed), interval(resumed), "recorded resumed flag"),
            ],
        )
    )
    lines.extend(["", "### Resumed stages", ""])
    lines.extend(table(["stage", "attempts"], sorted((resumed.get("stages") or {}).items())))
    lines.extend(["", "### Host concurrency", ""])
    distribution_names = (
        "activeJobsAtStart",
        "peakActiveJobs",
        "load1AtStart",
        "load1AtSimulation",
    )
    lines.extend(
        table(
            ["measure", "n", "min", "p50", "p90", "max", "mean", "total"],
            [
                (
                    name,
                    *((concurrency.get(name) or {}).get(key) for key in ("n", "min", "p50", "p90", "max", "mean", "total")),
                )
                for name in distribution_names
            ],
        )
    )
    for name in ("logicalCpus", "scheduler"):
        lines.extend(["", f"#### {name}", ""])
        lines.extend(table(["condition", "attempts"], sorted((concurrency.get(name) or {}).items())))
    lines.extend(["", str(concurrency.get("note", "")), "", "### Models", ""])
    for name in ("author", "engineRequested", "engineResolved"):
        lines.extend([f"#### {name}", ""])
        lines.extend(table(["condition", "attempts"], sorted((models.get(name) or {}).items())))
        lines.append("")
    lines.append(str(models.get("note", "")))


def render_markdown(block, violations):
    campaign_id = block.get("campaignId")
    generated_at = block.get("generatedAt")
    corpus = block.get("corpus") or {}
    denominators = block.get("denominators") or {}
    lines = [f"# Benchmark report: {campaign_id} — {generated_at}", "", "## Corpus", ""]
    entries = corpus.get("entries")
    lines.extend(table(["outcome", "count/entries"], [(name, f"{num((corpus.get('outcomes') or {}).get(name))}/{num(entries)}") for name in OUTCOMES]))

    lines.extend(["", "## Denominators", ""])
    lines.extend(table(["denominator", "value"], list(denominators.items())))

    # The coverage/quality split is the load-bearing claim about unsupported
    # entries: they stay in the coverage denominator and leave the quality one.
    lines.extend(["", "## Coverage and quality", ""])
    coverage = block.get("coverage") or {}
    quality = block.get("quality") or {}
    lines.extend(
        table(
            ["metric", "denominator basis", "numerator/denominator", "rate", "Wilson 95%"],
            [
                (name, "all corpus entries", rate_text(rate or {}), pct(rate or {}), interval(rate or {}))
                for name, rate in coverage.items()
            ]
            + [
                (name, "supported entries only", rate_text(rate or {}), pct(rate or {}), interval(rate or {}))
                for name, rate in quality.items()
            ],
        )
    )

    lines.extend(["", "## Funnel", ""])
    funnel_rows = []
    funnel_by_id = {
        stage.get("id"): stage
        for stage in ((block.get("funnel") or {}).get("stages") or [])
        if isinstance(stage, dict)
    }
    for stage_id, _evidence in FUNNEL_STAGES:
        stage = funnel_by_id.get(stage_id)
        if stage is None:
            continue
        rate = stage.get("stepRate") or {}
        funnel_rows.append(
            (
                stage.get("label") or stage_id,
                stage.get("phase"),
                f"{num(stage.get('reached'))}/{num(stage.get('denominator'))}",
                pct(rate),
                interval(rate),
                stage.get("censoredHere"),
            )
        )
    lines.extend(table(["stage", "phase", "reached/denominator", "step rate", "Wilson 95%", "censored here"], funnel_rows))

    lines.extend(["", "## Throughput", ""])
    render_throughput(lines, block.get("throughput") or {})

    cost = block.get("cost") or {}
    tokens = cost.get("tokens") or {}
    cpu = cost.get("cpu") or {}
    gpu = cost.get("gpu") or {}
    lines.extend(["## Cost", "", "### Wall", ""])
    lines.extend(table(["measure", "value"], summary_rows(cost.get("wallS") or {})))
    lines.extend(["", "### Tokens", ""])
    token_keys = ("calls", "inputTokens", "outputTokens", "reasoningTokens", "modelWallS", "dollarCost")
    lines.extend(table(["measure", "value"], [(key, tokens.get(key)) for key in token_keys]))
    if tokens.get("dollarCostNote") is not None:
        lines.extend(["", str(tokens["dollarCostNote"])])
    lines.extend(["", "### CPU", "", str(cpu.get("attributionNote", "")), "", "### GPU", "", str(gpu.get("attributionNote", ""))])

    lines.append("")
    render_execution(lines, block.get("execution") or {})

    diversity = block.get("diversity") or {}
    maps = diversity.get("maps") or {}
    sites = diversity.get("sites") or {}
    pairwise = diversity.get("pairwise") or {}
    lines.extend(["", "## Diversity", ""])
    lines.extend(
        table(
            ["measure", "value"],
            [
                ("distinct trajectory fingerprints / videos", f"{num(diversity.get('distinctTrajectoryFingerprints'))}/{num(diversity.get('videos'))}"),
                ("unfingerprinted videos", diversity.get("unfingerprintedVideos")),
                ("re-encode-only duplicate videos", diversity.get("reencodedOnlyVideos")),
                (
                    "re-encode-only groups",
                    "; ".join(
                        f"{group.get('trajectoryFingerprint', '')[:12]} x{group.get('distinctVideoSha256')}"
                        for group in (diversity.get("reencodedOnlyGroups") or [])
                    ) or "none",
                ),
                ("map coverage", rate_text(maps.get("coverage") or {})),
                ("distinct maps", maps.get("distinct")),
                ("map balance", maps.get("balance")),
                ("distinct sites", sites.get("distinct")),
                ("site spread", rate_text(sites.get("perVideo") or {})),
                ("site balance", sites.get("balance")),
            ],
        )
    )
    lines.extend(["", "### Pairwise", ""])
    lines.extend(
        table(
            ["distance", "p50", "p90"],
            [
                ("absolute (m)", (pairwise.get("absoluteM") or {}).get("p50"), (pairwise.get("absoluteM") or {}).get("p90")),
                ("shape (m)", (pairwise.get("shapeM") or {}).get("p50"), (pairwise.get("shapeM") or {}).get("p90")),
                ("speed (m/s)", (pairwise.get("speedMps") or {}).get("p50"), (pairwise.get("speedMps") or {}).get("p90")),
            ],
        )
    )
    lines.extend(["", str(diversity.get("note", ""))])

    operational = block.get("operational") or {}
    lines.extend(["", "## Operational", "", f"Total censored attempts: {num(operational.get('attempts'))}", ""])
    lines.extend(table(["class", "attempts"], sorted((operational.get("byClass") or {}).items())))
    lines.extend(["", str(operational.get("note", ""))])

    defects = block.get("defects") or {}
    defect_rows = sorted((defects.get("attemptsByCode") or {}).items(), key=lambda item: (-item[1], item[0]))
    lines.extend(["", "## Defects", ""])
    taxonomy = defects.get("taxonomy")
    if taxonomy:
        vocabulary = defects.get("vocabulary") or []
        lines.extend([f"Taxonomy: `{taxonomy}` ({len(vocabulary)} codes).", ""])
    lines.extend(table(["code", "attempts"], defect_rows))
    unknown_codes = defects.get("unknownCodes")
    if unknown_codes:
        lines.extend([
            "",
            "Codes counted that are outside the declared taxonomy — this report mixes verdicts "
            f"from another contract: {', '.join(str(code) for code in unknown_codes)}",
        ])
    lines.extend(["", f"Attempts with unattributed reviewer prose: {num(defects.get('unclassifiedAttempts'))}"])
    if defects.get("note"):
        lines.extend(["", str(defects["note"])])

    lines.extend(["", "## Unsupported", ""])
    unsupported_rows = []
    for item in block.get("unsupported") or []:
        unsupported_rows.append(
            (
                item.get("id"),
                item.get("reason"),
                item.get("detail"),
                item.get("evidence"),
                item.get("agreeingAttempts"),
            )
        )
    lines.extend(table(["case id", "reason", "detail", "evidence", "agreeing attempts"], unsupported_rows))

    lines.extend(["", "## All entries", ""])
    case_rows = []
    for case in block.get("cases") or []:
        case_rows.append(
            (
                case.get("id"),
                case.get("index"),
                case.get("outcome"),
                f"{num(case.get('acceptedVideos'))}/{num(case.get('target'))}",
                case.get("submittedAttempts"),
                case.get("generationAttempts"),
                case.get("operationalFailures"),
                case.get("attemptBudget"),
                case.get("furthestStage"),
                case.get("unsupportedReason"),
            )
        )
    lines.extend(
        table(
            [
                "id",
                "index",
                "outcome",
                "accepted/target",
                "submitted attempts",
                "generation attempts",
                "operational failures",
                "max generation attempts",
                "furthest stage",
                "unsupportedReason",
            ],
            case_rows,
        )
    )

    lines.extend(["", "## Verification", ""])
    if violations:
        lines.extend(f"- {violation}" for violation in violations)
    else:
        lines.append("No violations.")
    return "\n".join(lines) + "\n"


def extract_block(document):
    if isinstance(document, dict) and document.get("schema") == REPORT_SCHEMA:
        return document
    if isinstance(document, dict):
        totals = document.get("totals")
        if isinstance(totals, dict) and isinstance(totals.get("benchmark"), dict):
            return totals["benchmark"]
    return None


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, help="campaign report.json or bare benchmark JSON")
    parser.add_argument("--expect-entries", type=int)
    parser.add_argument("--markdown", help="write Markdown here instead of stdout")
    parser.add_argument("--json", dest="json_path", help="write a machine-readable verification summary")
    parser.add_argument("--strict", action="store_true", help="exit 1 when verification finds violations")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        with open(args.report, encoding="utf-8") as source:
            document = json.load(source)
    except (OSError, json.JSONDecodeError) as error:
        print(f"benchmark_report.py: cannot load {args.report}: {error}", file=sys.stderr)
        return 2

    block = extract_block(document)
    if block is None:
        print(
            "benchmark_report.py: report contains neither totals.benchmark nor a bare "
            f"{REPORT_SCHEMA} document",
            file=sys.stderr,
        )
        return 2

    violations = verify(block, args.expect_entries)
    markdown = render_markdown(block, violations)
    if args.markdown:
        Path(args.markdown).write_text(markdown, encoding="utf-8")
    else:
        sys.stdout.write(markdown)

    if args.json_path:
        result = {
            "schema": MARKDOWN_SCHEMA,
            "campaignId": block.get("campaignId"),
            "generatedAt": block.get("generatedAt"),
            "expectedEntries": args.expect_entries,
            "violations": violations,
            "consistent": not violations,
            "corpus": block.get("corpus"),
            "denominators": block.get("denominators"),
        }
        Path(args.json_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return 1 if args.strict and violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
