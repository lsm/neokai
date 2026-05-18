# I Improved 15 LLMs at Coding in One Afternoon. Only the Harness Changed.

**Author:** Can Bölük  
**Date:** Feb 12, 2026  
**Source:** https://blog.can.ac/2026/02/12/the-harness-problem/

## 0x0: The Wrong Question

The article argues that coding-model comparisons focus too much on which model is best, while the **harness** is a major hidden variable.

Key points:
- The harness shapes the user’s first impression.
- It also supplies input tokens and mediates every workspace change.
- The author maintains **oh-my-pi**, a fork of **Pi** by Mario Zechner.
- The author emphasizes that many failures come from tool schemas, error handling, and state management rather than the model itself.
- They criticize Claude Code for leaking raw JSONL from sub-agent outputs and prefer structured sub-agent output.

## 0x1: Edit Tool!

The post compares common edit strategies:

### Codex-style `apply_patch`
- Uses a diff-like string rather than a structured schema.
- Works well when the model has been shaped for that format.
- Fails badly when other models are asked to generate it.
- Reported patch failure rates:
  - **Grok 4:** 50.7%
  - **GLM-4.7:** 46.2%

### Claude Code / many others: `str_replace`
- Finds exact old text and replaces it with new text.
- Requires exact character reproduction, including whitespace/indentation.
- Multiple matches are rejected.
- The author notes that “String to replace not found in file” is a common failure mode.

### Cursor’s approach
- Uses a separate fine-tuned **70B** model to merge edits into files.
- Cursor’s own blog reportedly notes that fully rewriting a file can outperform aider-like diffs for files under 400 lines.

### Aider benchmark results
- Format alone moved **GPT-4 Turbo** from **26% to 59%**.
- **GPT-3.5** still scored only **19%** with the same format.
- Conclusion: the edit format can matter as much as the model.

### External benchmarks
- **Diff-XYZ** (JetBrains) found no single edit format dominates across models and tasks.
- **EDIT-Bench** found only one model above **60% pass@1** on realistic editing tasks.

Main thesis of this section:
- Existing tools do not give the model a stable, verifiable line identifier.
- They force the model to reproduce text it already saw, which often fails.

## 0x2: Hashline!

Proposed idea:
- When a file is read or grepped, each line gets a short content hash tag.
- Example format:
  - `11:a3|function hello() {`
  - `22:f1|  return "world";`
  - `33:0e|}`
- Edits would reference those tags, e.g.:
  - replace line `2:f1`
  - replace range `1:a3` through `3:0e`
  - insert after `3:0e`

Benefits claimed:
- If the file changes after reading, hashes should no longer match, so the edit can be rejected before corruption.
- The model would not need to perfectly reproduce prior text or whitespace.
- Stable tags provide a trusted anchor for edits.

## 0x3: The Benchmark

Benchmark setup:
1. Random file selected from the React codebase.
2. Mutations introduced as bugs using invertible edits:
   - operator swaps
   - boolean flips
   - off-by-one errors
   - removed optional chains
   - renamed identifiers
3. A plain-English bug description is generated.

Example task:
- Fix a bug in `useCommitFilteringAndNavigation.js`.
- A guard clause / early return was removed.
- Restore the missing guard clause.

Evaluation details:
- Not every solution must match exactly, since a model may fix the issue differently.
- But the bugs are mechanical enough that the intended fix is usually the reversal of the mutation.
- Setup:
  - **3 runs per task**
  - **180 tasks per run**
  - fresh agent session each time
  - four tools: read, edit, write
  - temporary workspace
  - compare before/after formatting against the original file

Headline result:
- Across **16 models** and **3 edit tools**:
  - **patch** is worst for nearly every model
  - **hashline** matches or beats replace for most models
  - weaker models improve the most

Specific results mentioned:
- **Grok Code Fast 1** improved from **6.7% to 68.3%**
- **MiniMax** more than doubled
- **Grok 4 Fast** output tokens dropped **61%** because retry loops were reduced

## 0x4: So What?

Main takeaway:
- A modest improvement in Gemini’s success rate, about **+8%**, can exceed what many model upgrades achieve.
- The improvement required **zero training compute**.
- The author spent about **$300** benchmarking.

Interpretation:
- Models are often blamed for failures that are actually expression/tooling failures.
- Analogy: blaming the pilot when the landing gear is the issue.

## 0x5: Little Bit About the Vendors

The post criticizes vendor behavior around harnesses and access:

- Anthropic blocked **OpenCode**, an open-source coding agent, from using Claude through Claude Code subscriptions.
- Anthropic’s stated reason: OpenCode reverse-engineered a private API.
- The author interprets the message as: don’t build harnesses; use the vendor’s.

Google-related claim:
- While writing the article, the author says Google disabled their Gemini account.
- It was not rate-limited or warned; it was **disabled**.
- They attribute this to running a benchmark.
- They note the benchmark found **Gemini 3 Flash** reached **78.3%** using a novel technique, beating Google’s best attempt by **5.0 percentage points**.

Broader argument:
- Harness improvements benefit even competing models.
- Open-source harnesses can be tuned by many contributors across many model families.
- Vendors are unlikely to optimize their harnesses for rivals’ models.
- Conclusion: the harness is a bridge; the model is the moat.

## Closing argument

The article compares this to game security:
- Cheaters damage the ecosystem.
- Over time, security teams often recruit the people who figured out the bypasses.
- The author argues the right response to people probing APIs and building popular tools is to learn from them, not broadly ban them.

Final claim:
- The harness problem is measurable and high-leverage.
- The gap between a demo and a reliable tool is mostly empirical engineering at the tool boundary.
- The question is whether harnesses get solved privately for one model or openly for all models.

## Sources / links mentioned

- oh-my-pi: `https://github.com/can1357/oh-my-pi`
- Pi: `https://github.com/badlogic/pi-mono`
- Claude Code issue megathread: `https://github.com/anthropics/claude-code/issues/3471`
- Cursor instant apply blog: `https://cursor.com/blog/instant-apply`
- Aider benchmarks: `https://aider.chat/docs/benchmarks.html`
- Diff-XYZ: `https://arxiv.org/abs/2510.12487`
- EDIT-Bench: `https://arxiv.org/abs/2511.04486`
- OpenCode discussion: `https://news.ycombinator.com/item?id=46625918`
- Cross-post source: `https://x.com/_can1357/status/2021828033640911196`
