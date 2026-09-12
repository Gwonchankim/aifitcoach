/** PROGRAM_V2_CONTRACT §1.2: the same fixtures exercise shared and Dexie boundaries. */
export const recommendationStateFixtures = [
  {
    name: "v1-external-baseline",
    input: { reason: "BASELINE", weight: 0, load_kind: "external" },
    expected: "load_calibration_needed",
  },
  {
    name: "bodyweight-baseline",
    input: { reason: "BASELINE", weight: null, load_kind: "bodyweight" },
    expected: "ready",
  },
  {
    name: "time-baseline",
    input: { reason: "BASELINE", weight: null, load_kind: "not_applicable" },
    expected: "ready",
  },
  {
    name: "weighted-history",
    input: { reason: "ADD_ONE_REP", weight: 60, load_kind: "external" },
    expected: "ready",
  },
  {
    name: "pain",
    input: { reason: "SUBSTITUTE_PAIN", weight: 60, load_kind: "external" },
    expected: "substitution_required",
  },
  {
    name: "invalid",
    input: { reason: "INVALID_INPUT", weight: null, load_kind: "external" },
    expected: "unavailable",
  },
  {
    name: "metadata-missing",
    input: { reason: "BASELINE", weight: null },
    expected: "unavailable",
  },
  {
    name: "reason-pain-over-ready",
    input: { state: "ready", reason: "SUBSTITUTE_PAIN", weight: 60, load_kind: "external" },
    expected: "substitution_required",
  },
  {
    name: "reason-invalid-over-ready",
    input: { state: "ready", reason: "INVALID_INPUT", weight: 60, load_kind: "external" },
    expected: "unavailable",
  },
  {
    name: "state-pain-over-benign",
    input: {
      state: "substitution_required",
      reason: "BASELINE",
      weight: 60,
      load_kind: "external",
    },
    expected: "substitution_required",
  },
  {
    name: "state-unavailable-over-benign",
    input: { state: "unavailable", reason: "BASELINE", weight: 60, load_kind: "external" },
    expected: "unavailable",
  },
  {
    name: "state-calibration-over-benign",
    input: {
      state: "load_calibration_needed",
      reason: "BASELINE",
      weight: 60,
      load_kind: "external",
    },
    expected: "load_calibration_needed",
  },
  {
    name: "unknown-benign-reason",
    input: { state: "ready", reason: "SIMILAR_INIT", weight: 60, load_kind: "external" },
    expected: "ready",
  },
] as const;
