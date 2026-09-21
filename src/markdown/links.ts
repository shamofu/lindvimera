import { indexMarkdown } from "./ranges";

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function markdownDestination(value: string): string | undefined {
  value = value.trim();
  if (value.startsWith("<")) {
    const match = /^<((?:\\.|[^>\n])*)>(?:\s+["'(][\s\S]*["')])?$/.exec(value);
    return match?.[1];
  }
  // A title is separate from the destination. Escaped spaces belong to the path.
  return /^(?:\\.|[^\s])+/.exec(value)?.[0];
}

/** Resolve the link under the cursor from the current editing text, including unsaved edits. */
export function internalLinkAt(text: string, offset: number): string | undefined {
  const link = indexMarkdown(text).objects.find(
    (object) =>
      object.kind === "l" &&
      offset >= object.from - (text[object.from - 1] === "!" ? 1 : 0) &&
      offset < object.to,
  );
  if (!link) return;
  let target: string | undefined;
  const wiki = text.startsWith("[[", link.from);
  if (wiki) {
    const contents = text.slice(link.inner.from, link.inner.to);
    target = /^(?:\\.|[^|])*/.exec(contents)?.[0];
  } else if (link.alternateInner) {
    target = markdownDestination(text.slice(link.alternateInner.from, link.alternateInner.to));
  }
  if (target === undefined) return;
  target = unescapeMarkdown(target).trim();
  if (!wiki) {
    try {
      target = decodeURIComponent(target);
    } catch {
      // A literal percent in a note name does not make its link unusable.
    }
  }
  if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) return;
  return target;
}
