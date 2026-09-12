import { ASSISTED_EXERCISE_IDS, isAssistedExercise } from "shared";
import catalog from "../../../docs/specs/exercises_seed.json";
import {
  ASSISTED_EXERCISE_IDS as API_ASSISTED_EXERCISE_IDS,
  loadSemanticsFor,
} from "../src/programs/assistance-migration";

describe("canonical assisted exercise IDs parity", () => {
  it("keeps the protected API list equal to shared, including order", () => {
    expect(API_ASSISTED_EXERCISE_IDS).toEqual(ASSISTED_EXERCISE_IDS);
  });

  it("keeps load semantics equal for all 110 seed IDs and an unknown ID", () => {
    expect(catalog.exercises).toHaveLength(110);
    const unknownId = "unknown_assisted_parity";
    const ids = catalog.exercises.map((exercise) => exercise.id);
    expect(ids).not.toContain(unknownId);
    for (const id of [...ids, unknownId]) {
      expect(loadSemanticsFor(id)).toBe(isAssistedExercise(id) ? "assistance" : "external_load");
    }
  });
});
