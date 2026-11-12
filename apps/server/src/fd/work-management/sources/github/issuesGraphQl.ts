/**
 * GitHub Issues GraphQL documents. Lists and search stay on GraphQL (stable cursors, no pull
 * requests, the graphql quota); nested connections stay at 50 or fewer to bound cost. `basic`
 * fragments drop sub-issue and dependency fields for older Enterprise Servers that refuse `full`.
 */

const SUMMARY_BASIC = `
  id number title state stateReason url updatedAt
  labels(first: 32) { nodes { name } }
  assignees(first: 5) { nodes { login name } }
`;

const SUMMARY_FULL = `${SUMMARY_BASIC}
  parent { number }
  issueDependenciesSummary { blockedBy }
  blockedBy(first: 50) { nodes { number state } }
`;

export type IssueFieldSet = "full" | "basic";

const summaryFields = (fields: IssueFieldSet) => (fields === "full" ? SUMMARY_FULL : SUMMARY_BASIC);

export const listIssuesQuery = (fields: IssueFieldSet) => `
  query WorkIssues($owner: String!, $name: String!, $first: Int!, $after: String,
                   $states: [IssueState!], $labels: [String!], $assignee: String) {
    repository(owner: $owner, name: $name) {
      issues(first: $first, after: $after, states: $states, labels: $labels,
             orderBy: { field: UPDATED_AT, direction: DESC },
             filterBy: { assignee: $assignee }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${summaryFields(fields)} }
      }
    }
  }
`;

/** One page of an issue's comments, newest first from `before`, for a walk through all of them. */
export const issueCommentsQuery = `
  query WorkIssueComments($owner: String!, $name: String!, $number: Int!, $last: Int!,
                          $before: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        comments(last: $last, before: $before) {
          pageInfo { hasPreviousPage startCursor }
          nodes { id body createdAt updatedAt author { login } }
        }
      }
    }
  }
`;

export const searchIssuesQuery = (fields: IssueFieldSet) => `
  query WorkIssueSearch($query: String!, $first: Int!, $after: String) {
    search(type: ISSUE, query: $query, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on Issue { ${summaryFields(fields)} repository { nameWithOwner } } }
    }
  }
`;

export const issueDetailQuery = (fields: IssueFieldSet) => `
  query WorkIssue($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        ${summaryFields(fields)}
        body
        ${
          fields === "full"
            ? `subIssues(first: 50) { nodes { number title state stateReason } }
        blocking(first: 50) { nodes { number } }`
            : ""
        }
        comments(last: 50) {
          totalCount
          nodes { id body createdAt updatedAt author { login } }
        }
      }
    }
  }
`;

/** Several issues by number in one request, one alias per issue. */
export const issueSnapshotsQuery = (fields: IssueFieldSet, numbers: ReadonlyArray<number>) => `
  query WorkIssueSnapshots($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${numbers.map((number) => `i${number}: issue(number: ${number}) { ${summaryFields(fields)} }`).join("\n")}
    }
  }
`;

export const assignableUsersQuery = `
  query WorkAssignable($owner: String!, $name: String!, $query: String) {
    repository(owner: $owner, name: $name) {
      assignableUsers(first: 20, query: $query) { nodes { login name } }
    }
  }
`;

/** Field names an older server rejects; any of them in an error means "use the basic set". */
export const OPTIONAL_FIELD_NAMES = [
  "parent",
  "issueDependenciesSummary",
  "blockedBy",
  "blocking",
  "subIssues",
] as const;
