# submission-check

Examines student submissions (Word, Excel, PDF, OpenDocument, RTF, plain text) for signs of
generated text, hidden content, fabricated references and overlap between submissions.

No dependencies, no install, no network unless you ask for it. Node 20+.

```bash
# a whole folder, with an HTML report
node tools/submission-check/cli.mjs ./submissions --html report.html

# drag-and-drop interface on localhost
node tools/submission-check/cli.mjs --serve

# one file, and check its references really exist
node tools/submission-check/cli.mjs essay.docx --verify-citations --email you@uni.edu
```

From the repo root: `npm run submissions -- ./submissions` and `npm run submissions:serve`.

---

## Read this before you use it on a student

**This tool cannot tell you whether a document was written by a person, and neither can anything
else.** What it can do is separate facts about the file from guesses about the prose, and show you
which is which.

The guesses are the dangerous part. Statistical style detection is measurably biased: a 2023
Stanford study found detectors classifying more than half of TOEFL essays by non-native English
speakers as machine-generated, while misclassifying almost none written by native speakers. Plain,
careful, formal writing looks like generated writing to every statistical measure that exists.
That is not a bug that gets fixed with a better threshold — it is what the measurements are.

So the tool is built to refuse the thing you might want from it. There is no percentage, no
"87% AI", no verdict. Findings are grouped by what kind of claim they are, style signals are
capped so they can never on their own push a submission past *worth a look*, and every finding
carries its innocent explanation alongside it.

Used well, it is a triage tool: it tells you which five of thirty submissions to read closely.
The thing that actually settles authorship is a conversation about process — ask for drafts, ask
what got cut and why, ask about a source they cited. That holds up. A report does not.

---

## What it checks

### Evidence — facts about the bytes

| Check | What it means |
| --- | --- |
| Assistant residue | "As an AI language model", "Certainly! Here is", "I hope this helps", unfilled `[Your Name]` placeholders |
| Hidden payloads | Messages decoded out of Unicode tag characters, variation selectors, or zero-width binary |
| Concealed text | White-on-white, 1pt, or explicitly hidden runs in a .docx — including prompt injection aimed at automated markers |
| Producing software | Metadata naming an AI service or a "humanising"/paraphrasing tool |

### Document history — circumstantial, but independent of writing style

This is the section that carries weight, because it does not care how well the student writes.

| Check | What it means |
| --- | --- |
| Editing time | Word records minutes-open. 3,000 words in 1 minute was pasted, not typed |
| Composition rate | Words per editing minute; flags above 90 wpm sustained |
| Editing sessions | Word's RSIDs give a lower bound on the number of sittings |
| Save count / timestamps | One save, or a file created and modified two minutes apart |
| Author mismatch | Created by one name, saved by another |
| Markdown residue | `**bold**` and `##` headings pasted into a word processor |
| Citations | Works cited but never listed, numbered citations past the end of the list, malformed DOIs, future publication years |
| Spreadsheets | A workbook of typed numbers with no formulas in it |

### Style — weak, biased, capped

Burstiness (sentence-length variation), MATTR vocabulary breadth, hapax ratio, word entropy,
paragraph uniformity, connective and hedging density, assistant-favoured vocabulary, and the
absence of ordinary typing imperfections. Reported with reference ranges, quoted in context, and
deliberately limited in how much they can move the overall picture. Skipped entirely below ~120
words, and excluded from scoring below 400.

### Across a batch

Upload the whole cohort at once and it also compares them to each other:

- **Overlap** — shared five-word sequences, Jaccard and containment, with the threshold computed
  from the batch (essays on one prompt share the prompt's vocabulary, so the baseline matters).
- **Shared metadata** — submissions from different students carrying the same Word author name,
  ignoring generic defaults like "Windows User".
- **Identical creation timestamps** — files descended from one copied original.

### Reference verification (opt-in)

`--verify-citations` looks each reference up against Crossref by DOI or title. Off by default
because it sends coursework metadata to a third party. A miss is not proof — Crossref does not
index every book, thesis or regional journal — but a DOI that does not resolve was invented.

---

## What it does *not* do

- **Cryptographic watermarks are not detected.** SynthID and green-list token biasing encode a
  signal in *which words were chosen*, recoverable only with the provider's key. No third-party
  tool reads them. A clean report is not evidence of human authorship.
- **Metadata can be stripped.** Its presence is informative; its absence proves nothing. Google
  Docs exports never carry an editing history at all, and the tool explicitly does not penalise
  them for it.
- **Vocabulary lists go stale.** They track how models wrote recently. Today's tells become
  tomorrow's ordinary academic English.
- **It cannot tell you where your line is.** Grammar checkers, translation tools and outlining
  help all leave traces resembling generation. Which of those your policy permits is your call.

---

## Privacy

`--serve` binds to `127.0.0.1` only. Files are analysed in memory, never written to disk, and
nothing leaves the machine unless you tick the Crossref box. `--json` output omits the extracted
text so a findings archive does not quietly become a copy of everyone's coursework.

## Exit codes

`0` nothing needing attention · `1` bad invocation · `2` at least one submission in the
*direct evidence* or *strong indicators* band — so it can gate a script.

## Tests

```bash
node --test "tools/submission-check/test/*.test.mjs"
```

Fixtures are real ZIP and PDF files built byte-by-byte in `test/helpers.mjs`, so the readers are
exercised against real archives rather than mocks.
