import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  getReferenceConfigPath,
  validateReferenceAlias,
  type ReferenceConfigScope,
  type ReferenceEntryInput,
} from "./config.js";
import { parseRepositoryReference, validateRepositoryBranch } from "./repository.js";
import type { ResolvedReference } from "./runtime.js";

type ReferenceKindChoice = "local" | "git";
type VisibilityChoice = "visible" | "hidden";
type BooleanChoice = "yes" | "no";

export type ReferenceWizardResult = {
  alias: string;
  sourceFile: string;
  entry: ReferenceEntryInput;
  refreshNow: boolean;
};

type ReferenceWizardInitial = {
  cwd: string;
  existing?: ResolvedReference;
  existingAliases: string[];
};

type ReferenceWizardDraft = {
  scope: ReferenceConfigScope;
  alias: string;
  kind: ReferenceKindChoice;
  sourceValue: string;
  branch: string;
  description: string;
  visibility: VisibilityChoice;
  refreshNow: BooleanChoice;
};

type WizardStepId =
  | "scope"
  | "alias"
  | "kind"
  | "source"
  | "branch"
  | "description"
  | "visibility"
  | "refresh";

type WizardStep = {
  id: WizardStepId;
  title: string;
  help: string;
};

const LOCAL_STEPS: WizardStep[] = [
  { id: "scope", title: "Scope", help: "Choose where reference is saved." },
  { id: "alias", title: "Alias", help: "Reference name used as @alias." },
  { id: "kind", title: "Type", help: "Choose local directory or git repository." },
  {
    id: "source",
    title: "Path",
    help: "Directory path. Relative paths resolve from references.json.",
  },
  { id: "description", title: "Description", help: "Optional guidance shown to agents." },
  { id: "visibility", title: "Autocomplete", help: "Hidden refs stay in context if described." },
  { id: "refresh", title: "Refresh", help: "Validate path now after saving." },
];

const GIT_STEPS: WizardStep[] = [
  { id: "scope", title: "Scope", help: "Choose where reference is saved." },
  { id: "alias", title: "Alias", help: "Reference name used as @alias." },
  { id: "kind", title: "Type", help: "Choose local directory or git repository." },
  {
    id: "source",
    title: "Repository",
    help: "owner/repo, host/path, Git URL, or github:owner/repo.",
  },
  { id: "branch", title: "Branch", help: "Optional branch/ref. Leave empty for default branch." },
  { id: "description", title: "Description", help: "Optional guidance shown to agents." },
  { id: "visibility", title: "Autocomplete", help: "Hidden refs stay in context if described." },
  { id: "refresh", title: "Refresh", help: "Clone or update repo after saving." },
];

function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : "";
}

function fitLine(content: string, width: number): string {
  const trimmed = truncateToWidth(content, width, "…");
  const pad = Math.max(0, width - visibleWidth(trimmed));
  return `${trimmed}${repeat(" ", pad)}`;
}

function scopeFromSourceFile(cwd: string, sourceFile: string): ReferenceConfigScope {
  return sourceFile === getReferenceConfigPath(cwd, "project") ? "project" : "global";
}

function buildInitialDraft(input: ReferenceWizardInitial): ReferenceWizardDraft {
  const existing = input.existing;
  return {
    scope: existing === undefined ? "project" : scopeFromSourceFile(input.cwd, existing.sourceFile),
    alias: existing?.alias ?? "",
    kind: existing?.kind ?? "local",
    sourceValue: existing?.kind === "git" ? (existing.repository ?? "") : (existing?.path ?? ""),
    branch: existing?.branch ?? "",
    description: existing?.description ?? "",
    visibility: existing?.hidden === true ? "hidden" : "visible",
    refreshNow: existing?.kind === "git" ? "no" : "yes",
  };
}

function stepsForKind(kind: ReferenceKindChoice): WizardStep[] {
  return kind === "git" ? GIT_STEPS : LOCAL_STEPS;
}

function isInputStep(id: WizardStepId): boolean {
  return id === "alias" || id === "source" || id === "branch" || id === "description";
}

function inputValueForStep(draft: ReferenceWizardDraft, stepId: WizardStepId): string {
  if (stepId === "alias") return draft.alias;
  if (stepId === "source") return draft.sourceValue;
  if (stepId === "branch") return draft.branch;
  if (stepId === "description") return draft.description;
  return "";
}

function setInputValueForStep(
  draft: ReferenceWizardDraft,
  stepId: WizardStepId,
  value: string,
): void {
  if (stepId === "alias") draft.alias = value;
  if (stepId === "source") draft.sourceValue = value;
  if (stepId === "branch") draft.branch = value;
  if (stepId === "description") draft.description = value;
}

function cycleChoice<T extends string>(value: T, choices: T[], delta: number): T {
  const index = choices.indexOf(value);
  const next = index < 0 ? 0 : (index + delta + choices.length) % choices.length;
  return choices[next] ?? choices[0];
}

function compactEntry(draft: ReferenceWizardDraft): ReferenceEntryInput {
  const description = draft.description.trim();
  const hidden = draft.visibility === "hidden";
  if (draft.kind === "local") {
    return {
      path: draft.sourceValue.trim(),
      ...(description.length === 0 ? {} : { description }),
      ...(hidden ? { hidden: true } : {}),
    };
  }
  const branch = draft.branch.trim();
  return {
    repository: draft.sourceValue.trim(),
    ...(branch.length === 0 ? {} : { branch }),
    ...(description.length === 0 ? {} : { description }),
    ...(hidden ? { hidden: true } : {}),
  };
}

function validateDraftStep(
  draft: ReferenceWizardDraft,
  stepId: WizardStepId,
  existing: ResolvedReference | undefined,
  existingAliases: string[],
): string | undefined {
  if (stepId === "alias") {
    const alias = draft.alias.trim();
    const aliasError = validateReferenceAlias(alias);
    if (aliasError !== undefined) return aliasError;
    const aliasChanged = existing === undefined || alias !== existing.alias;
    if (aliasChanged && existingAliases.includes(alias)) {
      return `Reference @${alias} already exists. Edit existing reference instead.`;
    }
  }

  if (stepId === "source" && draft.kind === "local" && draft.sourceValue.trim().length === 0) {
    return "Local directory path required. Example: ../docs or ~/docs.";
  }

  if (stepId === "source" && draft.kind === "git") {
    const repository = draft.sourceValue.trim();
    if (repository.length === 0) {
      return "Repository required. Example: owner/repo or https://github.com/owner/repo.";
    }
    if (parseRepositoryReference(repository) === null) {
      return "Repository must be a git URL, host/path reference, or GitHub owner/repo shorthand.";
    }
  }

  if (stepId === "branch" && draft.branch.trim().length > 0) {
    return validateRepositoryBranch(draft.branch.trim());
  }

  return undefined;
}

class ReferenceWizard implements Component {
  private readonly input = new Input();
  private readonly draft: ReferenceWizardDraft;
  private stepIndex = 0;
  private errorMessage = "";

  constructor(
    private readonly theme: Theme,
    private readonly options: ReferenceWizardInitial,
    private readonly done: (result?: ReferenceWizardResult) => void,
  ) {
    this.draft = buildInitialDraft(options);
    this.input.focused = true;
    this.syncInputFromStep();
  }

  handleInput(data: string): void {
    this.errorMessage = "";
    if (matchesKey(data, Key.escape)) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.ctrl("p")) || matchesKey(data, Key.shift("tab"))) {
      this.previousStep();
      return;
    }
    if (
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.ctrl("n"))
    ) {
      this.nextStep();
      return;
    }

    const step = this.currentStep();
    if (isInputStep(step.id)) {
      this.input.handleInput(data);
      setInputValueForStep(this.draft, step.id, this.input.getValue());
      return;
    }

    if (matchesKey(data, Key.left) || data === "h") {
      this.cycleCurrentChoice(-1);
      return;
    }
    if (matchesKey(data, Key.right) || data === "l" || data === " ") {
      this.cycleCurrentChoice(1);
    }
  }

  render(width: number): string[] {
    const dialogWidth = Math.max(60, width);
    const innerWidth = dialogWidth - 2;
    const border = this.theme.fg("border", "│");
    const top = this.theme.fg("borderAccent", `╭${repeat("─", innerWidth)}╮`);
    const bottom = this.theme.fg("borderAccent", `╰${repeat("─", innerWidth)}╯`);
    const step = this.currentStep();
    const body = [
      top,
      this.frame(
        this.theme.fg("accent", this.theme.bold(" Reference wizard ")),
        innerWidth,
        border,
      ),
      this.frame(this.renderProgress(innerWidth), innerWidth, border),
      this.frame("", innerWidth, border),
      this.frame(this.theme.bold(step.title), innerWidth, border),
      this.frame(this.theme.fg("muted", step.help), innerWidth, border),
      this.frame("", innerWidth, border),
      ...this.renderStepInput(step, innerWidth, border),
      this.frame("", innerWidth, border),
      ...this.renderSummary(innerWidth, border),
      ...(this.errorMessage.length === 0
        ? []
        : [this.frame(this.theme.fg("error", this.errorMessage), innerWidth, border)]),
      this.frame("", innerWidth, border),
      this.frame(
        this.theme.fg("dim", "tab/enter next • ctrl+p back • ←/→ toggle • esc cancel"),
        innerWidth,
        border,
      ),
      bottom,
    ];
    return body;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private frame(content: string, innerWidth: number, border: string): string {
    return `${border}${fitLine(content, innerWidth)}${border}`;
  }

  private currentSteps(): WizardStep[] {
    return stepsForKind(this.draft.kind);
  }

  private currentStep(): WizardStep {
    return this.currentSteps()[this.stepIndex] ?? this.currentSteps()[0];
  }

  private previousStep(): void {
    this.stepIndex = Math.max(0, this.stepIndex - 1);
    this.syncInputFromStep();
  }

  private nextStep(): void {
    const step = this.currentStep();
    const error = validateDraftStep(
      this.draft,
      step.id,
      this.options.existing,
      this.options.existingAliases,
    );
    if (error !== undefined) {
      this.errorMessage = error;
      return;
    }
    if (this.stepIndex >= this.currentSteps().length - 1) {
      this.submit();
      return;
    }
    this.stepIndex += 1;
    this.syncInputFromStep();
  }

  private submit(): void {
    for (const step of this.currentSteps()) {
      const error = validateDraftStep(
        this.draft,
        step.id,
        this.options.existing,
        this.options.existingAliases,
      );
      if (error !== undefined) {
        this.stepIndex = this.currentSteps().findIndex((candidate) => candidate.id === step.id);
        this.errorMessage = error;
        this.syncInputFromStep();
        return;
      }
    }

    this.done({
      alias: this.draft.alias.trim(),
      sourceFile: getReferenceConfigPath(this.options.cwd, this.draft.scope),
      entry: compactEntry(this.draft),
      refreshNow: this.draft.refreshNow === "yes",
    });
  }

  private syncInputFromStep(): void {
    const step = this.currentStep();
    if (isInputStep(step.id)) {
      this.input.setValue(inputValueForStep(this.draft, step.id));
    }
  }

  private cycleCurrentChoice(delta: number): void {
    const step = this.currentStep();
    if (step.id === "scope") {
      this.draft.scope = cycleChoice(this.draft.scope, ["project", "global"], delta);
    }
    if (step.id === "kind") {
      this.draft.kind = cycleChoice(this.draft.kind, ["local", "git"], delta);
      this.stepIndex = Math.min(this.stepIndex, this.currentSteps().length - 1);
    }
    if (step.id === "visibility") {
      this.draft.visibility = cycleChoice(this.draft.visibility, ["visible", "hidden"], delta);
    }
    if (step.id === "refresh") {
      this.draft.refreshNow = cycleChoice(this.draft.refreshNow, ["yes", "no"], delta);
    }
  }

  private renderProgress(innerWidth: number): string {
    const steps = this.currentSteps();
    const currentStep = this.currentStep();
    const tabs = steps.map((step, index) => {
      const label = `${index + 1}.${step.title}`;
      if (step.id === currentStep.id) {
        return this.theme.fg("accent", this.theme.bold(`[${label}]`));
      }
      return this.theme.fg("dim", label);
    });
    return truncateToWidth(tabs.join(" "), innerWidth, "…");
  }

  private renderStepInput(step: WizardStep, innerWidth: number, border: string): string[] {
    if (isInputStep(step.id)) {
      return this.input
        .render(Math.max(10, innerWidth - 2))
        .map((line) => this.frame(line, innerWidth, border));
    }
    const value = this.choiceValue(step.id);
    const choices = this.choiceValues(step.id).map((choice) =>
      choice === value
        ? this.theme.fg("accent", this.theme.bold(`[${choice}]`))
        : this.theme.fg("dim", ` ${choice} `),
    );
    return [this.frame(choices.join("  "), innerWidth, border)];
  }

  private choiceValue(stepId: WizardStepId): string {
    if (stepId === "scope") return this.draft.scope;
    if (stepId === "kind") return this.draft.kind;
    if (stepId === "visibility") return this.draft.visibility;
    if (stepId === "refresh") return this.draft.refreshNow;
    return "";
  }

  private choiceValues(stepId: WizardStepId): string[] {
    if (stepId === "scope") return ["project", "global"];
    if (stepId === "kind") return ["local", "git"];
    if (stepId === "visibility") return ["visible", "hidden"];
    if (stepId === "refresh") return ["yes", "no"];
    return [];
  }

  private renderSummary(innerWidth: number, border: string): string[] {
    const sourceLabel = this.draft.kind === "git" ? "repo" : "path";
    const lines = [
      `${this.theme.fg("muted", "scope")} ${this.draft.scope}`,
      `${this.theme.fg("muted", "alias")} @${this.draft.alias.trim() || "(required)"}`,
      `${this.theme.fg("muted", "type ")} ${this.draft.kind}`,
      `${this.theme.fg("muted", sourceLabel)} ${this.draft.sourceValue.trim() || "(required)"}`,
      ...(this.draft.kind === "git"
        ? [`${this.theme.fg("muted", "branch")} ${this.draft.branch.trim() || "default"}`]
        : []),
      `${this.theme.fg("muted", "desc ")} ${this.draft.description.trim() || "(none)"}`,
      `${this.theme.fg("muted", "auto ")} ${this.draft.visibility}`,
      `${this.theme.fg("muted", "refresh")} ${this.draft.refreshNow}`,
    ];
    return lines.map((line) => this.frame(line, innerWidth, border));
  }
}

export async function showReferenceWizard(
  ctx: ExtensionCommandContext,
  input: ReferenceWizardInitial,
): Promise<ReferenceWizardResult | undefined> {
  const result = await ctx.ui.custom<ReferenceWizardResult | undefined>(
    (_tui, theme, _keybindings, done) => new ReferenceWizard(theme, input, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "92%",
        maxHeight: "90%",
        margin: 1,
      },
    },
  );
  return result;
}
