import { describe, expect, it } from "vitest";
import {
  chainFailed,
  chainSucceeded,
  nextPreviousResponseId,
} from "./response-chain";

describe("response chain", () => {
  it("hands the last successful turn to the next one", () => {
    chainFailed();
    chainSucceeded("resp_1", true);
    expect(nextPreviousResponseId()).toBe("resp_1");
  });

  it("drops the chain after a failed turn", () => {
    chainSucceeded("resp_1", true);
    chainFailed();
    expect(nextPreviousResponseId()).toBeUndefined();
  });

  it("drops the chain after a completed write", () => {
    chainFailed();
    chainSucceeded("resp_1", false);
    expect(nextPreviousResponseId()).toBeUndefined();
  });

  it("restarts the chain after the cap", () => {
    chainFailed();
    chainSucceeded("resp_1", true);
    chainSucceeded("resp_2", true);
    chainSucceeded("resp_3", true);
    chainSucceeded("resp_4", true);
    expect(nextPreviousResponseId()).toBeUndefined();
    chainSucceeded("resp_5", true);
    expect(nextPreviousResponseId()).toBe("resp_5");
  });

  it("drops the chain on an empty success id", () => {
    chainSucceeded("resp_1", true);
    chainSucceeded("", true);
    expect(nextPreviousResponseId()).toBeUndefined();
  });

  it("keeps one lane per client key", () => {
    chainSucceeded("resp_a", true, "client-a");
    chainSucceeded("resp_b", true, "client-b");
    expect(nextPreviousResponseId("client-a")).toBe("resp_a");
    expect(nextPreviousResponseId("client-b")).toBe("resp_b");
    chainFailed("client-a");
    expect(nextPreviousResponseId("client-a")).toBeUndefined();
    expect(nextPreviousResponseId("client-b")).toBe("resp_b");
    chainFailed("client-b");
  });
});
