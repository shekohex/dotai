import { Accordion, Card, Grid, Separator, Stack, Tabs } from "./layout";
import { Badge, Callout, CodeBlock, Diff, FileRef, Heading, Icon, Link, Markdown, Text } from "./text";
import { BarChart, FileTree, KeyValue, List, Metric, Progress, StackedBar, Steps, Table } from "./data";
import { Button, CheckboxGroup, Form, Input, RadioGroup, Select, Slider, Stepper, Switch, TextArea } from "./input";
import { AreaChart, ColumnChart, LineChart, PieChart, ScatterChart } from "./chart";
import { BoxPlot, CalendarHeatmap, Candlestick, Funnel, Histogram, RadarChart, Waterfall } from "./stats";
import { Gantt, Gauge, Heatmap, Spinner, Sparkline, Timeline, Treemap } from "./viz";
import { Graph, Latex, QrCode, Svg } from "./raster";
import { Embed, Html } from "./embed";
import { Attachment, Image, Video } from "./media";
import { DataTable } from "./datatable";
import { Dialog, Popover, Tooltip } from "./overlay";
import { Combobox, DatePicker, MultiSelect, ToggleGroup } from "./pickers";
import type { NodeComponent } from "./types";

/**
 * Library component name to its native view. Tab, Panel, Pair, Step, Slice, Series, Points, Tile, Moment, Task, Delta and Spread are read by their
 * parent (Tabs, Accordion, KeyValue, Steps, StackedBar and the charts) and never render on their own.
 */
export const COMPONENTS: Record<string, NodeComponent> = {
  Stack, Grid, Card, Tabs, Accordion, Dialog, Popover, Tooltip, Separator,
  Heading, Text, Markdown, CodeBlock, Diff, Callout, Badge, Icon, Link, FileRef,
  Table, DataTable, KeyValue, List, Steps, Metric, Progress, BarChart, StackedBar, FileTree,
  LineChart, AreaChart, ColumnChart, PieChart, ScatterChart,
  Funnel, Waterfall, Histogram, BoxPlot, Candlestick, RadarChart, CalendarHeatmap,
  Heatmap, Treemap, Gauge, Sparkline, Timeline, Gantt, Spinner,
  Latex, Svg, Graph, QrCode,
  Image, Video, Attachment, Embed, Html,
  Button, Form, Input, TextArea, Select, RadioGroup, CheckboxGroup, Switch, Stepper, Slider, ToggleGroup, Combobox, MultiSelect, DatePicker,
};
