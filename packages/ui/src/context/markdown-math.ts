import katex from "katex"

function fences(markdown: string) {
  const result: [number, number][] = []
  const pattern = /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/
  let offset = 0

  while (offset < markdown.length) {
    const newline = markdown.indexOf("\n", offset)
    const end = newline === -1 ? markdown.length : newline + 1
    const line = markdown.slice(offset, newline === -1 ? end : newline).replace(/\r$/, "")
    const match = line.match(pattern)
    if (!match || (match[1][0] === "`" && match[2].includes("`"))) {
      offset = end
      continue
    }

    const marker = match[1]
    let cursor = end
    while (cursor < markdown.length) {
      const next = markdown.indexOf("\n", cursor)
      const finish = next === -1 ? markdown.length : next + 1
      const row = markdown.slice(cursor, next === -1 ? finish : next).replace(/\r$/, "")
      const closing = row.match(pattern)
      cursor = finish
      if (!closing) continue
      if (closing[1][0] !== marker[0] || closing[1].length < marker.length || closing[2].trim()) continue
      break
    }

    result.push([offset, cursor])
    offset = cursor
  }

  return result
}

function spans(markdown: string, start: number, end: number) {
  const result: [number, number][] = []
  let offset = start

  while (offset < end) {
    if (markdown[offset] !== "`") {
      offset++
      continue
    }

    let escaped = 0
    while (offset - escaped - 1 >= start && markdown[offset - escaped - 1] === "\\") escaped++
    if (escaped % 2) {
      offset++
      continue
    }

    let size = 1
    while (markdown[offset + size] === "`") size++
    let cursor = offset + size
    let close = -1

    while (cursor < end) {
      const next = markdown.indexOf("`", cursor)
      if (next === -1 || next >= end) break
      let count = 1
      while (markdown[next + count] === "`") count++
      if (count === size) {
        close = next + count
        break
      }
      cursor = next + count
    }

    if (close === -1) {
      offset += size
      continue
    }

    result.push([offset, close])
    offset = close
  }

  return result
}

function ranges(markdown: string) {
  const blocks = fences(markdown)
  const result: [number, number][] = []
  let offset = 0

  for (const block of blocks) {
    result.push(...spans(markdown, offset, block[0]), block)
    offset = block[1]
  }
  result.push(...spans(markdown, offset, markdown.length))
  return result
}

function normalize(math: string) {
  const names = [
    "sqrt",
    "widetilde",
    "widehat",
    "nabla",
    "theta",
    "eta",
    "xi",
    "pi",
    "log",
    "mid",
    "le",
    "leq",
    "operatorname",
    "mathrm",
    "langle",
    "rangle",
  ]
  return math.replace(new RegExp(`(^|[^\\\\A-Za-z])(${names.join("|")})(?=[^A-Za-z]|$)`, "g"), "$1\\$2")
}

export function preprocess(markdown: string) {
  const blocks = new Map<string, string>()
  const patterns = [
    { regex: /\\\\\(\s*([\s\S]*?)\s*\\\\\)/g, display: false },
    { regex: /\\\\\[\s*([\s\S]*?)\s*\\\\\]/g, display: true },
    { regex: /\\\(\s*([\s\S]*?)\s*\\\)/g, display: false },
    { regex: /\\\[\s*([\s\S]*?)\s*\\\]/g, display: true },
    { regex: /\$\$([\s\S]*?)\$\$/g, display: true },
    { regex: /(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+?)\$(?!\$)/g, display: false },
  ]
  let count = 0

  const prose = (value: string) => {
    let result = value
    for (const pattern of patterns) {
      result = result.replace(pattern.regex, (_, math) => {
        let key = `MATHPLACEHOLDER${count++}END`
        while (markdown.includes(key)) key = `MATHPLACEHOLDER${count++}END`
        const source = normalize(math)
        try {
          blocks.set(key, katex.renderToString(source, { displayMode: pattern.display, throwOnError: false }))
        } catch {
          blocks.set(key, pattern.display ? `$$${source}$$` : `$${source}$`)
        }
        return key
      })
    }
    return result
  }

  let text = ""
  let offset = 0
  for (const range of ranges(markdown)) {
    text += prose(markdown.slice(offset, range[0]))
    text += markdown.slice(range[0], range[1])
    offset = range[1]
  }
  text += prose(markdown.slice(offset))

  return { text, mathBlocks: blocks }
}
