import { Type } from "typebox";
import { Value } from "typebox/value";

import { asRecord, readNumber, readString } from "../utils/unknown-data.js";
import { parseJsonValue } from "./json.js";
import type { ProjectItemSnapshot, ProjectMetadata } from "./github-types.js";
import { type WorkItem, WorkItemSchema } from "./store/types.js";

const GraphqlResponseSchema = Type.Object({ data: Type.Record(Type.String(), Type.Unknown()) });

export function parseProjectItemGraphql(stdout: string): ProjectItemSnapshot | undefined {
  const response = Value.Parse(
    GraphqlResponseSchema,
    parseJsonValue(stdout, "gh project item graphql"),
  );
  return parseProjectItemSnapshot(response.data.node);
}

export function parseProjectItemsGraphql(stdout: string, statusField = "Status"): WorkItem[] {
  return parseProjectItemsGraphqlPage(stdout, statusField).items;
}

export function parseProjectItemsGraphqlPage(
  stdout: string,
  statusField = "Status",
): { items: WorkItem[]; hasNextPage: boolean; endCursor?: string } {
  const response = Value.Parse(
    GraphqlResponseSchema,
    parseJsonValue(stdout, "gh project items graphql"),
  );
  const project = readProject(response.data);
  const projectId = readString(project.id);
  const items = asRecord(project.items);
  const itemNodes = readNodes(items?.nodes);
  const pageInfo = asRecord(items?.pageInfo);
  if (projectId === undefined) throw new Error("Project GraphQL response missing project id");

  return {
    items: itemNodes.flatMap((node) => normalizeProjectItem(node, projectId, statusField)),
    hasNextPage: pageInfo?.hasNextPage === true,
    ...(readString(pageInfo?.endCursor) === undefined
      ? {}
      : { endCursor: readString(pageInfo?.endCursor) }),
  };
}

export function parseProjectMetadataGraphql(stdout: string): ProjectMetadata {
  const response = Value.Parse(
    GraphqlResponseSchema,
    parseJsonValue(stdout, "gh project metadata graphql"),
  );
  const project = readProject(response.data);
  const projectId = readString(project.id);
  if (projectId === undefined) throw new Error("Project GraphQL response missing project id");

  const fields = new Map<string, { fieldId: string; options: Map<string, string> }>();
  for (const fieldNode of readNodes(asRecord(project.fields)?.nodes)) {
    const field = asRecord(fieldNode);
    const name = readString(field?.name);
    const fieldId = readString(field?.id);
    if (name === undefined || fieldId === undefined) continue;
    const options = new Map<string, string>();
    const optionNodes = Array.isArray(field?.options) ? field.options : [];
    for (const optionNode of optionNodes) {
      const option = asRecord(optionNode);
      const optionName = readString(option?.name);
      const optionId = readString(option?.id);
      if (optionName !== undefined && optionId !== undefined) options.set(optionName, optionId);
    }
    fields.set(name, { fieldId, options });
  }

  return { projectId, fields };
}

function readProject(data: Record<string, unknown>): Record<string, unknown> {
  const organizationProject = asRecord(asRecord(data.organization)?.projectV2);
  if (organizationProject !== undefined) return organizationProject;
  const userProject = asRecord(asRecord(data.user)?.projectV2);
  if (userProject !== undefined) return userProject;
  throw new Error("Project GraphQL response did not include organization or user projectV2");
}

function normalizeProjectItem(node: unknown, projectId: string, statusField: string): WorkItem[] {
  const item = asRecord(node);
  const content = asRecord(item?.content);
  if (item === undefined || content === undefined) return [];
  const repository = asRecord(content.repository);
  const owner = readString(asRecord(repository?.owner)?.login);
  const repo = readString(repository?.name);
  const issueNumber = readNumber(content.number);
  const issueState = readString(content.state);
  const title = readString(content.title);
  const url = readString(content.url);
  const projectItemId = readString(item.id);
  if (
    owner === undefined ||
    repo === undefined ||
    issueNumber === undefined ||
    (issueState !== "OPEN" && issueState !== "CLOSED") ||
    title === undefined ||
    url === undefined ||
    projectItemId === undefined
  ) {
    return [];
  }

  return [
    Value.Parse(WorkItemSchema, {
      projectItemId,
      projectId,
      owner,
      repo,
      issueId: readString(content.id),
      issueNumber,
      issueState,
      issueUrl: url,
      title,
      body: readString(content.body) ?? "",
      labels: readNameNodes(asRecord(content.labels)?.nodes),
      assignees: readLoginNodes(asRecord(content.assignees)?.nodes),
      projectStatus: readProjectStatus(item, statusField),
      projectFields: readProjectFields(item),
    }),
  ];
}

function parseProjectItemSnapshot(node: unknown): ProjectItemSnapshot | undefined {
  const item = asRecord(node);
  const project = asRecord(item?.project);
  const projectId = readString(project?.id);
  const projectOwner = readString(asRecord(project?.owner)?.login);
  const projectNumber = readNumber(project?.number);
  if (item === undefined || projectId === undefined || projectOwner === undefined) return undefined;
  if (projectNumber === undefined) return undefined;
  const workItem = normalizeProjectItem(item, projectId, "Status")[0];
  if (workItem === undefined) return undefined;
  return {
    project: { id: projectId, owner: projectOwner, number: projectNumber },
    workItem,
  };
}

function readProjectStatus(item: Record<string, unknown>, statusField: string): string | undefined {
  const fields = readProjectFields(item);
  const status = fields[statusField];
  return typeof status === "string" ? status : undefined;
}

function readProjectFields(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const fieldValueNode of readNodes(asRecord(item.fieldValues)?.nodes)) {
    const fieldValue = asRecord(fieldValueNode);
    const fieldName = readString(asRecord(fieldValue?.field)?.name);
    if (fieldName === undefined) continue;
    const value =
      readString(fieldValue?.name) ??
      readString(fieldValue?.text) ??
      readString(fieldValue?.date) ??
      readNumber(fieldValue?.number);
    if (value !== undefined) result[fieldName] = value;
  }
  return result;
}

function readNameNodes(value: unknown): string[] {
  return readNodes(value).flatMap((node) => {
    const name = readString(asRecord(node)?.name);
    return name === undefined ? [] : [name];
  });
}

function readLoginNodes(value: unknown): string[] {
  return readNodes(value).flatMap((node) => {
    const login = readString(asRecord(node)?.login);
    return login === undefined ? [] : [login];
  });
}

function readNodes(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
