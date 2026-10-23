/**
 * GraphQL documents for GitHub Issues. Lists use the repository's issue connection, whose
 * cursor is stable, never returns pull requests and is accounted under the graphql quota; text
 * search uses the search connection for the same reasons (REST `search/issues` would be charged
 * to the wrong quota resource). Nested connections stay at 50 or fewer, which bounds their cost.
 *
 * The `full` fragments read sub-issue and dependency fields that older GitHub Enterprise Server
 * releases do not have; the `basic` ones leave them out and are used after such a server refuses.
 */

const SUMMARY_BASIC = `
  id number title state stateReason url updatedAt
  labels(first: 32) { nodes { name } }
  assignees(first: 5) { nodes { login name } }
`;

const SUMMARY_FULL = `${SUMMARY_BASIC}
  parent { number }
  issueDependenciesSummary { totalBlockedBy }
  blockedBy(first: 50) { nodes { number state } }
`;

export type IssueFieldSet = "full" | "basic";

export const summaryFields = (fields: IssueFieldSet) =>
  fields === "full" ? SUMMARY_FULL : SUMMARY_BASIC;

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

export const searchIssuesQuery = (fields: IssueFieldSet) => `
  query WorkIssueSearch($query: String!, $first: Int!, $after: String) {
    search(type: ISSUE, query: $query, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on Issue { ${summaryFields(fields)} } }
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
