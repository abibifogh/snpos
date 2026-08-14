/**
 * Turning findings into something a marker can act on.
 *
 * The design constraint here matters more than the arithmetic. A single
 * percentage is what every commercial detector sells and it is the thing that
 * causes the damage: "94% AI" reads as a measurement, gets pasted into a
 * misconduct form, and a student then has to disprove a number that was never
 * a probability of anything. Stanford's 2023 work found detectors flagging
 * over half of TOEFL essays by non-native writers as machine-generated while
 * misclassifying almost none by native writers. That is the failure mode this
 * scoring is built to avoid.
 *
 * So: no percentage, and no verdict. Findings are grouped by what kind of
 * claim they are, evidence or inference, and the output is a recommended
 * action rather than a conclusion. Style can never on its own push a document
 * past "worth reading closely", because style alone does not justify more
 * than that.
 */

const WEIGHTS = { critical: 100, high: 25, medium: 10, low: 3, info: 0, none: 0 };

/**
 * Inference, not evidence. Capped in aggregate, because ten weak stylistic
 * signals are not one strong one; they are usually the same underlying trait,
 * a plain and formal writing voice, counted ten times.
 */
const INFERENCE_PREFIXES = ['style.', 'lex.vocabulary', 'lex.phrases', 'lex.transitions', 'lex.hedging',
  'lex.opener-pattern', 'lex.rule-of-three', 'lex.circular'];
const INFERENCE_CAP = 18;

export const BANDS = [
  {
    key: 'direct',
    label: 'Direct evidence',
    blurb: 'Something in this file could not have got there by writing it normally. Read the findings before acting; '
      + 'this is the one band where the document speaks for itself.',
    action: 'Raise it with the student, quoting the specific finding.',
  },
  {
    key: 'strong',
    label: 'Strong indicators',
    blurb: 'Several independent signals point the same way, including at least one that does not depend on writing style.',
    action: 'Worth a conversation. Ask about process: drafts, notes, where the argument came from.',
  },
  {
    key: 'moderate',
    label: 'Worth a look',
    blurb: 'Enough to be worth reading closely, not enough to mean anything on its own.',
    action: 'Read it alongside the student\'s previous work before deciding whether anything is here.',
  },
  {
    key: 'low',
    label: 'Little of note',
    blurb: 'Nothing here stands out.',
    action: 'No action indicated.',
  },
];

export function score(findings, { styleReliable = true } = {}) {
  const direct = [];
  const inference = [];
  const supporting = [];

  for (const f of findings) {
    if (f.severity === 'critical') direct.push(f);
    else if (INFERENCE_PREFIXES.some((p) => f.id?.startsWith(p))) inference.push(f);
    else supporting.push(f);
  }

  const supportingScore = supporting.reduce((a, f) => a + (WEIGHTS[f.severity] ?? 0), 0);
  const rawInference = inference.reduce((a, f) => a + (WEIGHTS[f.severity] ?? 0), 0);
  // On a short or badly-extracted document the style numbers are noise, so they
  // are discarded rather than discounted.
  const inferenceScore = styleReliable ? Math.min(rawInference, INFERENCE_CAP) : 0;

  const total = supportingScore + inferenceScore;

  // A single moderate finding about the file is worth a look, so the lower
  // threshold sits at exactly one of them. Saying "nothing stands out" directly
  // above a finding that was worth printing reads as a contradiction, and the
  // reader is right to trust the finding over the label.
  let band;
  if (direct.length) band = BANDS[0];
  else if (supportingScore >= 35) band = BANDS[1];
  else if (total >= WEIGHTS.medium) band = BANDS[2];
  else band = BANDS[3];

  return {
    band,
    total,
    breakdown: {
      direct: direct.length,
      supporting: supportingScore,
      inference: inferenceScore,
      inferenceUncapped: rawInference,
      inferenceCapped: styleReliable && rawInference > INFERENCE_CAP,
      styleDiscarded: !styleReliable && rawInference > 0,
    },
    groups: { direct, supporting, inference },
  };
}

/** Order findings so the strongest thing a reader sees first is the strongest thing there is. */
export function bySeverity(findings) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4, none: 5 };
  return [...findings].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

export const SEVERITY_LABEL = {
  critical: 'Direct evidence',
  high: 'Strong',
  medium: 'Moderate',
  low: 'Weak',
  info: 'Note',
  none: 'In favour',
};
