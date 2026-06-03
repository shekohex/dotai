export function buildLiteResumePrompt(task: string): string {
  return ["Continue the task.", "Task:", task].join("\n\n");
}
