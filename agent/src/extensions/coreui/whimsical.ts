import { welcomeMessages, workingMessages } from "./whimsical-data.js";

export function pickRandomWhimsical(): string {
  return workingMessages[Math.floor(Math.random() * workingMessages.length)];
}

export function pickRandomWelcomeMessage(previous?: string): string {
  if (welcomeMessages.length === 0) {
    return "How can I help?";
  }

  if (welcomeMessages.length === 1) {
    return welcomeMessages[0];
  }

  let next = previous;
  while (next === previous) {
    next = welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
  }

  return next!;
}
