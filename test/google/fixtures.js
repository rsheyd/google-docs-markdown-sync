export function paragraph(startIndex, text, namedStyleType = "NORMAL_TEXT") {
  return {
    startIndex,
    endIndex: startIndex + text.length,
    paragraph: {
      elements: [
        {
          startIndex,
          endIndex: startIndex + text.length,
          textRun: { content: text, textStyle: {} },
        },
      ],
      paragraphStyle: { namedStyleType },
    },
  };
}


export function bulletParagraph(startIndex, text, listId = "bullets") {
  const element = paragraph(startIndex, text);
  element.paragraph.bullet = { listId, nestingLevel: 0 };
  return element;
}


export function imageParagraph(startIndex, objectId = "image-1") {
  return {
    startIndex,
    endIndex: startIndex + 2,
    paragraph: {
      elements: [
        {
          startIndex,
          endIndex: startIndex + 1,
          inlineObjectElement: { inlineObjectId: objectId },
        },
        {
          startIndex: startIndex + 1,
          endIndex: startIndex + 2,
          textRun: { content: "\n", textStyle: {} },
        },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    },
  };
}

