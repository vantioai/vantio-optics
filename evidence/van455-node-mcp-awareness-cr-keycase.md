# VAN-455: Node MCP awareness, CR line ends and key letter case

Scope: `packages/vantio-cli/bin/mcp-awareness/` (parse, catalog, policy) and the
enforce line fallback in `packages/vantio-cli/bin/mcp-awareness-register.js`.

## Code commits

| Repo | Base (main) | Code commit |
| --- | --- | --- |
| vantio-optics | 8bee543191b52b637bc592c0df4865f16ec6bbf4 | d1cee62bec392994b560992074b9f359994248f2 |
| vantio-open-core | 1beaf365980d4b06cc2719f607dcf4ed40bf9bd0 | 115e3a4b3e38b1da6d2dad5b70fe0581eab91458 |

## Commands and return codes (optics worktree, at the code commit)

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | done |
| `pnpm --filter @vantio/cli run test` (before edits) | 0 | pass 179, fail 0, skipped 1 |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/cli run test` (after) | 0 | pass 205, fail 0, skipped 1 |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | pass 8, fail 0 |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | pass 42, fail 0 |
| `pnpm run test:python` | 0 | 128 tests OK, 2 skipped |
| `node --test test/*.test.js` (root) | 0 | pass 5, fail 0 |
| AGENTS.md secret scan | 0 | no pattern matched |
| `node --test packages/vantio-cli/test/mcp-awareness-cr-keycase.test.js` | 0 | pass 26, fail 0 |
| Same test file against main's library (scratch copy under /tmp) | 1 | pass 11, fail 15 |

## Commands and return codes (open-core worktree, at the code commit)

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | done |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | pass 205, fail 0, skipped 1 |
| `node --test packages/vantio-cli/test/mcp-awareness-cr-keycase.test.js` | 0 | pass 26, fail 0 |
| `node --test packages/vantio-mcp-awareness/test/*.test.js` | 0 | pass 36, fail 0 |
| `node packages/vantio-mcp-awareness/scripts/proof.mjs` | 0 | |
| `pnpm --filter @vantio/gate-mcp test` | 0 | pass 66, fail 0 |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | pass 42, fail 0 |

The CLI test `vendored library matches the package sources` failed (rc 1) until
the three changed files were also copied to `packages/vantio-mcp-awareness/src/`.
After that copy it passes.

## Probes (scratch, not committed)

- `vantio run --mcp-enforce node` with a `cat` child, 10 shapes (CR before a frame, two frames
  after CR, CRLF, CR CR, raw CR and escaped CR inside a JSON string, mixed-case keys, mixed-case
  with CR, ambiguous `method`/`Method`, exact case), policy default allow, default deny and no
  policy, whole write and 1-byte writes. New library: 60 runs, rc 0 each, no frame text reached
  `cat`. Main's library: 26 of 60 runs let the frame text reach `cat`.
- Observe, `cat` child, 1 MB random binary and 1 MB JSON with many CRs, 64 KB writes: sha256
  of input equals sha256 of output (test `observe with a cat child`).

## Gap list

- GitHub CI cannot run (org billing lock). Local runs above are the only validation.
- A line that ends at a lone CR in the last byte of a chunk is held until the next byte or the end
  of the stream if it is not plain text (so a CRLF is judged whole). A client that sends only
  `{frame}\r` and waits for an answer gets none until it sends more or closes. Plain-text lines
  are not held on the pair-gate path. The fallback line path holds every line that ends in a
  last-byte CR. Owner decision: keep the hold, or decide a lone CR at once and let a later LF pass.
- Not changed: SSE and HTTP framing (SSE also allows a lone CR as a line end), the observe-mode
  log splitter in `mcp-awareness-register.js` (it logs per LF; bytes are unchanged), and the
  Python gate.
- Key case: not folded for keys inside a server's `tools/list` results, keys in tool arguments
  (operator rule keys stay exact), or `jsonrpc`/`method` checks in `injection.js` for embedded
  frames. Folding follows ASCII case plus the long s (U+017F), the only non-ASCII fold for these
  names. Other lenient readers may fold differently.
- Both-case keys in `params` (`name` and `Name`) are withheld for every method, not only
  `tools/call`.
- A raw CR inside a JSON string splits the line. The first half is withheld as malformed JSON.
  The second half passes as non-JSON text, as any non-JSON line does.
- In enforce, an ambiguous object is reported as a `duplicate_key` GAP, not BLOCK.
- Drift script run against the open-core worktree lists
  `packages/vantio-optics-mcp/src/server.js` as different. This file is not part of this change.
- Open-core has no AGENTS.md secret scan. The optics scan, run on open-core, matches two
  tracked files that are on open-core main already
  (`tests/optics-evidence-contract/corpus.json`,
  `tests/optics-pkg02-unit-e/test_04_rollback.py`). Not touched here.
- Policy question for owners: should a lone-CR hold be time-bounded?
