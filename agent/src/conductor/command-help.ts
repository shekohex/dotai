import { getDefaultConductorRoot, getDefaultConfigPath } from "./config.js";
import { SUPPORTED_WEBHOOK_EVENTS } from "./webhook.js";

type OptionHelp = {
  flags: string;
  value?: string;
  defaultValue: string;
  description: string;
};

type CommandHelp = {
  name: string;
  usage: string;
  summary: string;
  description: string;
  options?: OptionHelp[];
  subcommands?: Array<{ name: string; description: string }>;
  examples?: string[];
};

const COMMANDS: CommandHelp[] = [
  {
    name: "serve",
    usage: "pi conductor serve",
    summary: "Run foreground worker for systemd/supervisors.",
    description:
      "Starts the long-running conductor loop. It validates config, starts webhook server when configured, replays pending webhook deliveries, runs one reconcile, then polls on interval.",
    options: [],
    examples: ["pi conductor serve"],
  },
  {
    name: "daemon",
    usage: "pi conductor daemon <start|stop|restart|status>",
    summary: "Manage local background conductor process.",
    description:
      "Convenience process manager for local use. Systemd/supervisord should prefer `pi conductor serve` directly.",
    subcommands: [
      { name: "start", description: "Start detached `pi conductor serve`." },
      { name: "stop", description: "Send SIGTERM and report if process did not stop within 5s." },
      { name: "restart", description: "Stop then start. Fails if old process stays alive." },
      { name: "status", description: "Print pid/log paths and running state." },
    ],
    examples: ["pi conductor daemon start", "pi conductor daemon status"],
  },
  {
    name: "reconcile",
    usage: "pi conductor reconcile",
    summary: "Run one foreground reconcile pass.",
    description:
      "Processes eligible project items and active runs once, then exits. Useful for debugging config or forcing work without running serve.",
    examples: ["pi conductor reconcile"],
  },
  {
    name: "status",
    usage: "pi conductor status [--json]",
    summary: "Show known runs.",
    description: "Reads local SQLite state and prints active/terminal conductor runs.",
    options: [
      { flags: "--json", defaultValue: "false", description: "Print machine-readable JSON." },
    ],
    examples: ["pi conductor status", "pi conductor status --json"],
  },
  {
    name: "runs",
    usage: "pi conductor runs [--json]",
    summary: "Alias for status.",
    description: "Same output and options as `status`.",
    options: [
      { flags: "--json", defaultValue: "false", description: "Print machine-readable JSON." },
    ],
    examples: ["pi conductor runs --json"],
  },
  {
    name: "run",
    usage:
      "pi conductor run <issue-url|owner/repo#n|issue-number|project-item-id> [run overrides] [pi flags]",
    summary: "Manually dispatch one issue/project item.",
    description:
      "Resolves a GitHub issue or Projects v2 item, creates a run record, prepares an isolated worktree, writes the prompt artifact, and launches Herdr.",
    options: [
      {
        flags: "--repo-path",
        value: "PATH",
        defaultValue: "configured repository repoPath",
        description: "Local checkout used as source repo for git operations.",
      },
      {
        flags: "--base-ref",
        value: "REF",
        defaultValue: "repository default branch or config baseRef",
        description: "Base branch/ref used when creating the worktree branch.",
      },
      {
        flags: "--branch-template",
        value: "TPL",
        defaultValue: "pi/${{ github.issue.number }}-${{ github.issue.slug }}",
        description: "Template for generated branch name. Supports `${{ }}` expressions only.",
      },
      {
        flags: "--branch-prefix",
        value: "PREFIX",
        defaultValue: "pi",
        description: "Value for `${{ conductor.branchPrefix }}` in branch templates.",
      },
      {
        flags: "--branch-kind",
        value: "KIND",
        defaultValue: "issue",
        description: "Value for `${{ conductor.branchKind }}` in branch templates.",
      },
      {
        flags: "--worktree-root",
        value: "PATH",
        defaultValue: "<stateRoot>/worktrees/<owner>/<repo>",
        description: "Parent directory for conductor-managed worktrees.",
      },
    ],
    examples: [
      "pi conductor run owner/repo#123",
      "pi conductor run 123 --base-ref release --mode deep",
    ],
  },
  {
    name: "logs",
    usage: "pi conductor logs <run-id>",
    summary: "Print run event log JSONL.",
    description:
      "Reads persisted event log for one run from `<stateRoot>/run/<run-id>-logs.jsonl`.",
    examples: ["pi conductor logs octo__demo__123__..."],
  },
  {
    name: "send",
    usage: "pi conductor send <run-id> <message> [--follow-up] [--now|--steer]",
    summary: "Send feedback into Herdr pane.",
    description:
      "Finds/reuses the run's Herdr pane and sends a message. Use `--` before message text that starts with an option-like token.",
    options: [
      {
        flags: "--follow-up",
        defaultValue: "false",
        description: "Queue message for next turn instead of steering active turn.",
      },
      {
        flags: "--now, --steer",
        defaultValue: "true",
        description: "Send message immediately as steering input.",
      },
    ],
    examples: [
      'pi conductor send <run-id> "fix review feedback" --follow-up',
      "pi conductor send <run-id> -- --literal-looking-message",
    ],
  },
  ...["stop", "pause", "resume", "retry"].map((name) => ({
    name,
    usage: `pi conductor ${name} <run-id>`,
    summary: `${capitalize(name)} one run.`,
    description: controlDescription(name),
    examples: [`pi conductor ${name} <run-id>`],
  })),
  {
    name: "cleanup",
    usage: "pi conductor cleanup <run-id|--merged|--gc> [--older-than-days N] [--no-vacuum]",
    summary: "Clean worktrees or prune old state.",
    description:
      "Without flags, cleans one run. `--merged` cleans all merged runs. `--gc` prunes old terminal events and completed/failed webhook deliveries.",
    options: [
      {
        flags: "--merged",
        defaultValue: "false",
        description: "Clean all runs whose PR branch was merged.",
      },
      { flags: "--gc", defaultValue: "false", description: "Run SQLite/event retention cleanup." },
      {
        flags: "--older-than-days",
        value: "N",
        defaultValue: "90",
        description: "Retention cutoff for `--gc`.",
      },
      { flags: "--vacuum", defaultValue: "true", description: "Vacuum SQLite after GC." },
      { flags: "--no-vacuum", defaultValue: "false", description: "Skip SQLite VACUUM." },
    ],
    examples: [
      "pi conductor cleanup <run-id>",
      "pi conductor cleanup --merged",
      "pi conductor cleanup --gc --older-than-days 30",
    ],
  },
  {
    name: "config",
    usage: "pi conductor config <init|validate|format|edit|get|set>",
    summary: "Create, validate, edit, or automate global config.",
    description: `Config file default: ${getDefaultConfigPath()}`,
    subcommands: [
      {
        name: "init",
        description:
          "Create/update/migrate global config, schema, repo entry, and .pi/WORKFLOW.md.",
      },
      {
        name: "validate",
        description: "Validate config, gh auth, repo paths, workflow, webhook secret.",
      },
      { name: "format", description: "Format config JSON and rewrite schema." },
      { name: "edit", description: "Open config in $VISUAL or $EDITOR, then validate it." },
      { name: "get", description: "Read value by path, e.g. repositories[0].project.number." },
      { name: "set", description: "Set value by path; values parse as JSON when possible." },
    ],
    options: [
      {
        flags: "--json",
        defaultValue: "false",
        description: "For `config get`, force JSON output for scalar values too.",
      },
    ],
    examples: [
      "pi conductor config init",
      "pi conductor config validate",
      "pi conductor config get repositories[0].project.number --json",
      "pi conductor config set repositories[0].project.number 12",
      "pi conductor config edit",
      "pi conductor config format",
    ],
  },
  {
    name: "completion",
    usage: "pi conductor completion <bash|zsh>",
    summary: "Print shell completion script.",
    description:
      "Emits a completion function for `pi conductor` commands, subcommands, and known options.",
    subcommands: [
      { name: "bash", description: "Print bash completion script." },
      { name: "zsh", description: "Print zsh completion script." },
    ],
    examples: [
      "source <(pi conductor completion bash)",
      "pi conductor completion zsh > ~/.zfunc/_pi_conductor",
    ],
  },
  {
    name: "help",
    usage: "pi conductor help [command]",
    summary: "Show conductor help.",
    description:
      "Use `pi conductor <command> --help` or `pi conductor help <command>` for command detail.",
    examples: ["pi conductor help", "pi conductor run --help"],
  },
];

export function helpText(topic?: string): string {
  if (topic !== undefined) return commandHelp(topic);
  return [
    "Usage: pi conductor <command> [options]",
    "",
    "Pi Conductor watches configured GitHub project items, launches agent worktrees,",
    "routes PR/check/comment feedback, and reconciles durable state after crashes.",
    "",
    "Commands:",
    ...COMMANDS.map((command) => formatCommandSummary(command)),
    "",
    "Global defaults:",
    `  Config: ${getDefaultConfigPath()}`,
    `  State root: ${getDefaultConductorRoot()}`,
    "  pollingIntervalSeconds: 60",
    "  dispatchLabel: ready-for-agent",
    "  branchTemplate: pi/${{ github.issue.number }}-${{ github.issue.slug }}",
    "  branchPrefix: pi",
    "  branchKind: issue",
    "  statusField: Status",
    "  statusOptions: In progress, In review, Done, Blocked",
    "",
    "Webhook events used:",
    `  ${SUPPORTED_WEBHOOK_EVENTS.join(", ")}`,
    "",
    "Daemon files:",
    `  ${getDefaultConductorRoot()}/daemon/conductor.pid`,
    `  ${getDefaultConductorRoot()}/daemon/conductor.log`,
    `  ${getDefaultConductorRoot()}/daemon/conductor.err.log`,
    "",
    "Completion:",
    "  source <(pi conductor completion bash)",
    "  source <(pi conductor completion zsh)",
    "",
    "Detailed help:",
    "  pi conductor help <command>",
    "  pi conductor <command> --help",
    "",
  ].join("\n");
}

export function completionScript(shell: "bash" | "zsh"): string {
  return shell === "bash" ? bashCompletionScript() : zshCompletionScript();
}

function commandHelp(topic: string): string {
  const command = COMMANDS.find((entry) => entry.name === topic);
  if (command === undefined) {
    return [`Unknown conductor help topic: ${topic}`, "", helpText()].join("\n");
  }
  return [
    `Usage: ${command.usage}`,
    "",
    command.summary,
    "",
    command.description,
    ...(command.subcommands === undefined || command.subcommands.length === 0
      ? []
      : ["", "Subcommands:", ...command.subcommands.map(formatSubcommand)]),
    ...(command.options === undefined || command.options.length === 0
      ? ["", "Options: none"]
      : ["", "Options:", ...command.options.map(formatOption)]),
    ...(command.examples === undefined || command.examples.length === 0
      ? []
      : ["", "Examples:", ...command.examples.map((example) => `  ${example}`)]),
    "",
  ].join("\n");
}

function bashCompletionScript(): string {
  return `# bash completion for pi conductor
_pi_conductor_completion() {
  local cur command
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [[ "\${COMP_WORDS[1]}" != "conductor" ]]; then
    return 0
  fi
  if [[ \${COMP_CWORD} -le 2 ]]; then
    COMPREPLY=( $(compgen -W "${commandNames().join(" ")}" -- "$cur") )
    return 0
  fi
  command="\${COMP_WORDS[2]}"
  case "$command" in
    daemon)
      COMPREPLY=( $(compgen -W "start stop restart status --help" -- "$cur") ) ;;
    config)
      COMPREPLY=( $(compgen -W "init validate format edit get set --json --help" -- "$cur") ) ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh --help" -- "$cur") ) ;;
    status|runs)
      COMPREPLY=( $(compgen -W "--json --help" -- "$cur") ) ;;
    run)
      COMPREPLY=( $(compgen -W "${runOptionFlags().join(" ")} --help" -- "$cur") ) ;;
    send)
      COMPREPLY=( $(compgen -W "--follow-up --now --steer --help" -- "$cur") ) ;;
    cleanup)
      COMPREPLY=( $(compgen -W "--merged --gc --older-than-days --vacuum --no-vacuum --help" -- "$cur") ) ;;
    help)
      COMPREPLY=( $(compgen -W "${commandNames().join(" ")}" -- "$cur") ) ;;
    *)
      COMPREPLY=( $(compgen -W "--help" -- "$cur") ) ;;
  esac
}
complete -F _pi_conductor_completion pi
`;
}

function zshCompletionScript(): string {
  return `#compdef pi
# zsh completion for pi conductor
_pi_conductor() {
  local -a commands daemon_actions config_actions completion_actions status_options run_options send_options cleanup_options help_topics
  commands=(${zshItems(COMMANDS.map((command) => [command.name, command.summary]))})
  daemon_actions=(${zshItems([
    ["start", "Start detached conductor serve"],
    ["stop", "Stop daemon"],
    ["restart", "Restart daemon"],
    ["status", "Show daemon state"],
  ])})
  config_actions=(${zshItems([
    ["init", "Create/update config"],
    ["validate", "Validate config"],
    ["format", "Format config"],
    ["edit", "Open editor"],
    ["get", "Read path"],
    ["set", "Set path"],
  ])})
  completion_actions=(${zshItems([
    ["bash", "Print bash completion"],
    ["zsh", "Print zsh completion"],
  ])})
  status_options=(${zshItems([
    ["--json", "Print JSON"],
    ["--help", "Show command help"],
  ])})
  run_options=(${zshItems([...runOptionFlags().map((flag): [string, string] => [flag, "Override run config"]), ["--help", "Show command help"]])})
  send_options=(${zshItems([
    ["--follow-up", "Queue for next turn"],
    ["--now", "Steer now"],
    ["--steer", "Steer now"],
    ["--help", "Show command help"],
  ])})
  cleanup_options=(${zshItems([
    ["--merged", "Clean merged runs"],
    ["--gc", "Prune old state"],
    ["--older-than-days", "Retention days"],
    ["--vacuum", "Vacuum SQLite"],
    ["--no-vacuum", "Skip vacuum"],
    ["--help", "Show command help"],
  ])})
  help_topics=(${zshItems(COMMANDS.map((command) => [command.name, command.summary]))})

  if [[ $words[2] != conductor ]]; then
    return 1
  fi
  if (( CURRENT == 3 )); then
    _describe -t commands 'pi conductor command' commands
    return
  fi
  case "$words[3]" in
    daemon) _describe -t commands 'daemon action' daemon_actions ;;
    config) _describe -t commands 'config action' config_actions ;;
    completion) _describe -t commands 'completion shell' completion_actions ;;
    status|runs) _describe -t options 'status option' status_options ;;
    run) _describe -t options 'run option' run_options ;;
    send) _describe -t options 'send option' send_options ;;
    cleanup) _describe -t options 'cleanup option' cleanup_options ;;
    help) _describe -t commands 'help topic' help_topics ;;
    *) _describe -t options 'option' status_options ;;
  esac
}
compdef _pi_conductor pi
`;
}

function formatCommandSummary(command: CommandHelp): string {
  return `  ${command.name.padEnd(12)} ${command.summary}`;
}

function formatSubcommand(subcommand: { name: string; description: string }): string {
  return `  ${subcommand.name.padEnd(12)} ${subcommand.description}`;
}

function formatOption(option: OptionHelp): string {
  const value = option.value === undefined ? "" : ` ${option.value}`;
  return [
    `  ${`${option.flags}${value}`.padEnd(32)} ${option.description}`,
    `  ${"default".padEnd(32)} ${option.defaultValue}`,
  ].join("\n");
}

function commandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}

function runOptionFlags(): string[] {
  return [
    "--repo-path",
    "--base-ref",
    "--branch-template",
    "--branch-prefix",
    "--branch-kind",
    "--worktree-root",
  ];
}

function zshItems(items: Array<[string, string]>): string {
  return items.map(([name, description]) => `${quoteZsh(name)}:${quoteZsh(description)}`).join(" ");
}

function quoteZsh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function controlDescription(name: string): string {
  if (name === "stop")
    return "Stop Herdr pane, clean local worktree, mark run blocked, and comment on issue.";
  if (name === "pause") return "Pause automated reconciliation/routing for one run.";
  if (name === "resume") return "Resume automated reconciliation/routing for one run.";
  return "Retry a non-done run with recovery context and incremented attempt number.";
}
