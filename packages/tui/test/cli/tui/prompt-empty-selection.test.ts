import { describe, expect, test } from "bun:test"
import { emptyRows } from "../../../src/component/prompt/empty-selection"

describe("prompt empty selection", () => {
  test("returns selected empty rows in viewport", () => {
    expect(
      emptyRows(
        "one\n\nthree",
        { start: 0, end: 5 },
        {
          lineSources: [0, 1, 2],
          lineWidthCols: [3, 0, 5],
        },
        0,
        3,
      ),
    ).toEqual([1])
  })

  test("ignores empty rows outside the selection", () => {
    expect(
      emptyRows(
        "one\n\nthree",
        { start: 0, end: 4 },
        {
          lineSources: [0, 1, 2],
          lineWidthCols: [3, 0, 5],
        },
        0,
        3,
      ),
    ).toEqual([])
  })

  test("maps rows relative to scroll", () => {
    expect(
      emptyRows(
        "one\n\nthree\n\nfive",
        { start: 0, end: 11 },
        {
          lineSources: [0, 1, 2, 3, 4],
          lineWidthCols: [3, 0, 5, 0, 4],
        },
        1,
        3,
      ),
    ).toEqual([0])
  })
})
