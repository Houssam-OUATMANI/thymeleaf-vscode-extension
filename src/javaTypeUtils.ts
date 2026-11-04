export function parseJavaVariableTypeFromHover(
  contents: readonly string[],
  variableName: string
): string | undefined {
  const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarationPattern = new RegExp(
    `(?:^|\\s)([\\w.$]+(?:\\s*<[^\\n;=]+>)?(?:\\[\\])*)\\s+${escapedName}\\b`
  );

  for (const content of contents) {
    const codeBlocks = [...content.matchAll(/```(?:[\w+-]+)?\s*([\s\S]*?)```/g)]
      .map(([, block]) => block ?? "");
    const lines = (codeBlocks.length > 0 ? codeBlocks : [content])
      .flatMap((block) => block.split(/\r?\n/));
    for (const line of lines) {
      const typeName = declarationPattern.exec(line.trim())?.[1];
      if (typeName) return typeName.replace(/\s+/g, "");
    }
  }
  return undefined;
}
