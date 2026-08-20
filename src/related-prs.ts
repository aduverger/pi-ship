const RELATED_START = "<!-- pi-ship-related-start -->";
const RELATED_END = "<!-- pi-ship-related-end -->";

export function withRelatedPullRequests(body: string, links: ReadonlyMap<string, string>, currentRepository: string): string {
  const withoutExisting = body
    .replace(new RegExp(`\\n?${RELATED_START}[\\s\\S]*?${RELATED_END}\\n?`, "g"), "\n")
    .trimEnd();
  const related = [...links.entries()].filter(([repository]) => repository !== currentRepository);
  if (related.length === 0) return withoutExisting;

  const items = related.map(([repository, url]) => `- [${repository}](${url})`).join("\n");
  return `${withoutExisting}\n\n${RELATED_START}\n## Related pull requests\n\n${items}\n${RELATED_END}`;
}
