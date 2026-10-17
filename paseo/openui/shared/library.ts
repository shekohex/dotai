import { action, createLibrary, defineComponent, defineFunction, markReactive } from "./lang-core/index.mjs";
import { z } from "zod";
import { rowsOnDates } from "./calendar";

/**
 * The component contract shared by the daemon (validation and the agent guide) and the app
 * (rendering). Components carry no renderer here; the app maps names to React Native views.
 * Props are positional in the order written: required first, optional after.
 */

const TONES = ["default", "muted", "accent", "success", "warning", "danger"] as const;
const toneSchema = z.enum(TONES);
/** Optional Lucide icon name (PascalCase: Rocket, GitBranch, Bug, TriangleAlert). Unknown names draw nothing. */
const iconName = z.string().optional();
const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Marks a prop that a `$variable` can bind two ways. */
function reactive<T extends z.ZodType>(schema: T): T {
  markReactive(schema);
  return schema;
}

function define<T extends z.ZodObject>(name: string, description: string, props: T) {
  return defineComponent({ name, description, props, component: null });
}

// ── Layout ──────────────────────────────────────────────────────────────────

const Stack = define(
  "Stack",
  "Lays children out in a row or column. The root of every program.",
  z.object({
    children: z.array(z.any()),
    direction: z.enum(["row", "column"]).optional(),
    gap: z.enum(["none", "xs", "s", "m", "l"]).optional(),
    align: z.enum(["start", "center", "end", "stretch"]).optional(),
    wrap: z.boolean().optional(),
  }),
);

const Grid = define(
  "Grid",
  "Equal-width columns; at most 2 columns on narrow screens. Use for Metric tiles and Cards.",
  z.object({ children: z.array(z.any()), columns: z.number().optional() }),
);

const Card = define(
  "Card",
  "Bordered surface that groups related content under an optional title.",
  z.object({
    children: z.array(z.any()),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    tone: z.enum(["default", "accent", "success", "warning", "danger"]).optional(),
    icon: iconName,
  }),
);

const Tab = define(
  "Tab",
  "One tab of Tabs: a label and its content.",
  z.object({ label: z.string(), children: z.array(z.any()), icon: iconName }),
);

const Tabs = define(
  "Tabs",
  "Switch between alternative views of the same subject.",
  z.object({ items: z.array(Tab.ref) }),
);

const Panel = define(
  "Panel",
  "One collapsible section of Accordion.",
  z.object({ title: z.string(), children: z.array(z.any()), open: z.boolean().optional(), icon: iconName }),
);

const Accordion = define(
  "Accordion",
  "Collapsible sections; use to keep long detail out of the way.",
  z.object({ items: z.array(Panel.ref) }),
);

const Dialog = define(
  "Dialog",
  "A modal window that opens over the chat while its bound $variable is true: details, confirmations, forms. Open it with a Button whose action is @Set($open, true); the window's own close control sets it back to false.",
  z.object({
    title: z.string(),
    children: z.array(z.any()),
    description: z.string().optional(),
    open: reactive(z.boolean().optional()),
  }),
);

const Popover = define(
  "Popover",
  "A button that unfolds a panel of extra content right below it and folds it again on the next tap. Local to the UI: no variable needed.",
  z.object({ label: z.string(), children: z.array(z.any()), icon: iconName }),
);

const Tooltip = define(
  "Tooltip",
  "Wraps one component and shows a short hint on hover (desktop) or tap (touch). Use for explaining a badge, icon or metric.",
  z.object({ text: z.string(), child: z.any() }),
);

const Separator = define("Separator", "A thin horizontal rule.", z.object({}));

// ── Text and code ───────────────────────────────────────────────────────────

const Heading = define(
  "Heading",
  "Section title. level 1 is largest (default 2).",
  z.object({ text: z.string(), level: z.number().optional(), icon: iconName }),
);

const Text = define(
  "Text",
  "Plain text. For several paragraphs, lists or inline formatting use Markdown.",
  z.object({
    text: z.string(),
    tone: toneSchema.optional(),
    size: z.enum(["s", "m", "l"]).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    mono: z.boolean().optional(),
  }),
);

const Markdown = define(
  "Markdown",
  "Rich text: headings, lists, tables, quotes, **bold**, *italic*, `code`, [links](https://x.y), fenced code.",
  z.object({ text: z.string() }),
);

const CodeBlock = define(
  "CodeBlock",
  "Monospace code with a copy button. Not syntax highlighted.",
  z.object({ code: z.string(), language: z.string().optional(), title: z.string().optional() }),
);

const Diff = define(
  "Diff",
  "A unified diff (lines starting with + - @@) with added and removed lines colored.",
  z.object({ patch: z.string(), title: z.string().optional() }),
);

const Callout = define(
  "Callout",
  "Highlighted note: info, success, warning or danger.",
  z.object({
    text: z.string(),
    variant: z.enum(["info", "success", "warning", "danger"]).optional(),
    title: z.string().optional(),
    icon: iconName,
  }),
);

const Badge = define(
  "Badge",
  "Small status label.",
  z.object({ label: z.string(), tone: toneSchema.optional(), icon: iconName }),
);

const Icon = define(
  "Icon",
  "A Lucide icon by PascalCase name, such as Check, GitBranch, Bug, FileText, Rocket. animation loops it: spin (Loader), pulse (live, recording) or bounce (attention).",
  z.object({
    name: z.string(),
    tone: toneSchema.optional(),
    size: z.number().optional(),
    animation: z.enum(["spin", "pulse", "bounce"]).optional(),
  }),
);

const Link = define(
  "Link",
  "Tappable link that opens an https URL in the browser.",
  z.object({ label: z.string(), url: z.string() }),
);

const FileRef = define(
  "FileRef",
  "A file path chip, optionally with a line number. Tapping copies the path.",
  z.object({ path: z.string(), line: z.number().optional() }),
);

// ── Data ────────────────────────────────────────────────────────────────────

const Table = define(
  "Table",
  "Rows and columns. Each row is an array of cells in header order.",
  z.object({
    headers: z.array(z.string()),
    rows: z.array(z.array(scalar)),
    caption: z.string().optional(),
  }),
);

const DataTable = define(
  "DataTable",
  "A Table the user can work with: tap a header to sort, search across all cells, and page through long data. Prefer it over Table for more than about 8 rows.",
  z.object({
    headers: z.array(z.string()),
    rows: z.array(z.array(scalar)),
    caption: z.string().optional(),
    pageSize: z.number().optional(),
    search: z.boolean().optional(),
  }),
);

const Pair = define(
  "Pair",
  "One key and value of KeyValue.",
  z.object({ key: z.string(), value: scalar }),
);

const KeyValue = define(
  "KeyValue",
  "Aligned list of labeled facts, like a details panel.",
  z.object({ items: z.array(Pair.ref) }),
);

const List = define(
  "List",
  "Bulleted or numbered list of short strings.",
  z.object({ items: z.array(z.string()), ordered: z.boolean().optional() }),
);

const Step = define(
  "Step",
  "One step of Steps. status is done, current, running (spinning Loader), failed or todo (default todo). icon overrides the status icon.",
  z.object({
    title: z.string(),
    description: z.string().optional(),
    status: z.enum(["done", "current", "todo", "failed", "running"]).optional(),
    icon: iconName,
  }),
);

const Steps = define(
  "Steps",
  "Vertical sequence of steps with status, for plans, pipelines and timelines.",
  z.object({ items: z.array(Step.ref) }),
);

const Metric = define(
  "Metric",
  "A big number with a label and an optional hint, such as a delta.",
  z.object({
    label: z.string(),
    value: scalar,
    hint: z.string().optional(),
    tone: toneSchema.optional(),
    icon: iconName,
  }),
);

const Progress = define(
  "Progress",
  "A progress bar. value is 0 to max (default 100).",
  z.object({
    value: z.number(),
    max: z.number().optional(),
    label: z.string().optional(),
    tone: toneSchema.optional(),
  }),
);

const BarChart = define(
  "BarChart",
  "Horizontal bars comparing values. labels and values are parallel arrays.",
  z.object({
    labels: z.array(z.string()),
    values: z.array(z.number()),
    title: z.string().optional(),
    unit: z.string().optional(),
  }),
);

const Slice = define(
  "Slice",
  "One part of StackedBar.",
  z.object({ label: z.string(), value: z.number(), tone: toneSchema.optional() }),
);

const StackedBar = define(
  "StackedBar",
  "One bar split into proportional parts with a legend, for shares of a whole.",
  z.object({ slices: z.array(Slice.ref), title: z.string().optional() }),
);

const Series = define(
  "Series",
  "One named line, area or column series for LineChart, AreaChart and ColumnChart. values is parallel to the chart's labels.",
  z.object({ name: z.string(), values: z.array(z.number()), tone: toneSchema.optional() }),
);

const LineChart = define(
  "LineChart",
  "Lines over ordered labels (days, versions) with a hover/tap readout of every series. area=true fills under the lines.",
  z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    title: z.string().optional(),
    unit: z.string().optional(),
    area: z.boolean().optional(),
  }),
);

const AreaChart = define(
  "AreaChart",
  "Filled areas over ordered labels; stacked=true stacks the series to show a total and its parts, percent=true shows each label's mix as shares of 100%. Hover or tap for values.",
  z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    title: z.string().optional(),
    unit: z.string().optional(),
    stacked: z.boolean().optional(),
    percent: z.boolean().optional(),
  }),
);

const ColumnChart = define(
  "ColumnChart",
  "Vertical bars per label, grouped by series, stacked=true, or percent=true for each label's mix as shares of 100%. Hover or tap a column for values.",
  z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    title: z.string().optional(),
    unit: z.string().optional(),
    stacked: z.boolean().optional(),
    percent: z.boolean().optional(),
  }),
);

const PieChart = define(
  "PieChart",
  "Shares of a whole as a pie, or a donut with donut=true. Hover or tap a slice or legend row for value and percent.",
  z.object({
    slices: z.array(Slice.ref),
    title: z.string().optional(),
    donut: z.boolean().optional(),
    unit: z.string().optional(),
  }),
);

const Points = define(
  "Points",
  "One named group of [x, y] pairs for ScatterChart.",
  z.object({ name: z.string(), points: z.array(z.array(z.number())), tone: toneSchema.optional() }),
);

const ScatterChart = define(
  "ScatterChart",
  "Dots on numeric x and y axes for relationships; one Points group per series (3 at most). A third number in a point, [x, y, size], makes it a bubble. trend=true draws a least-squares line per group. Hover or tap a dot for its values.",
  z.object({
    groups: z.array(Points.ref),
    title: z.string().optional(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    trend: z.boolean().optional(),
  }),
);

const Heatmap = define(
  "Heatmap",
  "A grid of colored cells for a value per row and column (activity by weekday and hour, correlations, pass rate by module and week). values[r][c] is the cell for rows[r] and columns[c]. Hover or tap a cell for its value.",
  z.object({
    rows: z.array(z.string()),
    columns: z.array(z.string()),
    values: z.array(z.array(z.number())),
    title: z.string().optional(),
    unit: z.string().optional(),
  }),
);

const Funnel = define(
  "Funnel",
  "Stages of a process narrowing from top to bottom (visitors, signups, paid), with each stage's share of the first and of the previous stage. Give the stages in order, largest first.",
  z.object({ slices: z.array(Slice.ref), title: z.string().optional(), unit: z.string().optional() }),
);

const Delta = define(
  "Delta",
  "One step of a Waterfall: a signed change, or total=true for a subtotal bar that starts at zero (value 0 means the running sum so far).",
  z.object({ label: z.string(), value: z.number(), total: z.boolean().optional() }),
);

const Waterfall = define(
  "Waterfall",
  "A running total built from increases and decreases, ending in a total (revenue bridge, budget variance, bundle size change). Increases are green, decreases red.",
  z.object({ steps: z.array(Delta.ref), title: z.string().optional(), unit: z.string().optional() }),
);

const Histogram = define(
  "Histogram",
  "The distribution of raw numbers as bars of how many fall in each equal-width range (latency samples, test durations, file sizes). Pass the raw values; bins defaults to a sensible count.",
  z.object({
    values: z.array(z.number()),
    bins: z.number().optional(),
    title: z.string().optional(),
    unit: z.string().optional(),
    xLabel: z.string().optional(),
  }),
);

const Spread = define(
  "Spread",
  "One named group of raw numbers for BoxPlot.",
  z.object({ name: z.string(), values: z.array(z.number()), tone: toneSchema.optional() }),
);

const BoxPlot = define(
  "BoxPlot",
  "Median, quartiles, whiskers and outliers per group, to compare distributions side by side (response time per endpoint, scores per team). Pass the raw values of each group.",
  z.object({ groups: z.array(Spread.ref), title: z.string().optional(), unit: z.string().optional() }),
);

const Candlestick = define(
  "Candlestick",
  "Open, high, low and close per period for prices and ranges. candles[i] is [open, high, low, close] for labels[i]; green closes up, red closes down.",
  z.object({
    labels: z.array(z.string()),
    candles: z.array(z.array(z.number())),
    title: z.string().optional(),
    unit: z.string().optional(),
  }),
);

const RadarChart = define(
  "RadarChart",
  "Several measures of one or more items on spokes around a center, for profiles and skill or quality comparisons (3 to 8 axes, 3 series at most). max sets the outer ring; default is the largest value.",
  z.object({
    axes: z.array(z.string()),
    series: z.array(Series.ref),
    title: z.string().optional(),
    max: z.number().optional(),
  }),
);

const CalendarHeatmap = define(
  "CalendarHeatmap",
  "Days as small squares in week columns shaded by value, like a contribution graph (commits, deploys, incidents per day). days are ISO dates (2026-03-01) and values is parallel to days.",
  z.object({ days: z.array(z.string()), values: z.array(z.number()), title: z.string().optional(), unit: z.string().optional() }),
);

const Tile = define(
  "Tile",
  "One rectangle of a Treemap, sized by value.",
  z.object({ label: z.string(), value: z.number(), tone: toneSchema.optional() }),
);

const Treemap = define(
  "Treemap",
  "Rectangles whose area is proportional to value, for how a total divides across many items (disk usage, bundle size, spend by service). Hover or tap a tile for value and share.",
  z.object({ tiles: z.array(Tile.ref), title: z.string().optional(), unit: z.string().optional() }),
);

const Gauge = define(
  "Gauge",
  "A dial showing one value between min and max (default 0 to 100). warnAt and dangerAt are the values where the dial turns yellow and red, for metrics where higher is worse.",
  z.object({
    value: z.number(),
    max: z.number().optional(),
    label: z.string().optional(),
    unit: z.string().optional(),
    min: z.number().optional(),
    warnAt: z.number().optional(),
    dangerAt: z.number().optional(),
  }),
);

const Sparkline = define(
  "Sparkline",
  "A tiny inline trend line with its latest value, for dashboards and rows of Metrics.",
  z.object({ values: z.array(z.number()), label: z.string().optional(), tone: toneSchema.optional(), unit: z.string().optional() }),
);

const Moment = define(
  "Moment",
  "One entry of a Timeline: when it happened, a title, optional detail, a tone and an icon name.",
  z.object({
    time: z.string(),
    title: z.string(),
    detail: z.string().optional(),
    tone: toneSchema.optional(),
    icon: z.string().optional(),
  }),
);

const Timeline = define(
  "Timeline",
  "Events in order down a vertical line, for history, deploys, incident logs and roadmaps. Moments are shown in the order given.",
  z.object({ moments: z.array(Moment.ref), title: z.string().optional() }),
);

const Task = define(
  "Task",
  "One bar of a Gantt chart. start and end are ISO dates (2026-03-01) or plain numbers; progress is 0 to 100.",
  z.object({
    name: z.string(),
    start: z.string(),
    end: z.string(),
    tone: toneSchema.optional(),
    progress: z.number().optional(),
  }),
);

const Gantt = define(
  "Gantt",
  "Horizontal bars on a shared time axis for schedules, plans and overlapping work. Tap a bar for its dates.",
  z.object({ tasks: z.array(Task.ref), title: z.string().optional() }),
);

const Spinner = define(
  "Spinner",
  "A spinning indicator with an optional label, for work that is still running. icon replaces the default Loader with another Lucide icon that spins, such as RefreshCw or Cog.",
  z.object({ label: z.string().optional(), tone: toneSchema.optional(), icon: iconName }),
);

const FileTree = define(
  "FileTree",
  "A directory tree built from file paths such as src/app/main.ts.",
  z.object({ paths: z.array(z.string()), title: z.string().optional() }),
);

// ── Media ───────────────────────────────────────────────────────────────────

const Latex = define(
  "Latex",
  "A LaTeX math formula drawn as an image (MathJax with amsmath: fractions, matrices, cases, aligned). inline=true for a small formula inside a sentence-sized line. Pass LaTeX source without $ delimiters.",
  z.object({ tex: z.string(), inline: z.boolean().optional(), caption: z.string().optional() }),
);

const Svg = define(
  "Svg",
  "Your own <svg>…</svg> markup drawn as an image: custom diagrams, icons, illustrations. Give the svg a width, height and viewBox. No scripts, no external images. Use currentColor for the theme's text color. For Arabic text set font-family=\"Noto Sans Arabic\" on that text.",
  z.object({ source: z.string(), caption: z.string().optional() }),
);

const Graph = define(
  "Graph",
  "A Graphviz DOT graph laid out automatically: flowcharts, dependency graphs, state machines, org charts. Example source: digraph { rankdir=LR; a -> b -> c }.",
  z.object({ dot: z.string(), caption: z.string().optional() }),
);

const QrCode = define(
  "QrCode",
  "A QR code for a URL or short text, so the user can scan it with a phone.",
  z.object({ value: z.string(), caption: z.string().optional() }),
);

const Embed = define(
  "Embed",
  "A web page shown in a frame inside the card: an https URL (YouTube and Vimeo links become players), or the path of an .html file in your working directory. Many sites refuse to be framed and show blank; use your own HTML or an embed-friendly URL. height is in pixels (default 320). On phones it is a card with an Open button, because the app has no embedded browser.",
  z.object({ src: z.string(), title: z.string().optional(), height: z.number().optional() }),
);

const Html = define(
  "Html",
  "Your own HTML (a snippet or a full page, with CSS and scripts) shown in a sandboxed frame: interactive widgets, custom layouts, small demos. No network cookies or access to the app. height is in pixels (default 320). On phones it is a card with an Open button.",
  z.object({ code: z.string(), title: z.string().optional(), height: z.number().optional() }),
);

const Image = define(
  "Image",
  "A local image (png, jpg, gif, webp, up to 4 MB) shown inline; tap to open it larger. src is a file path inside your working directory or the temp directory. URLs are not supported.",
  z.object({ src: z.string(), alt: z.string().optional(), caption: z.string().optional() }),
);

const Video = define(
  "Video",
  "A local video or audio file (mp4, mov, webm, mp3, m4a, wav). Shows a play card that opens the file in the browser. src is a path inside your working directory or the temp directory.",
  z.object({ src: z.string(), title: z.string().optional() }),
);

const Attachment = define(
  "Attachment",
  "A local PDF or HTML page (such as a generated report or demo) that opens in the browser. src is a path inside your working directory or the temp directory.",
  z.object({ src: z.string(), label: z.string().optional() }),
);

// ── Input and actions ───────────────────────────────────────────────────────

const Button = define(
  "Button",
  "Tappable button. Without an action it sends its label back to the assistant.",
  z.object({
    label: z.string(),
    action: action().optional(),
    variant: z.enum(["primary", "secondary", "danger"]).optional(),
    icon: iconName,
  }),
);

const Input = define(
  "Input",
  "Single-line text field. Bind with a $variable or read it from the Form it sits in.",
  z.object({
    name: z.string(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    kind: z.enum(["text", "number", "email", "password", "url"]).optional(),
    value: reactive(z.string().optional()),
  }),
);

const TextArea = define(
  "TextArea",
  "Multi-line text field.",
  z.object({
    name: z.string(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    value: reactive(z.string().optional()),
  }),
);

const Select = define(
  "Select",
  "Pick one option from a short list, shown as chips.",
  z.object({
    name: z.string(),
    options: z.array(z.string()),
    label: z.string().optional(),
    value: reactive(z.string().optional()),
  }),
);

const RadioGroup = define(
  "RadioGroup",
  "Pick one option from a vertical list.",
  z.object({
    name: z.string(),
    options: z.array(z.string()),
    label: z.string().optional(),
    value: reactive(z.string().optional()),
  }),
);

const CheckboxGroup = define(
  "CheckboxGroup",
  "Pick any number of options. The value is an array of the chosen strings.",
  z.object({
    name: z.string(),
    options: z.array(z.string()),
    label: z.string().optional(),
    value: reactive(z.array(z.string()).optional()),
  }),
);

const Switch = define(
  "Switch",
  "On/off toggle with a label.",
  z.object({ name: z.string(), label: z.string(), value: reactive(z.boolean().optional()) }),
);

const Stepper = define(
  "Stepper",
  "Number picker with minus and plus buttons.",
  z.object({
    name: z.string(),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    label: z.string().optional(),
    value: reactive(z.number().optional()),
  }),
);

const Slider = define(
  "Slider",
  "Drag to pick a number in a range; the value shows beside the track. Bind with a $variable so prices, totals and charts follow it as it moves.",
  z.object({
    name: z.string(),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    label: z.string().optional(),
    unit: z.string().optional(),
    value: reactive(z.number().optional()),
  }),
);

const ToggleGroup = define(
  "ToggleGroup",
  "A compact segmented control: pick one of a few short options such as Monthly | Annual or Chart | Table. Better than Select for switching views.",
  z.object({
    name: z.string(),
    options: z.array(z.string()),
    label: z.string().optional(),
    icons: z.array(z.string()).optional(),
    value: reactive(z.string().optional()),
  }),
);

const Combobox = define(
  "Combobox",
  "Pick one option from a long list with a search box. Use instead of Select for more than about 8 options.",
  z.object({
    name: z.string(),
    options: z.array(z.string()),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    value: reactive(z.string().optional()),
  }),
);

const MultiSelect = define(
  "MultiSelect",
  "Pick any number of options from a long list with a search box. The value is an array of the chosen strings. Use instead of CheckboxGroup for more than about 8 options.",
  z.object({
    name: z.string(),
    options: z.array(z.string()),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    value: reactive(z.array(z.string()).optional()),
  }),
);

const DatePicker = define(
  "DatePicker",
  "A calendar to pick a day, or a range with range=true. The value is a YYYY-MM-DD string, or a [start, end] array for a range (one entry while the end is still to be picked). Filter data by it with @DateIn.",
  z.object({
    name: z.string(),
    label: z.string().optional(),
    range: z.boolean().optional(),
    min: z.string().optional(),
    max: z.string().optional(),
    value: reactive(z.union([z.string(), z.array(z.string())]).optional()),
  }),
);

const Form = define(
  "Form",
  "Groups fields so their values are sent together when a button in buttons fires @ToAssistant.",
  z.object({ name: z.string(), fields: z.array(z.any()), buttons: z.array(Button.ref) }),
);

const Has = defineFunction({
  name: "Has",
  description: "True when the array contains the value. Use with a CheckboxGroup or MultiSelect $variable to show or hide things.",
  params: z.object({ array: z.array(z.any()), value: z.any() }),
  returns: z.boolean(),
  fn: ({ array, value }) => array.includes(value),
});

const Join = defineFunction({
  name: "Join",
  description: "Joins an array into one string with a separator (default \", \").",
  params: z.object({ array: z.array(z.any()), separator: z.string().optional() }),
  returns: z.string(),
  fn: ({ array, separator }) => array.join(separator ?? ", "),
});

const DateIn = defineFunction({
  name: "DateIn",
  description: "Keeps the rows whose date field is inside a DatePicker value (a day or a [start, end] range). With no date picked yet it keeps every row. Dates are YYYY-MM-DD, or start with it.",
  params: z.object({ rows: z.array(z.any()), field: z.string(), value: z.any() }),
  returns: z.array(z.any()),
  fn: ({ rows, field, value }) => rowsOnDates(rows, field, value),
});

export const library = createLibrary({
  root: "Stack",
  components: [
    Stack, Grid, Card, Tab, Tabs, Panel, Accordion, Dialog, Popover, Tooltip, Separator,
    Heading, Text, Markdown, CodeBlock, Diff, Callout, Badge, Icon, Link, FileRef,
    Table, DataTable, Pair, KeyValue, List, Step, Steps, Metric, Progress, BarChart, Slice, StackedBar, FileTree,
    Series, LineChart, AreaChart, ColumnChart, PieChart, Points, ScatterChart,
    Heatmap, Funnel, Delta, Waterfall, Histogram, Spread, BoxPlot, Candlestick, RadarChart, CalendarHeatmap, Tile, Treemap, Gauge, Sparkline, Moment, Timeline, Task, Gantt, Spinner,
    Latex, Svg, Graph, QrCode,
    Image, Video, Attachment, Embed, Html,
    Button, Input, TextArea, Select, RadioGroup, CheckboxGroup, Switch, Stepper, Slider, ToggleGroup, Combobox, MultiSelect, DatePicker, Form,
  ],
  functions: [Has, Join, DateIn],
  componentGroups: [
    { name: "Layout", components: ["Stack", "Grid", "Card", "Tabs", "Tab", "Accordion", "Panel", "Dialog", "Popover", "Tooltip", "Separator"] },
    {
      name: "Text and code",
      components: ["Heading", "Text", "Markdown", "CodeBlock", "Diff", "Callout", "Badge", "Icon", "Link", "FileRef"],
    },
    {
      name: "Data",
      components: [
        "Table", "DataTable", "KeyValue", "Pair", "List", "Steps", "Step", "Metric", "Progress",
        "BarChart", "StackedBar", "FileTree",
      ],
    },
    {
      name: "Charts",
      components: [
        "LineChart", "AreaChart", "ColumnChart", "PieChart", "ScatterChart", "Heatmap", "CalendarHeatmap", "Treemap", "Gauge", "Sparkline",
        "Funnel", "Waterfall", "Histogram", "BoxPlot", "Candlestick", "RadarChart",
        "Series", "Points", "Slice", "Tile", "Delta", "Spread",
      ],
    },
    { name: "Time and progress", components: ["Timeline", "Moment", "Gantt", "Task", "Spinner"] },
    { name: "Math and diagrams", components: ["Latex", "Graph", "Svg", "QrCode"] },
    { name: "Media", components: ["Image", "Video", "Attachment", "Embed", "Html"] },
    {
      name: "Input",
      components: [
        "Button", "Form", "Input", "TextArea", "Select", "RadioGroup", "CheckboxGroup", "Switch", "Stepper", "Slider", "ToggleGroup", "Combobox", "MultiSelect", "DatePicker",
      ],
    },
  ],
});

export const GUIDE_PREAMBLE =
  "You answer inside Paseo, a developer app. When a visual answer beats prose, call the render tool with a program in OpenUI Lang. The user sees interactive native UI, not text.";

/** For agents without the render tool: the program goes in a fenced block the app turns into UI. */
export const FENCE_PREAMBLE =
  "You answer inside Paseo, a developer app. When a visual answer beats prose, put a program in OpenUI Lang inside a fenced code block tagged `openui`. The app draws that block as interactive native UI in the chat, in place of the code.";

const SHARED_RULES = [
  "root = Stack([...]) is the entry. Put every statement on its own line: name = Component(args).",
  "Arguments are positional in the signature order. Skip optional ones you do not need; to set a later optional argument, pass null for the earlier ones.",
  "Strings use double quotes. Escape quotes as \\\" and newlines as \\n inside strings.",
  "Prefer Card, Metric, Table, Steps, Callout and Markdown over long Text. Keep it scannable: a title, a few blocks, no walls of text.",
  "Use Markdown for prose with inline formatting; Text only for one short line.",
  "Use Lucide icons often: they make a UI scannable and feel native. Heading, Card, Tab, Panel, Metric, Badge, Button, Callout, Step, Moment and Spinner take an icon name as their last argument (Rocket, GitBranch, Bug, ShieldCheck, Database, Clock, FlaskConical, Zap, TriangleAlert). Pass null for skipped arguments before it.",
  "Motion: Steps with status running spin a Loader; Spinner shows work in progress; Icon(name, tone, size, animation) loops spin, pulse (live or recording) or bounce (needs attention). Use motion sparingly, for what is happening now.",
  "Prefer the specialised component: Gauge for one value against a limit, Sparkline for a trend inside a row, Heatmap for a value per row and column, CalendarHeatmap for activity per day, Treemap for parts of a total across many items, Funnel for stages that narrow, Waterfall for a total built from ups and downs, Histogram for the spread of raw samples, BoxPlot to compare spreads, Candlestick for open/high/low/close, RadarChart for profiles on several axes, Timeline for events in order, Gantt for schedules, Spinner for running work. Pass raw numbers to Histogram and BoxPlot; they compute the bins and quartiles.",
  "Make the UI alive: declare state with `$name = default` and bind inputs to it (Switch, ToggleGroup, Select, Combobox, RadioGroup, CheckboxGroup, MultiSelect, Slider, Stepper, DatePicker, Input take the $variable as their last argument). Everything that reads the variable updates as the user changes it, with no round trip to you. Use it for calculators and pricing (Slider or Stepper for quantity, Switch for annual billing, totals in Metric), comparisons (CheckboxGroup or Switch decide which rows and columns show), filters and search (Select or Input narrow a Table or chart), and view modes (ToggleGroup plus a ternary between components: view = $mode == \"Chart\" ? chart : table). Pick the control by size: ToggleGroup for 2 to 4 short views, Select or RadioGroup for a handful, Combobox or MultiSelect for long lists, DatePicker (range=true for a period) for dates. Use DataTable instead of Table for long data: it sorts, searches and pages by itself. Dialog opens over the chat from a Button with @Set($open, true) (declare $open = false and pass it as the Dialog's last argument), and Popover and Tooltip tuck away secondary detail.",
  "Derive values in their own statements from the data and the $variables: `shown = $level == \"all\" ? items : @Filter(items, \"sev\", \"==\", $level)`. Functions: @Filter(array, field, op, value) with op ==, !=, >, <, >=, <=, contains (field \"\" for plain arrays); @Sort(array, field, \"asc\"|\"desc\"); @Each(array, \"row\", expression) builds a list, e.g. Table rows @Each(shown, \"r\", [r.name, r.sev]) or chart values; @Count, @Sum, @Avg, @Min, @Max, @Round(number, decimals), @First, @Last; @Has(array, value) is true when a CheckboxGroup or MultiSelect holds the value (show or hide columns and blocks with it); @Join(array, separator); @DateIn(rows, field, $picked) keeps the rows whose YYYY-MM-DD field is in a DatePicker value. Put the full data in the program once and let the user slice it. Prefer this over a Form with a button: use a Form only when the answer must come back to you.",
  "Never put secrets or personal data in the program: it is stored in the conversation.",
  "Image, Video and Attachment take a file path on this machine (inside your working directory or the temp directory), never a URL. Save screenshots, charts or recordings to a file first, then reference the path.",
];

export const GUIDE_RULES = [
  "In the `ui` argument output only the program: no markdown fences, no commentary.",
  ...SHARED_RULES,
  "To ask the user something, use a Form with Select/RadioGroup/Input fields and Buttons, and call render with wait=true. Without wait the answer arrives as a later message.",
  "You can also put the same program in a ```openui fence inside your normal reply text (text after `openui` on the fence line is the card title). The app draws it identically, in line with your prose. Use the tool when you need wait=true or want validation errors back; use a fence for UI that belongs in the middle of an explanation. Prose around a fence still renders as Markdown.",
];

export const FENCE_RULES = [
  "Write the program inside a ```openui fence, nothing else inside it. Prose may come before and after. Text after `openui` on the fence line is the card title, e.g. ```openui Build status.",
  ...SHARED_RULES,
  "To ask the user something, use a Form with Select/RadioGroup/Input fields and Buttons. Their answer arrives as a later <openui-answer> message; you cannot wait for it inside the turn, so end the turn after asking.",
];

export const GUIDE_EXAMPLES = [
  `root = Stack([title, grid, steps, actions], "column", "m")
title = Heading("Release 1.4 status", 1, "Rocket")
grid = Grid([m1, m2, m3], 3)
m1 = Metric("Tests", "412 passing", "+12 since main", "success", "FlaskConical")
m2 = Metric("Coverage", "87%", "-1%", "warning", "ShieldCheck")
m3 = Metric("Bundle", "1.2 MB", "unchanged", null, "Package")
steps = Steps([Step("Build", "green", "done"), Step("E2E", "3 of 5 suites", "running"), Step("Deploy", null, "todo")])
actions = Stack([Button("Ship it", @ToAssistant("Ship it"), "primary", "Rocket"), Button("Hold", @ToAssistant("Hold the release"), "secondary", "Pause")], "row", "s")`,
  `root = Stack([gauges, load, history, plan])
gauges = Grid([Gauge(42, 100, "CPU", "%", 0, 60, 85), Gauge(93, 100, "Disk", "%", 0, 60, 85)], 2)
load = Sparkline([3, 5, 4, 8, 7, 9, 12], "Requests", "accent")
history = Timeline([Moment("10:02", "Deploy started", "v2.4.1", "accent", "Rocket"), Moment("10:07", "Health check failed", null, "danger", "TriangleAlert"), Moment("10:31", "Recovered", null, "success", "Check")], "Incident")
plan = Gantt([Task("Design", "2026-03-01", "2026-03-14", "accent", 100), Task("Build", "2026-03-10", "2026-04-20", "success", 55)], "Roadmap")`,
  `root = Stack([trend, share])
trend = LineChart(["Mon", "Tue", "Wed", "Thu", "Fri"], [Series("Requests", [120, 180, 150, 240, 210]), Series("Errors", [4, 9, 6, 15, 7], "danger")], "Traffic this week", "", true)
share = PieChart([Slice("Chrome", 64), Slice("Safari", 22), Slice("Firefox", 9), Slice("Other", 5)], "Browsers", true, "%")`,
  `$seats = 5
$annual = false
$plan = "Team"
root = Stack([title, controls, total, note], "column", "m")
title = Heading("Checkout", 2, "ShoppingCart")
controls = Card([Select("plan", ["Team", "Business"], "Plan", $plan), Slider("seats", 1, 100, 1, "Seats", "seats", $seats), Switch("annual", "Pay annually (-20%)", $annual)])
price = $plan == "Team" ? 12 : 30
total = Metric("Total per month", "$" + @Round($seats * price * ($annual ? 0.8 : 1), 2), $seats + " seats at $" + price, "accent", "CreditCard")
note = $annual ? Callout("Annual billing saves 20%", "success", "Tag") : Callout("Switch to annual to save 20%", "info", "Info")`,
  `$level = "all"
$q = ""
$sort = "count"
issues = [{name: "Memory leak", sev: "high", count: 3}, {name: "Typo in docs", sev: "low", count: 9}, {name: "Crash on start", sev: "high", count: 1}, {name: "Slow search", sev: "medium", count: 5}]
bySeverity = $level == "all" ? issues : @Filter(issues, "sev", "==", $level)
matching = @Filter(bySeverity, "name", "contains", $q)
ordered = @Sort(matching, $sort, "desc")
root = Stack([filters, summary, tbl, chart], "column", "m")
filters = Card([Select("level", ["all", "high", "medium", "low"], "Severity", $level), Input("q", "Search", "name", "text", $q), RadioGroup("sort", ["count", "name"], "Sort by", $sort)])
summary = Metric("Showing", @Count(ordered) + " of " + @Count(issues), @Sum(@Each(ordered, "r", r.count)) + " reports", null, "ListFilter")
tbl = Table(["Issue", "Severity", "Reports"], @Each(ordered, "r", [r.name, r.sev, r.count]))
chart = ColumnChart(@Each(ordered, "r", r.name), [Series("Reports", @Each(ordered, "r", r.count))], "Reports per issue")`,
  `$period = []
$view = "Table"
$team = "all"
$open = false
events = [{what: "Deploy v2.4", at: "2026-03-02", team: "Platform", cost: 12}, {what: "Outage", at: "2026-03-10", team: "Platform", cost: 90}, {what: "Fix rollout", at: "2026-03-12", team: "Payments", cost: 30}, {what: "Retro", at: "2026-04-01", team: "Payments", cost: 5}]
inPeriod = @DateIn(events, "at", $period)
shown = $team == "all" ? inPeriod : @Filter(inPeriod, "team", "==", $team)
rows = @Each(shown, "e", [e.at, e.what, e.team, e.cost])
table = DataTable(["Date", "Event", "Team", "Cost"], rows, "Events", 10, false)
chart = ColumnChart(@Each(shown, "e", e.what), [Series("Cost", @Each(shown, "e", e.cost))], "Cost per event")
body = $view == "Table" ? table : chart
filters = Card([DatePicker("period", "Period", true, null, null, $period), Combobox("team", ["all", "Platform", "Payments"], "Team", "Any team", $team), ToggleGroup("view", ["Table", "Chart"], "Show", ["Table", "ChartColumn"], $view)])
help = Dialog("How costs are counted", [Markdown("Cost is engineer-hours spent on the event.")], null, $open)
root = Stack([filters, Metric("Total cost", @Sum(@Each(shown, "e", e.cost)), @Count(shown) + " events", null, "Wallet"), body, Button("How is cost counted?", @Set($open, true), "secondary", "Info"), help], "column", "m")`,
  `root = Stack([f])
f = Form("deploy", [Select("env", ["staging", "production"], "Environment"), Switch("migrate", "Run migrations", true), Input("note", "Note", "optional")], [Button("Deploy", @ToAssistant("Deploy"), "primary")])`,
];

export const GUIDE_OPTIONS = {
  preamble: GUIDE_PREAMBLE,
  additionalRules: GUIDE_RULES,
  examples: GUIDE_EXAMPLES,
  bindings: true,
  toolCalls: false,
  builtinFunctions: true,
} as const;

export const FENCE_OPTIONS = {
  ...GUIDE_OPTIONS,
  preamble: FENCE_PREAMBLE,
  additionalRules: FENCE_RULES,
} as const;
