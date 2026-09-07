import { describe, expect, test } from "bun:test"

import { preprocess } from "./markdown-math"

describe("markdown math preprocessing", () => {
  test("renders prose math without consuming inline code", () => {
    const source = "Formula $x$ uses `$ROOT`, then ``echo `$CACHE` and $OUT`` before $y$."
    const result = preprocess(source)

    expect(result.mathBlocks.size).toBe(2)
    expect(result.text).toContain("`$ROOT`")
    expect(result.text).toContain("``echo `$CACHE` and $OUT``")
    expect(result.text).not.toContain("$x$")
    expect(result.text).not.toContain("$y$")
  })

  test("preserves shell variables in backtick and tilde fences", () => {
    const source = [
      "Before $x$.",
      "```bash",
      "CODE=$ROOT/GIGPO",
      "ENV=$ROOT/envs/runtime",
      "```",
      "~~~text",
      "$CACHE and $OUT",
      "~~~",
      "After $y$.",
    ].join("\n")
    const result = preprocess(source)

    expect(result.mathBlocks.size).toBe(2)
    expect(result.text).toContain("CODE=$ROOT/GIGPO\nENV=$ROOT/envs/runtime")
    expect(result.text).toContain("$CACHE and $OUT")
  })

  test("supports long, quoted, and CRLF fences", () => {
    const source = [
      "Math $$x + y$$.",
      "> ````text",
      "> ``` $ROOT $OUT",
      "> ````",
      "After $z$.",
    ].join("\r\n")
    const result = preprocess(source)

    expect(result.mathBlocks.size).toBe(2)
    expect(result.text).toContain("> ``` $ROOT $OUT")
  })

  test("protects an unclosed fence through the end of input", () => {
    const source = ["Before $x$.", "```bash", "echo $ROOT", "echo $OUT", "not math $y$"].join("\n")
    const result = preprocess(source)

    expect(result.mathBlocks.size).toBe(1)
    expect(result.text).toContain("echo $ROOT\necho $OUT\nnot math $y$")
  })

  test("does not overwrite a literal math placeholder", () => {
    const result = preprocess("MATHPLACEHOLDER0END and $x$")

    expect(result.text).toContain("MATHPLACEHOLDER0END")
    expect(result.text).toContain("MATHPLACEHOLDER1END")
    expect(result.mathBlocks.has("MATHPLACEHOLDER1END")).toBe(true)
  })
})
