# Contributing

Thanks for your interest. This project is run with a small-maintainer model:
**issues are very welcome; pull requests are accepted by discussion first.**

## How to contribute

1. **Open an issue** describing the bug, gap, or idea before writing code.
   For anything non-trivial, let's agree on the approach in the issue first —
   it saves you from a PR that doesn't fit the design.
2. **Keep changes focused.** One concern per PR. Match the surrounding style.
3. **Tests + types must stay green.** `npm test` and `npm run typecheck` both
   pass before you push. New behavior comes with a test.
4. **No new dependencies** without discussion — the engine deliberately uses
   direct `fetch()` over SDKs and keeps its dependency surface tiny.

## Developer Certificate of Origin (DCO)

Contributions are accepted under the [DCO](https://developercertificate.org/).
Sign off every commit (`git commit -s`), which adds:

```
Signed-off-by: Your Name <your.email@example.com>
```

This certifies you have the right to submit the contribution under the
project's license.

## License

By contributing, you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE).

## Scope

This repository is the **open-core engine**: ingestion, hybrid retrieval, and
cited answers over your own corpus. Features that profile, recommend, or
otherwise build an insight layer on top of the corpus are intentionally out of
scope here. Bug fixes, retrieval-quality improvements, new ingest source types,
docs, and portability fixes are all in scope and appreciated.
