export function projectKey(owner: string, number: number): string {
  return `${owner.toLowerCase()}/${number}`;
}

export function projectConfigKey(project: { owner: string; number: number }): string {
  return projectKey(project.owner, project.number);
}
