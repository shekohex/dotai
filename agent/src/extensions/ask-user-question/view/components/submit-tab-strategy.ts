import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { uiText } from "../../state/labels.js";
import { formatAnswerScalar } from "../../tool/format-answer.js";
import type { QuestionData } from "../../tool/types.js";
import type { DialogState } from "../dialog-builder.js";
import type { TabContentStrategy } from "../tab-content-strategy.js";
import { INCOMPLETE_WARNING_PREFIX, READY_PROMPT, REVIEW_HEADING } from "../dialog-builder.js";

export interface SubmitTabStrategyConfig {
  theme: Theme;
  questions: readonly QuestionData[];
  submitPicker: Component | undefined;
}

export class SubmitTabStrategy implements TabContentStrategy {
  /**
   * Spacer(1) + Text(prompt, 1) + Spacer(1) + submitPicker(2) = 5 rendered rows. Fallback path
   * lands at 5 via 2 trailing Spacer(1)s.
   */
  readonly footerRowCount = 5;

  constructor(private readonly config: SubmitTabStrategyConfig) {}

  headingRows(_state: DialogState): Component[] {
    return [
      new Text(
        this.config.theme.bold(
          this.config.theme.fg("accent", uiText("review.heading", REVIEW_HEADING)),
        ),
        1,
        0,
      ),
      new Spacer(1),
    ];
  }

  bodyComponent(state: DialogState): Component {
    const c = new Container();
    for (let i = 0; i < this.config.questions.length; i++) {
      const q = this.config.questions[i];
      const a = state.answers.get(i);
      if (a === undefined) continue;
      const hasHeader = q.header !== undefined && q.header.length > 0;
      const label = hasHeader ? q.header : `Q${i + 1}`;
      const answerText = formatAnswerScalar(a, "summary");
      c.addChild(new Text(this.config.theme.fg("muted", ` ● ${label}`), 1, 0));
      c.addChild(
        new Text(
          `   ${this.config.theme.fg("muted", "→")} ${this.config.theme.fg("text", answerText)}`,
          1,
          0,
        ),
      );
      if (a.notes !== undefined && a.notes.length > 0) {
        c.addChild(new Text(this.config.theme.fg("dim", `     notes: ${a.notes}`), 1, 0));
      }
    }
    return c;
  }

  bodyHeight(width: number, state: DialogState): number {
    return this.bodyComponent(state).render(width).length;
  }

  midRows(_state: DialogState): Component[] {
    return [];
  }

  footerRows(state: DialogState): Component[] {
    const missing: string[] = [];
    for (let i = 0; i < this.config.questions.length; i++) {
      const q = this.config.questions[i];
      if (!state.answers.has(i)) {
        const hasHeader = q.header !== undefined && q.header.length > 0;
        missing.push(hasHeader ? q.header : `Q${i + 1}`);
      }
    }
    const promptText =
      missing.length === 0
        ? this.config.theme.fg("muted", uiText("review.ready", READY_PROMPT))
        : this.config.theme.fg(
            "warning",
            `${uiText("review.incomplete", INCOMPLETE_WARNING_PREFIX)} ${missing.join(", ")}`,
          );
    const out: Component[] = [new Spacer(1), new Text(promptText, 1, 0), new Spacer(1)];
    if (this.config.submitPicker) {
      out.push(this.config.submitPicker);
    } else {
      // Padding when the picker isn't wired — keeps rendered row count at footerRowCount=5.
      out.push(new Spacer(1));
      out.push(new Spacer(1));
    }
    return out;
  }

  focusedItemRowRange(_width: number, _state: DialogState): [number, number] | undefined {
    return undefined;
  }
}
