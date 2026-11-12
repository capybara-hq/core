# Report shape

`docs/reviews/YYYY-MM-DD-design-review.md`, English. The next review reads it, so ids and HEADs
must be exact.

```markdown
# Design review YYYY-MM-DD

- core HEAD: <sha>; plugins HEAD: <sha>
- previous review: <file or "none">
- lanes: <list>

## Themes

<2-6 root causes; each names the finding ids it explains and the one change that removes them.>

## Findings

### <id>: <one-line problem>

- status: new | recurring (<n>th time, first seen in <report file>) | regressed (fixed in <report file>)
- severity: high | medium | low  (on a change: "high (was medium: <reason>)")
- lens: design-flaw | drift | special-case-patch | over-engineering | gap | security | stale-dependency
- evidence: <file:line, commit hashes; verified by the reviewer>
- impact: <one sentence>
- fix: <concrete proposal>
- size: direct fix | needs a spec

<…ranked, most severe first; recurring findings rank by severity, then by count…>

## Fixed since the previous review

- <id>: <the code that shows it is fixed>

## Reasonable

- <thing>: <one-sentence reason it serves the goal>

## Baseline numbers

<the table from lanes.md, with the previous values beside the current ones when there are any>
```

## Finding ids

A kebab-case slug naming the problem, not the symptom's location: `post-commit-followups-no-outbox`,
`org-enablement-three-layers`, `oauth-discovery-bypasses-net`. Reuse the previous id when the same
problem holds, even if the file moved. A fixed id that comes back is `regressed`, same id.
