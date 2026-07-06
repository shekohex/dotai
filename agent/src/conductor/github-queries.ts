export const PROJECT_FIELDS_FRAGMENT = `
fragment ProjectFields on ProjectV2 {
  id
  fields(first: 100) {
    nodes {
      ... on ProjectV2Field { id name }
      ... on ProjectV2IterationField { id name }
      ... on ProjectV2SingleSelectField { id name options { id name } }
    }
  }
}`;

export const PROJECT_METADATA_QUERY = `
query($owner: String!, $number: Int!) {
  organization(login: $owner) { projectV2(number: $number) { ...ProjectFields } }
  user(login: $owner) { projectV2(number: $number) { ...ProjectFields } }
}
${PROJECT_FIELDS_FRAGMENT}`;

export function projectMetadataQuery(ownerKind: "organization" | "user"): string {
  return `
query($owner: String!, $number: Int!) {
  ${ownerKind}(login: $owner) { projectV2(number: $number) { ...ProjectFields } }
}
${PROJECT_FIELDS_FRAGMENT}`;
}

export const PROJECT_ITEMS_QUERY = `
query($owner: String!, $number: Int!, $cursor: String) {
  organization(login: $owner) { projectV2(number: $number) { ...ProjectItems } }
  user(login: $owner) { projectV2(number: $number) { ...ProjectItems } }
}
fragment ProjectItems on ProjectV2 {
  id
  items(first: 100, after: $cursor) {
    nodes {
      id
      content {
        ... on Issue {
          id
          number
          title
          body
          url
          repository { name owner { login } }
          labels(first: 50) { nodes { name } }
          assignees(first: 20) { nodes { login } }
        }
      }
      fieldValues(first: 50) {
        nodes {
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function projectItemsQuery(ownerKind: "organization" | "user"): string {
  return `
query($owner: String!, $number: Int!, $cursor: String) {
  ${ownerKind}(login: $owner) { projectV2(number: $number) { ...ProjectItems } }
}
fragment ProjectItems on ProjectV2 {
  id
  items(first: 100, after: $cursor) {
    nodes {
      id
      content {
        ... on Issue {
          id
          number
          title
          body
          url
          repository { name owner { login } }
          labels(first: 50) { nodes { name } }
          assignees(first: 20) { nodes { login } }
        }
      }
      fieldValues(first: 50) {
        nodes {
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

export const UPDATE_PROJECT_STATUS_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`;
