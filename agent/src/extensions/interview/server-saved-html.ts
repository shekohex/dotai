import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

import { safeInlineJSON } from "./server-assets.js";
import type { SavedInterviewMeta } from "./server-contract.js";
import { resolveRecommendedLabels } from "./server-request.js";
import type { MediaBlock, Question, QuestionsFile } from "./schema.js";
import type { ChoiceResponseValue, ResponseItem, SavedOptionInsight } from "./types.js";
import { isChoiceResponseValue } from "./responses.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isMarkdownLang(lang: string | undefined): boolean {
  if (lang === undefined) {
    return false;
  }
  const normalized = lang.trim().toLowerCase();
  return normalized === "md" || normalized === "markdown";
}

function renderLightMarkdownHtml(text: string): string {
  return escapeHtml(text)
    .replaceAll(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replaceAll(/`([^`]+)`/g, "<code>$1</code>")
    .replaceAll("\n", "<br>")
    .replaceAll(/\s(\d+\.)\s/g, "<br>$1 ");
}

function renderMarkdownPreviewHtml(markdown: string): string {
  const lines = markdown.replaceAll(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  const paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inFence = false;
  let fenceLang = "";
  let fenceLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderLightMarkdownHtml(paragraph.join(" "))}</p>`);
      paragraph.length = 0;
    }
  };
  const closeList = (): void => {
    if (listType !== null) {
      html.push(listType === "ol" ? "</ol>" : "</ul>");
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    if (inFence) {
      if (line.trim().startsWith("```")) {
        html.push(
          `<pre class="markdown-fence"><code${fenceLang.length > 0 ? ` data-lang="${escapeHtml(fenceLang)}"` : ""}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`,
        );
        inFence = false;
        fenceLang = "";
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    const fenceStart = line.match(/^```\s*([^\s`]*)\s*$/);
    if (fenceStart?.[1] !== undefined) {
      flushParagraph();
      closeList();
      inFence = true;
      fenceLang = fenceStart[1];
      fenceLines = [];
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (headingMatch?.[2] !== undefined) {
      flushParagraph();
      closeList();
      const level = headingMatch[1]?.length ?? 1;
      html.push(`<h${level}>${renderLightMarkdownHtml(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch?.[1] !== undefined) {
      flushParagraph();
      closeList();
      html.push(`<blockquote><p>${renderLightMarkdownHtml(quoteMatch[1])}</p></blockquote>`);
      continue;
    }

    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (orderedMatch?.[1] !== undefined) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderLightMarkdownHtml(orderedMatch[1])}</li>`);
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (unorderedMatch?.[1] !== undefined) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${renderLightMarkdownHtml(unorderedMatch[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (inFence) {
    html.push(
      `<pre class="markdown-fence"><code${fenceLang.length > 0 ? ` data-lang="${escapeHtml(fenceLang)}"` : ""}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`,
    );
  }

  flushParagraph();
  closeList();
  return html.join("\n");
}

function renderContentBlockHtml(content: Question["content"] | undefined): string {
  if (content?.source === undefined) {
    return "";
  }
  const markdownPreview = isMarkdownLang(content.lang) && content.showSource !== true;
  const headerParts: string[] = [];
  if (content.title !== undefined)
    headerParts.push(`<span class="code-block-title">${escapeHtml(content.title)}</span>`);
  if (content.file !== undefined)
    headerParts.push(`<span class="code-block-file">${escapeHtml(content.file)}</span>`);
  if (content.lines !== undefined)
    headerParts.push(`<span class="code-block-lines">L${escapeHtml(content.lines)}</span>`);
  if (content.lang !== undefined && content.lang !== "diff")
    headerParts.push(`<span class="code-block-lang">${escapeHtml(content.lang)}</span>`);
  const headerHtml =
    headerParts.length > 0 ? `<div class="code-block-header">${headerParts.join("")}</div>` : "";
  if (markdownPreview) {
    return `<div class="code-block markdown-content-block">${headerHtml}<div class="markdown-preview">${renderMarkdownPreviewHtml(content.source)}</div></div>`;
  }
  return `<div class="code-block">${headerHtml}<pre class="saved-code"><code>${escapeHtml(content.source)}</code></pre></div>`;
}

function renderMediaCaptionHtml(media: MediaBlock): string {
  return media.caption === undefined
    ? ""
    : `<div class="media-caption">${escapeHtml(media.caption)}</div>`;
}

function renderMediaBlockHtml(media: MediaBlock): string {
  const caption = renderMediaCaptionHtml(media);
  switch (media.type) {
    case "image":
      return `<figure class="media-block media-image"><img src="${escapeHtml(media.src ?? "")}" alt="${escapeHtml(media.alt ?? "")}">${caption}</figure>`;
    case "table": {
      if (media.table === undefined) {
        return "";
      }
      const highlights = new Set(media.table.highlights ?? []);
      const headers = media.table.headers
        .map((header) => `<th>${escapeHtml(header)}</th>`)
        .join("");
      const rows = media.table.rows
        .map((row, index) => {
          const rowClass = highlights.has(index) ? ' class="highlighted-row"' : "";
          const cells = row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("");
          return `<tr${rowClass}>${cells}</tr>`;
        })
        .join("\n");
      return `<div class="media-block media-table"><div class="media-table-scroll"><table class="data-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>${caption}</div>`;
    }
    case "mermaid":
      return `<div class="media-block media-mermaid"><pre class="mermaid">${escapeHtml(media.mermaid ?? "")}</pre>${caption}</div>`;
    case "chart":
      return `<div class="media-block media-chart"><div class="media-chart-static">[Chart: ${escapeHtml(media.chart?.type ?? "unknown")}]</div>${caption}</div>`;
    case "html":
      return `<div class="media-block media-html">${media.html ?? ""}${caption}</div>`;
  }

  return "";
}

function renderMediaListHtml(media: MediaBlock | MediaBlock[] | undefined): string {
  if (media === undefined) {
    return "";
  }
  return (Array.isArray(media) ? media : [media])
    .map((item) => renderMediaBlockHtml(item))
    .join("\n");
}

function recommendedIndicatorHtml(question: Question): string {
  return question.recommended === undefined
    ? ""
    : '<span class="recommended-pill">Recommended</span>';
}

function savedAnswerItemHtml(text: string, question: Question): string {
  const recommendations = question.options
    ? resolveRecommendedLabels(question.recommended, question.options)
    : [];
  return (
    escapeHtml(text) +
    (recommendations.includes(text) ? ` ${recommendedIndicatorHtml(question)}` : "")
  );
}

function savedChoiceAnswerHtml(value: ChoiceResponseValue, question: Question): string {
  const noteHtml =
    value.note === undefined
      ? ""
      : `<div class="saved-answer-note">${escapeHtml(value.note)}</div>`;
  return `<div class="saved-answer-choice">${savedAnswerItemHtml(value.option, question)}${noteHtml}</div>`;
}

function weightClasses(question: Question): string {
  const classes = ["saved-question"];
  if (question.type === "info") classes.push("info-panel");
  if (question.weight === "critical") classes.push("weight-critical");
  if (question.weight === "minor") classes.push("weight-minor");
  return classes.join(" ");
}

export async function copyMediaImages(
  questionsList: Question[],
  imagesDir: string,
  cwd: string,
): Promise<Question[]> {
  const toCopy: Array<{ src: string; dest: string }> = [];
  const rewritten = questionsList.map((question) => {
    if (question.media === undefined) {
      return question;
    }
    const mediaList = Array.isArray(question.media) ? question.media : [question.media];
    let changed = false;
    const nextMedia = mediaList.map((media) => {
      if (media.type !== "image" || media.src === undefined) {
        return media;
      }
      if (
        media.src.startsWith("http://") ||
        media.src.startsWith("https://") ||
        media.src.startsWith("data:")
      ) {
        return media;
      }
      let resolvedPath: string;
      if (media.src.startsWith("~")) {
        resolvedPath = join(homedir(), media.src.slice(1));
      } else if (media.src.startsWith("/")) {
        resolvedPath = media.src;
      } else {
        resolvedPath = join(cwd, media.src);
      }
      resolvedPath = resolve(resolvedPath);
      if (!existsSync(resolvedPath)) {
        return media;
      }
      changed = true;
      const filename = basename(resolvedPath);
      toCopy.push({ src: resolvedPath, dest: join(imagesDir, filename) });
      return { ...media, src: `images/${filename}` };
    });
    if (!changed) {
      return question;
    }
    return { ...question, media: Array.isArray(question.media) ? nextMedia : nextMedia[0] };
  });
  if (toCopy.length > 0) {
    await mkdir(imagesDir, { recursive: true });
    await Promise.all(toCopy.map((file) => copyFile(file.src, file.dest)));
  }
  return rewritten;
}

function renderSavedOptionInsightsHtml(insights: SavedOptionInsight[]): string {
  if (insights.length === 0) {
    return "";
  }
  return `<div class="saved-option-insights">${insights
    .map((insight) => {
      const bullets = insight.bullets ?? [];
      const bulletsHtml =
        bullets.length > 0
          ? `<ul>${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
          : "";
      const suggestionHtml =
        insight.suggestedText === undefined
          ? ""
          : `<div class="saved-option-insight-suggestion"><span>Suggested rewrite</span><code>${escapeHtml(insight.suggestedText)}</code></div>`;
      const metaParts = [
        insight.optionText.length > 0 ? `Option: ${escapeHtml(insight.optionText)}` : "",
        insight.modelUsed !== undefined &&
        insight.modelUsed !== null &&
        insight.modelUsed.length > 0
          ? `Model: ${escapeHtml(insight.modelUsed)}`
          : "",
      ].filter((part) => part.length > 0);
      return `<article class="saved-option-insight"><div class="saved-option-insight-prompt">${escapeHtml(insight.prompt)}</div>${metaParts.length > 0 ? `<div class="saved-option-insight-meta">${metaParts.join(" · ")}</div>` : ""}<p>${escapeHtml(insight.summary)}</p>${bulletsHtml}${suggestionHtml}</article>`;
    })
    .join("")}</div>`;
}

function renderOptionalQuestionContext(context: string | undefined): string {
  return context === undefined ? "" : `<p class="question-context">${escapeHtml(context)}</p>`;
}

function renderOptionalBranch(branch: string | null): string {
  return branch === null ? "" : `<span>Branch: ${escapeHtml(branch)}</span>`;
}

function renderQuestionsHtml(
  questionsList: Question[],
  answers: ResponseItem[],
  optionInsights: SavedOptionInsight[],
): string {
  const answerMap = new Map(answers.map((answer) => [answer.id, answer]));
  let questionNumber = 0;
  return questionsList
    .map((question) => {
      if (question.type !== "info") {
        questionNumber += 1;
      }
      const mediaHtml = renderMediaListHtml(question.media);
      const contentHtml = renderContentBlockHtml(question.content);
      const optionInsightsHtml = renderSavedOptionInsightsHtml(
        optionInsights.filter((insight) => insight.questionId === question.id),
      );
      if (question.type === "info") {
        return `<div class="${weightClasses(question)}"><h2>${escapeHtml(question.question)}</h2>${renderOptionalQuestionContext(question.context)}${contentHtml}${mediaHtml}${optionInsightsHtml}</div>`;
      }

      const answer = answerMap.get(question.id);
      const attachments = answer?.attachments ?? [];
      let answerHtml = '<div class="saved-answer empty">(no answer)</div>';
      if (answer !== undefined) {
        if (question.type === "image") {
          let paths: string[] = [];
          if (Array.isArray(answer.value)) {
            paths = answer.value.filter((item): item is string => typeof item === "string");
          } else if (typeof answer.value === "string") {
            paths = [answer.value];
          }
          answerHtml =
            paths.length === 0
              ? answerHtml
              : `<div class="saved-images">${paths.map((filePath) => `<img src="${escapeHtml(filePath)}" alt="uploaded image">`).join("")}</div>`;
        } else if (question.type === "multi") {
          const items = Array.isArray(answer.value)
            ? answer.value.filter((item) => isChoiceResponseValue(item))
            : [];
          answerHtml =
            items.length === 0
              ? answerHtml
              : `<div class="saved-answer"><ul>${items.map((item) => `<li>${savedChoiceAnswerHtml(item, question)}</li>`).join("")}</ul></div>`;
        } else if (question.type === "single") {
          answerHtml = isChoiceResponseValue(answer.value)
            ? `<div class="saved-answer">${savedChoiceAnswerHtml(answer.value, question)}</div>`
            : answerHtml;
        } else if (typeof answer.value === "string" && answer.value.length > 0) {
          answerHtml = `<div class="saved-answer">${savedAnswerItemHtml(answer.value, question)}</div>`;
        }
      }

      const attachmentHtml =
        attachments.length > 0
          ? `<div class="saved-attachments">${attachments.map((filePath) => `<img src="${escapeHtml(filePath)}" alt="attachment">`).join("")}</div>`
          : "";
      return `<div class="${weightClasses(question)}"><h2>${questionNumber}. ${escapeHtml(question.question)}</h2>${renderOptionalQuestionContext(question.context)}${contentHtml}${mediaHtml}${optionInsightsHtml}${answerHtml}${attachmentHtml}</div>`;
    })
    .join("\n");
}

const SAVED_VIEW_STYLES = `
.saved-interview { max-width: 680px; margin: 0 auto; padding: var(--spacing); }
.saved-header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border-muted); }
.saved-header h1 { margin: 0 0 8px; font-size: 20px; }
.saved-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px; color: var(--fg-muted); }
.saved-status { padding: 2px 8px; border-radius: var(--radius); background: var(--bg-elevated); }
.saved-status.submitted { color: var(--success); border: 1px solid var(--success); }
.saved-status.draft { color: var(--warning); border: 1px solid var(--warning); }
.saved-question { margin-bottom: 20px; padding: 16px; background: var(--bg-elevated); border: 1px solid var(--border-muted); border-radius: var(--radius); }
.saved-question h2 { margin: 0 0 12px; font-size: 14px; font-weight: 500; }
.saved-code { margin: 12px 0; padding: 12px; background: var(--bg-body); border-radius: var(--radius); overflow-x: hidden; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.saved-answer { color: var(--fg); padding: 8px 12px; background: var(--bg-body); border-radius: var(--radius); white-space: pre-wrap; }
.saved-option-insights { display: grid; gap: 10px; margin: 14px 0; }
.saved-option-insight { border: 1px solid var(--border-muted); border-radius: 12px; padding: 12px; background: color-mix(in srgb, var(--bg-body) 82%, transparent); }
.saved-option-insight-prompt { font-family: var(--font-mono); font-size: 11px; color: var(--accent); margin-bottom: 4px; }
.saved-option-insight-meta { font-size: 11px; color: var(--fg-muted); margin-bottom: 8px; }
.saved-option-insight p { margin: 0; }
.saved-option-insight ul { margin: 8px 0 0; padding-left: 18px; }
.saved-option-insight-suggestion { margin-top: 10px; display: grid; gap: 4px; }
.saved-option-insight-suggestion span { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-muted); }
.saved-option-insight-suggestion code { display: block; padding: 8px 10px; border-radius: 8px; background: var(--bg-body); font-family: var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.saved-answer.empty { color: var(--fg-dim); font-style: italic; }
.saved-answer ul { margin: 0; padding-left: 20px; }
.saved-answer-choice { display: grid; gap: 4px; }
.saved-answer-note { color: var(--fg-muted); font-size: 12px; }
.saved-images, .saved-attachments { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.saved-images img, .saved-attachments img { max-width: 200px; max-height: 150px; border-radius: var(--radius); border: 1px solid var(--border-muted); }
.saved-question.info-panel h2 { color: var(--fg-muted); }
.saved-question.weight-critical { border-left: 5px solid var(--accent); background: color-mix(in srgb, var(--accent) 4%, var(--bg-elevated)); }
.saved-question.weight-minor { padding: 12px; }
.saved-question.weight-minor h2 { font-size: 13px; }
.recommended-pill { display: inline-flex; align-items: center; padding: 1px 6px; margin-left: 6px; border-radius: 8px; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
`;

export function generateSavedHtml(options: {
  questions: QuestionsFile;
  answers: ResponseItem[];
  optionInsights: SavedOptionInsight[];
  optionKeysByQuestion: Record<string, string[]>;
  meta: SavedInterviewMeta;
  baseStyles: string;
  themeCss: string;
}): string {
  const title = options.questions.title ?? "Interview";
  const embeddedJson = safeInlineJSON({
    title: options.questions.title,
    description: options.questions.description,
    questions: options.questions.questions,
    savedAnswers: options.answers,
    savedOptionInsights: options.optionInsights,
    optionKeysByQuestion: options.optionKeysByQuestion,
    savedAt: options.meta.savedAt,
    wasSubmitted: options.meta.wasSubmitted,
    savedFrom: options.meta.savedFrom,
  });
  const questionsHtml = renderQuestionsHtml(
    options.questions.questions,
    options.answers,
    options.optionInsights,
  );
  const savedDate = new Date(options.meta.savedAt).toLocaleString();
  const statusClass = options.meta.wasSubmitted ? "submitted" : "draft";
  const statusText = options.meta.wasSubmitted ? "Submitted" : "Draft";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Saved Interview</title>
  <style>
${options.baseStyles}
${options.themeCss}
${SAVED_VIEW_STYLES}
  </style>
</head>
<body>
  <main class="saved-interview">
    <header class="saved-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="saved-meta">
        <span>Saved: ${escapeHtml(savedDate)}</span>
        <span>Project: ${escapeHtml(options.meta.savedFrom.cwd)}</span>
        ${renderOptionalBranch(options.meta.savedFrom.branch)}
        <span class="saved-status ${statusClass}">${statusText}</span>
      </div>
    </header>
    <div class="saved-questions">
${questionsHtml}
    </div>
  </main>
  <script type="application/json" id="pi-interview-data">
${embeddedJson}
  </script>
</body>
</html>`;
}
