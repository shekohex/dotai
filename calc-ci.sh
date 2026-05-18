#!/usr/bin/env bash
set -euo pipefail

limit=20
baseline_file=''
output_file='.tmp/ci-performance/latest.json'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)
      limit="$2"
      shift 2
      ;;
    --baseline)
      baseline_file="$2"
      shift 2
      ;;
    --output)
      output_file="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$(dirname "$output_file")"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

raw_runs_file="$tmp_dir/runs.json"
records_file="$tmp_dir/records.jsonl"
: > "$records_file"

gh run list --limit "$limit" --json databaseId,workflowName,displayTitle,status,conclusion,createdAt,updatedAt,event,headBranch > "$raw_runs_file"

jq -r '.[] | select(.workflowName == "CI" or .workflowName == "Release" or .workflowName == "Release Please") | .databaseId' "$raw_runs_file" |
while IFS= read -r run_id; do
  [[ -n "$run_id" ]] || continue
  run_file="$tmp_dir/run-${run_id}.json"
  gh run view "$run_id" --json databaseId,workflowName,displayTitle,status,conclusion,createdAt,updatedAt,jobs > "$run_file"
  jq -c --arg run_id "$run_id" '
    def seconds($start; $end):
      if ($start == null or $end == null or $start == "" or $end == "") then null else (($end | fromdateiso8601) - ($start | fromdateiso8601)) end;

    . as $run
    | {
        level: "workflow",
        workflow: $run.workflowName,
        name: $run.workflowName,
        run_id: ($run.databaseId | tostring),
        status: $run.status,
        conclusion: $run.conclusion,
        seconds: seconds($run.createdAt; $run.updatedAt)
      },
      ($run.jobs[]? | {
        level: "job",
        workflow: $run.workflowName,
        name: .name,
        run_id: ($run.databaseId | tostring),
        status: null,
        conclusion: .conclusion,
        seconds: seconds(.startedAt; .completedAt)
      }),
      ($run.jobs[]? as $job | $job.steps[]? | {
        level: "step",
        workflow: $run.workflowName,
        name: ($job.name + " / " + .name),
        run_id: ($run.databaseId | tostring),
        status: null,
        conclusion: .conclusion,
        seconds: seconds(.startedAt; .completedAt)
      })
  ' "$run_file" >> "$records_file"
done

jq -s --argjson sample_limit "$limit" '
  def avg: if length == 0 then 0 else (add / length) end;
  def aggregate($level):
    [ .[] | select(.level == $level and .seconds != null and .conclusion != "skipped") ]
    | group_by(.workflow, .name)
    | map({
        workflow: .[0].workflow,
        name: .[0].name,
        samples: length,
        avg_seconds: (map(.seconds) | avg),
        min_seconds: (map(.seconds) | min),
        max_seconds: (map(.seconds) | max)
      })
    | sort_by(.workflow, - .avg_seconds, .name);

  {
    generated_at: now | todateiso8601,
    sample_limit: $sample_limit,
    workflows: aggregate("workflow"),
    jobs: aggregate("job"),
    steps: aggregate("step")
  }
' "$records_file" > "$output_file"

echo
echo 'Workflow averages'
printf '%-18s %8s %8s %8s %8s\n' 'Workflow' 'Samples' 'Avg(s)' 'Min(s)' 'Max(s)'
jq -r '.workflows[] | [.workflow, .samples, (.avg_seconds | round), (.min_seconds | round), (.max_seconds | round)] | @tsv' "$output_file" |
while IFS=$'\t' read -r workflow samples avg_seconds min_seconds max_seconds; do
  printf '%-18s %8s %8s %8s %8s\n' "$workflow" "$samples" "$avg_seconds" "$min_seconds" "$max_seconds"
done

echo
echo 'Job averages'
printf '%-18s %-34s %8s %8s %8s %8s\n' 'Workflow' 'Job' 'Samples' 'Avg(s)' 'Min(s)' 'Max(s)'
jq -r '.jobs[] | [.workflow, .name, .samples, (.avg_seconds | round), (.min_seconds | round), (.max_seconds | round)] | @tsv' "$output_file" |
while IFS=$'\t' read -r workflow name samples avg_seconds min_seconds max_seconds; do
  printf '%-18s %-34s %8s %8s %8s %8s\n' "$workflow" "$name" "$samples" "$avg_seconds" "$min_seconds" "$max_seconds"
done

echo
echo 'Slowest step averages'
printf '%-18s %-58s %8s %8s %8s %8s\n' 'Workflow' 'Step' 'Samples' 'Avg(s)' 'Min(s)' 'Max(s)'
jq -r '[.steps[]] | sort_by(-.avg_seconds) | .[:25][] | [.workflow, .name, .samples, (.avg_seconds | round), (.min_seconds | round), (.max_seconds | round)] | @tsv' "$output_file" |
while IFS=$'\t' read -r workflow name samples avg_seconds min_seconds max_seconds; do
  printf '%-18s %-58s %8s %8s %8s %8s\n' "$workflow" "$name" "$samples" "$avg_seconds" "$min_seconds" "$max_seconds"
done

if [[ -n "$baseline_file" ]]; then
  echo
  echo 'Comparison vs baseline'
  printf '%-18s %14s %13s %8s %8s\n' 'Workflow' 'Before Avg(s)' 'After Avg(s)' 'Delta(s)' 'Delta %'
  jq -r --slurpfile before "$baseline_file" '
    def index_workflows($data): $data.workflows | map({key: .workflow, value: .}) | from_entries;
    (index_workflows($before[0])) as $baseline
    | .workflows[]
    | ($baseline[.workflow] // null) as $old
    | select($old != null)
    | [
        .workflow,
        ($old.avg_seconds | round),
        (.avg_seconds | round),
        ((.avg_seconds - $old.avg_seconds) | round),
        (if $old.avg_seconds == 0 then "n/a" else (((.avg_seconds - $old.avg_seconds) / $old.avg_seconds * 100) | round | tostring) + "%" end)
      ]
    | @tsv
  ' "$output_file" |
  while IFS=$'\t' read -r workflow before_seconds after_seconds delta_seconds delta_percent; do
    printf '%-18s %14s %13s %8s %8s\n' "$workflow" "$before_seconds" "$after_seconds" "$delta_seconds" "$delta_percent"
  done
fi

echo
echo "Wrote $output_file"
