export const PARAGRAPH_SPACE_BELOW_PT = 8;
export const BLOCKQUOTE_INDENT_PT = 36;

export function paragraphFormatting(block) {
  const blockquoteIndent = block.blockquote ? BLOCKQUOTE_INDENT_PT : 0;
  return {
    spaceBelow: block.paragraphSpaceBelow ?? 0,
    indentStart: blockquoteIndent,
    indentFirstLine: blockquoteIndent,
  };
}

export function hasBlockquoteIndent(block) {
  return block.paragraphIndentStart === BLOCKQUOTE_INDENT_PT &&
    block.paragraphIndentFirstLine === BLOCKQUOTE_INDENT_PT;
}
