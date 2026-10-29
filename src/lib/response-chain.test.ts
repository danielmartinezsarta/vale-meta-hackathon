import { describe, expect, it } from "vitest";
import {
  chainFailed,
  chainSucceeded,
  nextPreviousResponseId,
} from "./response-chain";

describe("response chain", () => {
  it("hands the last successful turn to the next one", () => {
    chainFailed();
    chainSucceeded("resp_1");
    expect(nextPreviousResponseId()).toBe("resp_1");
  });

  it("drops the chain after a failed turn", () => {
    chainSucceeded("resp_1");
    chainFailed();
    expect(nextPreviousResponseId()).toBeUndefined();
  });

  it("drops the chain on an empty success id", () => {
    chainSucceeded("resp_1");
    chainSucceeded("");
    expect(nextPreviousResponseId()).toBeUndefined();
  });
});
