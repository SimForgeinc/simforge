import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EDITOR_EXPERIENCE_STORAGE_KEY,
  readEditorExperience,
} from "./simple-timed-routes";

describe("Simple editor experience", () => {
  it("defaults a fresh session to Simple and preserves an Advanced choice", () => {
    assert.equal(readEditorExperience({ getItem: () => null }), "simple");
    assert.equal(readEditorExperience({
      getItem: (key) => key === EDITOR_EXPERIENCE_STORAGE_KEY ? "advanced" : null,
    }), "advanced");
  });
});
