import path from "node:path"

/** Remove only standalone PATH entries written by this product's installer. */
export function cleanShellConfig(content: string, input: { bins: readonly string[]; home: string; product: string }) {
  const directories = input.bins.flatMap((bin) => {
    const relative = path.relative(input.home, bin)
    const suffix = relative.split(path.sep).join("/")
    return [
      bin,
      ...(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        ? [`~/${suffix}`, `$HOME/${suffix}`, `\${HOME}/${suffix}`]
        : []),
    ]
  })
  const entries = new Set(
    directories.flatMap((directory) => [
      `export PATH="${directory}:$PATH"`,
      `export PATH=${directory}:$PATH`,
      `fish_add_path "${directory}"`,
      `fish_add_path ${directory}`,
    ]),
  )
  const lines = content.split("\n")
  return lines
    .filter(
      (line, index) =>
        !entries.has(line.trim()) &&
        !(
          line.trim().toLowerCase() === `# ${input.product.toLowerCase()}` &&
          entries.has(lines[index + 1]?.trim() ?? "")
        ),
    )
    .join("\n")
}
